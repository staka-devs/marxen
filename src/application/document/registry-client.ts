import { sameLocation, sameRoot } from "../../domain/document-location";
import { LocalizedError } from "../../domain/localized-error";
// Revision-aware document use cases over an injected transport (application).
//
// Serial per-document queues against the real Neovim buffer, which stays the
// only authority: Vim key input, GUI range edits, undo/redo, save, and
// configure never interleave for one document. Stale revisions re-read the
// fresh snapshot and surface it; no frontend history is kept and no revision
// is ever minted locally. The raw Tauri transport arrives through
// `DocumentTransport` in the constructor, so this module never touches Tauri,
// DOM, React, or browser globals and never pulls a concrete singleton.
//
// When the transport is absent the read-only variant rejects every mutation
// with the shared message and never simulates a save.

import type {
  CursorUpdate,
  EditorContext,
  DocumentId,
  DocumentSnapshot,
  DocumentLocation,
  GridUpdate,
  ModeUpdate,
  NvimConfig,
  OpenDocument,
  SaveRequest,
  TextEdit,
  Utf16Range,
  VimInputResult,
  YankCopy,
} from "../../contracts/contracts";
import { isStaleError, READONLY_MESSAGE, StaleResync } from "../../domain/document-errors";
import { applyTextEdits } from "../../domain/coordinates/utf16";
import { adjacentTableCell, formatRange, hardBreakSpaces, type FormatKind } from "../../domain/markdown-gui";
import type { DocumentTransport, EditorAction } from "../ports";
import { supportsEditorSelection } from "../../domain/editor-menu";

/** Paste-image arguments pairing a save request with bytes and a range. */
export interface PasteImageArgs {
  request: SaveRequest;
  name: string;
  bytes: Uint8Array;
  range: Utf16Range;
}

/**
 * Registry-backed document use cases with per-document serial queues.
 *
 * One instance per shell; the client tracks the latest acknowledged revision
 * per document so queued tasks build requests at execution time, never at
 * event time. Insert-mode mapping prefixes stay queue-owned so multi-key
 * mappings keep priority.
 */
export class RegistryClient {
  private locations = new Map<DocumentId, DocumentLocation>();
  private executingLocations = new Map<DocumentId, DocumentLocation>();
  private queues = new Map<DocumentId, Promise<unknown>>();
  private rev = new Map<DocumentId, number>();
  private source = new Map<DocumentId, string>();
  private cursorStaged = new Map<DocumentId, Array<{ anchor: number; head: number }>>();
  /** Insert-mode mapping prefix per document, owned inside the serial queue. */
  private pendingPrefix = new Map<DocumentId, string>();

  /**
   * Create a registry bound to a raw document transport.
   *
   * The transport performs one native command per method; this client adds
   * serialization, execution-time revision binding, and stale resync.
   */
  constructor(private transport: DocumentTransport) {}

  private pendingCommands = new Map<DocumentId, string[]>();

  /** Retain native actions observed by routing until presentation consumes them. */
  private async readMode(documentId: DocumentId): Promise<ModeUpdate> {
    const update = await this.transport.fetchMode(documentId, this.location(documentId));
    if (update.commands?.length) this.pendingCommands.set(documentId, [...(this.pendingCommands.get(documentId) ?? []), ...update.commands]);
    return update;
  }

  /** Select the complete native source in queue order without replaying a stale gesture. */
  selectAll(expected: EditorContext): Promise<CursorUpdate> {
    const cursor = expected.cursor;
    return this.enqueue(cursor.documentId, async () => {
      if (this.rev.get(cursor.documentId) !== cursor.revision) return this.resync(cursor.documentId);
      try {
        const context = await this.transport.fetchEditorContext(this.request(cursor.documentId, cursor.revision));
        if (context.cursor.revision !== cursor.revision || context.cursor.anchor !== cursor.anchor || context.cursor.head !== cursor.head || context.mode !== expected.mode || !supportsEditorSelection(context.mode)) throw new LocalizedError("選択またはVimモードが変わりました。操作し直してください。");
        const text = this.source.get(cursor.documentId);
        if (text === undefined) return this.resync(cursor.documentId);
        return await this.transport.reportCursor({ documentId: cursor.documentId, revision: cursor.revision, anchor: 0, head: text.length }, this.location(cursor.documentId));
      } catch (cause) { if (isStaleError(cause)) return this.resync(cursor.documentId); throw cause; }
    });
  }

  /** Format a captured native selection with actor-side selection guards and an ordered caret report. */
  formatEditorSelection(cursor: CursorUpdate, beforeText: string, kind: FormatKind): Promise<DocumentSnapshot> {
    return this.enqueue(cursor.documentId, async () => {
      if (this.rev.get(cursor.documentId) !== cursor.revision || this.source.get(cursor.documentId) !== beforeText) return this.resync(cursor.documentId);
      try {
        const edits = formatRange(beforeText, Math.min(cursor.anchor, cursor.head), Math.max(cursor.anchor, cursor.head), kind);
        const snapshot = this.bump(await this.transport.applyEdits(this.request(cursor.documentId, cursor.revision), edits, cursor));
        if (snapshot.text !== applyTextEdits(beforeText, edits)) throw new StaleResync(snapshot);
        const head = edits[0].range.start + edits[0].text.length;
        await this.transport.reportCursor({ documentId: cursor.documentId, revision: snapshot.revision, anchor: head, head }, this.location(cursor.documentId));
        return snapshot;
      } catch (cause) { if (isStaleError(cause)) return this.resync(cursor.documentId); throw cause; }
    });
  }

  /** Capture native menu data after earlier edits and cursor reports finish. */
  fetchEditorContext(documentId: DocumentId): Promise<EditorContext> {
    return this.enqueue(documentId, async () => {
      try {
        const revision = this.rev.get(documentId) ?? 0;
        const context = await this.transport.fetchEditorContext(this.request(documentId, revision));
        if (context.cursor.revision !== revision) return this.resync(documentId);
        return context;
      } catch (cause) { if (isStaleError(cause)) return this.resync(documentId); throw cause; }
    });
  }

  /** Reject stale menu actions and execute native history or guarded clipboard operations. */
  editorAction(cursor: CursorUpdate, action: EditorAction): Promise<DocumentSnapshot> {
    return this.enqueue(cursor.documentId, async () => {
      if (this.rev.get(cursor.documentId) !== cursor.revision) return this.resync(cursor.documentId);
      try {
        const snapshot = action === "undo" || action === "redo"
          ? await this.transport.editorHistory(this.request(cursor.documentId, cursor.revision), action === "redo")
          : await this.transport.editorClipboard(cursor, action, this.location(cursor.documentId));
        return this.bump(snapshot);
      } catch (cause) { if (isStaleError(cause)) return this.resync(cursor.documentId); throw cause; }
    });
  }

  /**
   * Record an authoritative snapshot, keeping only newer-or-equal revisions.
   *
   * Called for every pushed snapshot so queued tasks bind the fresh revision.
   */
  noteSnapshot(snapshot: DocumentSnapshot): void {
    const location = snapshot.location;
    const previous = this.locations.get(snapshot.documentId);
    if (location && previous && sameRoot(location.scope, previous.scope) && location.position < previous.position) return;
    if (location) this.locations.set(snapshot.documentId, location);
    this.transport.noteSnapshot?.(snapshot);
    const current = this.rev.get(snapshot.documentId);
    if (current === undefined || snapshot.revision >= current) {
      this.rev.set(snapshot.documentId, snapshot.revision);
      this.source.set(snapshot.documentId, snapshot.text);
    }
  }

  /**
   * Record an acknowledged snapshot and return it for chaining.
   *
   * Updates the execution-time revision before the caller merges the view.
   */
  private bump(snapshot: DocumentSnapshot): DocumentSnapshot {
    this.noteSnapshot(snapshot);
    return snapshot;
  }

  /** Bind a queued GUI edit only when its captured source is still canonical. */
  applyGuiEdits(request: SaveRequest, beforeText: string, edits: TextEdit[], selection?: { anchor: number; head: number }): Promise<DocumentSnapshot> {
    if (request.location && !sameLocation(request.location, this.location(request.documentId))) return Promise.reject({ code: "stale_location" });
    return this.enqueue(request.documentId, async () => {
      if (this.pendingPrefix.get(request.documentId) && selection && edits.length === 1 && edits[0].range.start === edits[0].range.end) return this.insertNativeTextNow(request.documentId, edits[0].text);
      const revision = this.rev.get(request.documentId);
      if (revision === undefined || this.source.get(request.documentId) !== beforeText) await this.resync(request.documentId);
      try {
        const expected = applyTextEdits(beforeText, edits);
        const snapshot = await this.transport.applyEdits(this.request(request.documentId, revision!), edits);
        if (snapshot.text !== expected) {
          this.noteSnapshot(snapshot);
          throw new StaleResync(snapshot);
        }
        this.bump(snapshot);
        if (selection) await this.transport.reportCursor({ documentId: request.documentId, revision: snapshot.revision, ...selection }, this.location(request.documentId));
        return snapshot;
      } catch (cause) {
        if (cause instanceof StaleResync) throw cause;
        if (isStaleError(cause)) return this.resync(request.documentId);
        throw cause;
      }
    });
  }

  /**
   * Serialize one async task behind the document tail, never dropping later tasks.
   *
   * The stored tail swallows rejections so a failed task cannot skip its
   * successors; the returned promise still rejects to the caller.
   */
  private enqueue<T>(documentId: DocumentId, task: () => Promise<T>): Promise<T> {
    const captured = this.locations.get(documentId);
    const tail = this.queues.get(documentId) ?? Promise.resolve();
    /** Reject changed positions before running the next queued native operation. */
    const execute = async () => {
      if (!sameLocation(captured, this.locations.get(documentId))) throw { code: "stale_location" };
      if (captured) this.executingLocations.set(documentId, captured);
      try { return await task(); }
      finally { this.executingLocations.delete(documentId); }
    };
    const next = tail.then(execute, execute);
    // The stored tail must never reject, or later tasks would be skipped.
    this.queues.set(
      documentId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Retain the queue's captured owner while revisions advance through earlier edits. */
  private location(documentId: DocumentId): DocumentLocation | undefined {
    return this.executingLocations.get(documentId) ?? this.locations.get(documentId);
  }

  /** Attach captured native ownership without replacing an explicitly supplied location. */
  private withLocation(request: SaveRequest): SaveRequest {
    const location = request.location ?? this.location(request.documentId);
    return location ? { ...request, location } : request;
  }

  /** Build a revision request using the location captured by this queued operation. */
  private request(documentId: DocumentId, baseRevision: number): SaveRequest {
    return this.withLocation({ documentId, baseRevision });
  }

  /**
   * Re-read the fresh snapshot and reject as a stale resync.
   *
   * Records the fresh revision so exactly one retry builds against it; the
   * shell replaces its view instead of retrying blindly.
   */
  private async resync(documentId: DocumentId): Promise<never> {
    const snapshot = await this.transport.fetchSnapshot(documentId, this.location(documentId));
    // Record the fresh revision so exactly one retry builds against it.
    this.noteSnapshot(snapshot);
    throw new StaleResync(snapshot);
  }

  /**
   * Narrow an unknown value to a save request with document ID and revision.
   *
   * Guards queue entry so malformed callers fail visibly before transport.
   */
  private isSaveRequest(value: SaveRequest): value is SaveRequest {
    return typeof value.documentId === "string" && typeof value.baseRevision === "number";
  }

  /**
   * Replace a GUI range and install its resulting caret before the next queued key.
   *
   * Native buffer edits preserve the old Neovim cursor. The report belongs to
   * this same task, at the committed revision, so Enter, mappings, and Escape
   * cannot run between the text acknowledgement and its cursor update.
   */
  private async replaceGuiRange(documentId: DocumentId, revision: number, range: Utf16Range, text: string, beforeText?: string): Promise<DocumentSnapshot> {
    const snapshot = this.bump(await this.transport.applyEdits(this.request(documentId, revision), [{ range, text }]));
    if (beforeText !== undefined && snapshot.text !== applyTextEdits(beforeText, [{ range, text }])) throw new StaleResync(snapshot);
    const head = range.start + text.length;
    await this.transport.reportCursor({ documentId, revision: snapshot.revision, anchor: head, head }, this.location(documentId));
    return snapshot;
  }

  /**
   * Apply GUI range edits serially, resyncing once on stale rejection.
   *
   * Rejects with `StaleResync` carrying the fresh snapshot when the base
   * revision moved out of band.
   */
  applyEdits(request: SaveRequest, edits: TextEdit[], current?: () => boolean): Promise<DocumentSnapshot> {
    if (!this.isSaveRequest(request)) return Promise.reject(new Error("invalid request"));
    return this.enqueue(request.documentId, async () => {
      if (current && !current()) throw new Error("search context cancelled");
      try {
        return this.bump(await this.transport.applyEdits(this.withLocation(request), edits));
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(request.documentId);
        throw cause;
      }
    });
  }

  /** Insert literal committed text only when the queued native mode permits it. */
  insertNativeText(documentId: DocumentId, text: string): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, () => this.insertNativeTextNow(documentId, text));
  }

  /** Execute committed text inside an already-owned document queue task. */
  private async insertNativeTextNow(documentId: DocumentId, text: string): Promise<DocumentSnapshot> {
    const revision = this.rev.get(documentId) ?? 0;
    const mode = await this.readMode(documentId);
    if (mode.revision !== revision || (mode.mode !== "insert" && mode.mode !== "replace")) return this.resync(documentId);
    this.pendingPrefix.delete(documentId);
    try {
      return this.bump(await this.transport.input(this.request(documentId, revision), text.replaceAll("<", "<lt>")));
    } catch (cause) {
      if (isStaleError(cause)) return this.resync(documentId);
      throw cause;
    }
  }

  /**
   * Feed keys through real Neovim, binding the revision at execution time.
   *
   * Rapid bursts order against successive acknowledgements because the
   * revision is read inside the serial queue, never at keydown.
   */
  vimInput(documentId: DocumentId, keys: string): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => {
      if (keys.length !== 1) this.pendingPrefix.delete(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      try {
        return this.bump(await this.transport.input(this.request(documentId, revision), keys));
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  /**
   * Feed keys natively and present yank/copy results in queue order.
   *
   * Awaits the clipboard presentation before accepting the next queued key so
   * copy selectors never reorder around native writes.
   */
  vimInputWithCopy(
    documentId: DocumentId,
    keys: string,
    onCopy: (copy: YankCopy) => Promise<void>,
  ): Promise<VimInputResult> {
    return this.enqueue(documentId, async () => {
      if (keys.length !== 1) this.pendingPrefix.delete(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      try {
        const result = await this.transport.inputWithCopy(this.request(documentId, revision), keys);
        this.bump(result.snapshot);
        if (result.copy) await onCopy(result.copy);
        return result;
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  /** Execute Enter after prior GUI cursor reports; preserve mappings and non-Insert modes. */
  routeEditorEnter(documentId: DocumentId, hardBreak: boolean, hasSelection: boolean, onCopy: (copy: YankCopy) => Promise<void>): Promise<VimInputResult> {
    return this.enqueue(documentId, async () => {
      let revision = this.rev.get(documentId) ?? 0;
      try {
        if (hardBreak && !hasSelection && !this.pendingPrefix.get(documentId)) {
          const mode = await this.readMode(documentId);
          if (mode.revision !== revision) return this.resync(documentId);
          if (mode.mode === "insert" && !await this.transport.hasMapping(documentId, "i", "<CR>", this.location(documentId))) {
            const cursor = await this.transport.fetchCursor(documentId, this.location(documentId));
            if (cursor.revision !== revision) return this.resync(documentId);
            const source = this.source.get(documentId);
            if (source === undefined) return this.resync(documentId);
            const spaces = hardBreakSpaces(source, cursor.anchor, cursor.head);
            if (spaces) {
              const snapshot = await this.replaceGuiRange(documentId, revision, { start: cursor.head, end: cursor.head }, spaces, source);
              revision = snapshot.revision;
            }
          }
        }
        this.pendingPrefix.delete(documentId);
        const result = await this.transport.inputWithCopy(this.request(documentId, revision), "<CR>");
        this.bump(result.snapshot);
        if (result.copy) await onCopy(result.copy);
        return result;
      } catch (cause) {
        if (isStaleError(cause)) return this.resync(documentId);
        throw cause;
      }
    });
  }

  /** Move to the next source cell in the same queue, yielding to user mappings and other modes. */
  routeTableTab(documentId: DocumentId, backwards: boolean, offset: number, beforeText: string, onCopy?: (copy: YankCopy) => Promise<void>): Promise<VimInputResult | { cursor: CursorUpdate }> {
    return this.enqueue(documentId, async () => {
      const revision = this.rev.get(documentId) ?? 0;
      const key = backwards ? "<S-Tab>" : "<Tab>";
      try {
        const mode = await this.readMode(documentId);
        if (mode.revision !== revision) return this.resync(documentId);
        if (mode.mode === "insert" && !this.pendingPrefix.get(documentId) && !await this.transport.hasMapping(documentId, "i", key, this.location(documentId))) {
          const source = this.source.get(documentId);
          if (source === undefined) return this.resync(documentId);
          let at = offset;
          if (source !== beforeText) {
            // A preceding queued GUI commit owns the new cursor; never reuse the old display offset.
            const cursor = await this.transport.fetchCursor(documentId, this.location(documentId));
            if (cursor.revision !== revision) return this.resync(documentId);
            at = cursor.head;
          }
          const next = adjacentTableCell(source, at, backwards);
          if (next) return { cursor: await this.transport.reportCursor({ documentId, revision, anchor: next.anchor, head: next.anchor }, this.location(documentId)) };
        }
        this.pendingPrefix.delete(documentId);
        const result = await this.transport.inputWithCopy(this.request(documentId, revision), key);
        this.bump(result.snapshot);
        if (result.copy && onCopy) await onCopy(result.copy);
        return result;
      } catch (cause) { if (isStaleError(cause)) return this.resync(documentId); throw cause; }
    });
  }

  /**
   * Route one printable character using the actual native mode at execution.
   *
   * The shell enqueues synchronously on keydown; the decision happens inside
   * the queue: insert/replace runs the mapping-first flow against the
   * queue-owned prefix, other modes feed natively so a fresh Visual install
   * cannot append raw GUI chars from stale refs. Mapping checks fail closed.
   */
  routeCharKey(
    documentId: DocumentId,
    key: string,
    range: { start: number; end: number },
    onCopy?: (copy: YankCopy) => Promise<void>,
    beforeText?: string,
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot; copyReady?: boolean } | { action: "gui"; snapshot: DocumentSnapshot }> {
    return this.enqueue(documentId, async () => {
      const pending = this.pendingPrefix.get(documentId) ?? "";
      if (beforeText !== undefined && this.source.get(documentId) !== beforeText && pending === "") await this.resync(documentId);
      // A mode revision is never proof of known source text: on mismatch the
      // buffer moved out of band (external/native/AI edit), so refresh and
      // reject instead of mutating offsets that may point elsewhere.
      const known = this.rev.get(documentId) ?? 0;
      const update = await this.readMode(documentId);
      if (update.revision !== known) await this.resync(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      if (update.mode !== "insert" && update.mode !== "replace") {
        this.pendingPrefix.set(documentId, "");
        try {
          if (onCopy) {
            const result = await this.transport.inputWithCopy(this.request(documentId, revision), key);
            this.bump(result.snapshot);
            if (result.copy) await onCopy(result.copy);
            return { action: "vim" as const, snapshot: result.snapshot, copyReady: result.copyReady };
          }
          return { action: "vim" as const, snapshot: this.bump(await this.transport.input(this.request(documentId, revision), key)) };
        } catch (cause) {
          if (isStaleError(cause)) await this.resync(documentId);
          throw cause;
        }
      }
      const mapped = await this.transport.hasMapping(documentId, "i", pending + key, this.location(documentId));
      try {
        if (mapped || pending !== "") {
          // A mapping prefix is native input already buffered by Neovim.
          // Its next key must also stay native, including an unmatched key
          // that releases the prefix as literal text; no GUI range is used.
          this.pendingPrefix.set(documentId, mapped ? (pending + key).slice(-16) : "");
          return { action: "vim" as const, snapshot: this.bump(await this.transport.input(this.request(documentId, revision), key)) };
        }
        this.pendingPrefix.set(documentId, "");
        return {
          action: "gui" as const,
          snapshot: await this.replaceGuiRange(documentId, revision, range, key, beforeText),
        };
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  /**
   * Apply one synchronously-captured paste as a single serial task.
   *
   * `keyNotation` carries the keyboard gesture (`"<C-v>"`) or null for
   * context-menu pastes, which never simulate a mapping. The native mode is
   * read inside the queue; callers prevent default synchronously before
   * awaiting so no default insertion interleaves and the paste lands once.
   */
  routeCapturedPaste(
    documentId: DocumentId,
    keyNotation: string | null,
    text: string,
    range: { start: number; end: number },
    beforeText?: string,
    nativeCursor = false,
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot } | { action: "gui"; snapshot: DocumentSnapshot }> {
    return this.enqueue(documentId, async () => {
      if (!nativeCursor && beforeText !== undefined && this.source.get(documentId) !== beforeText) return this.resync(documentId);
      // A mode revision is never proof of known source text: on mismatch the
      // buffer moved out of band (external/native/AI edit), so refresh and
      // reject instead of mutating offsets that may point elsewhere.
      const known = this.rev.get(documentId) ?? 0;
      const update = await this.readMode(documentId);
      if (update.revision !== known) await this.resync(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      if (keyNotation !== null && (update.mode === "insert" || update.mode === "replace")) {
        const mapped = await this.transport.hasMapping(documentId, "i", keyNotation, this.location(documentId));
        if (mapped) {
          try {
            return { action: "vim" as const, snapshot: this.bump(await this.transport.input(this.request(documentId, revision), keyNotation)) };
          } catch (cause) {
            if (isStaleError(cause)) await this.resync(documentId);
            throw cause;
          }
        }
      } else if (keyNotation !== null) {
        try {
          return { action: "vim" as const, snapshot: this.bump(await this.transport.input(this.request(documentId, revision), keyNotation)) };
        } catch (cause) {
          if (isStaleError(cause)) await this.resync(documentId);
          throw cause;
        }
      }
      let target = range;
      if (nativeCursor) {
        if (update.mode !== "insert" && update.mode !== "replace") return this.resync(documentId);
        const cursor = await this.transport.fetchCursor(documentId, this.location(documentId));
        if (cursor.revision !== revision) return this.resync(documentId);
        target = { start: cursor.head, end: cursor.head };
      }
      try {
        return {
          action: "gui" as const,
          snapshot: await this.replaceGuiRange(documentId, revision, target, text, nativeCursor ? this.source.get(documentId) : beforeText),
        };
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  /**
   * Undo through the native stack for one document, serialized with edits.
   *
   * The revision binds at execution so bursts order against ACKs.
   */
  undo(documentId: DocumentId): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => this.bump(await this.transport.undo(documentId, this.location(documentId))));
  }

  /**
   * Redo through the native stack for one document, serialized with edits.
   *
   * Shares the same queue as undo and key input so history never interleaves.
   */
  redo(documentId: DocumentId): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => this.bump(await this.transport.redo(documentId, this.location(documentId))));
  }

  /**
   * Save the document at the queued revision, tracking the result revision.
   *
   * Only newer-or-equal results advance the tracker so late completions never
   * rewind the execution-time revision.
   */
  save(request: SaveRequest) {
    return this.enqueue(request.documentId, async () => {
      const result = await this.transport.saveDocument(this.withLocation(request));
      const current = this.rev.get(request.documentId);
      if (current === undefined || result.revision >= current) this.rev.set(request.documentId, result.revision);
      return result;
    });
  }

  /**
   * Reload the document from disk, replacing the tracked revision.
   *
   * Used for external-change banners and conflict recovery.
   */
  reload(request: SaveRequest) {
    return this.enqueue(request.documentId, async () => this.bump(await this.transport.reloadDocument(this.withLocation(request))));
  }

  /**
   * Rename the document, keeping its ID and serializing with edits.
   *
   * The returned `OpenDocument` carries the fresh snapshot for the shell.
   */
  rename(request: SaveRequest, path: string): Promise<OpenDocument> {
    return this.enqueue(request.documentId, async () => { const opened = await this.transport.renameMarkdown(this.withLocation(request), path); this.noteSnapshot(opened.snapshot); return opened; });
  }

  /**
   * Apply a Neovim config file and restart the buffer actor.
   *
   * Serialized per document because configure resets Undo and mode.
   */
  configure(request: SaveRequest, path: string | null): Promise<NvimConfig> {
    return this.enqueue(request.documentId, () => this.transport.configure(this.withLocation(request), path));
  }

  /**
   * Insert a workspace image reference at the given range, serially.
   *
   * Stale bases resync instead of writing at a shifted offset.
   */
  insertWorkspaceImage(request: SaveRequest, path: string, range: Utf16Range) {
    return this.enqueue(request.documentId, async () => {
      try {
        return this.bump(await this.transport.insertWorkspaceImage(this.withLocation(request), path, range));
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(request.documentId);
        throw cause;
      }
    });
  }

  /**
   * Import an external image into the workspace and insert a reference.
   *
   * Bumps the tracked revision from the returned snapshot so chained drops
   * build on the fresh text.
   */
  importExternalImage(request: SaveRequest, path: string, range: Utf16Range) {
    return this.enqueue(request.documentId, async () => {
      try {
        const result = await this.transport.importExternalImage(this.withLocation(request), path, range);
        this.bump(result.snapshot);
        return result;
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(request.documentId);
        throw cause;
      }
    });
  }

  /**
   * Paste image bytes, replacing the exact range as one serial edit.
   *
   * Callers chain revisions locally for multi-file pastes; stale ranges
   * reject without applying so a file write never lands twice.
   */
  pasteImage(args: PasteImageArgs) {
    return this.enqueue(args.request.documentId, async () => {
      const result = await this.transport.pasteImage(this.withLocation(args.request), args.name, args.bytes, args.range);
      this.bump(result.snapshot);
      return result;
    });
  }

  /**
   * Fetch the authoritative snapshot and record its revision.
   *
   * Used for explicit resyncs and replace flows that read before writing.
   */
  fetchSnapshot(documentId: DocumentId): Promise<DocumentSnapshot> {
    return this.transport.fetchSnapshot(documentId, this.location(documentId)).then((snapshot) => {
      this.noteSnapshot(snapshot);
      return snapshot;
    });
  }

  /**
   * Fetch the current native mode with its revision for display.
   *
   * Best-effort display data; routing re-reads inside the queue.
   */
  fetchMode(documentId: DocumentId): Promise<Omit<ModeUpdate, "documentId">> {
    return this.readMode(documentId).then((update) => {
      const commands = this.pendingCommands.get(documentId);
      this.pendingCommands.delete(documentId);
      return { mode: update.mode, revision: update.revision, commandLine: update.commandLine, completion: update.completion, quickfix: update.quickfix, exReport: update.exReport, searchCount: update.searchCount, message: update.message, commands };
    });
  }

  /**
   * Fetch the last known native cursor for display refreshes.
   *
   * Failures stay with the caller; the editor keeps its own selection.
   */
  fetchCursor(documentId: DocumentId): Promise<CursorUpdate> {
    return this.transport.fetchCursor(documentId, this.location(documentId));
  }

  /**
   * Stage a GUI selection for serial reporting, coalescing rapid gestures.
   *
   * Only the latest staged selection per document is sent, so rapid gestures
   * cannot interleave with mutations or echo back. Failures stay silent and
   * the editor keeps its own selection.
   */
  stageCursor(documentId: DocumentId, anchor: number, head: number): Promise<CursorUpdate | null> {
    const staged = this.cursorStaged.get(documentId) ?? [];
    staged.push({ anchor, head });
    this.cursorStaged.set(documentId, staged);
    return this.enqueue(documentId, async () => {
      const queue = this.cursorStaged.get(documentId) ?? [];
      const latest = queue[queue.length - 1];
      this.cursorStaged.set(documentId, []);
      if (!latest) return null;
      const revision = this.rev.get(documentId) ?? 0;
      try {
        return await this.transport.reportCursor({ documentId, revision, anchor: latest.anchor, head: latest.head }, this.location(documentId));
      } catch {
        return null;
      }
    });
  }

  /**
   * Report an explicit cursor jump immediately at the execution revision.
   *
   * Used for outline/search jumps where the destination must win over
   * coalesced staging.
   */
  reportCursorNow(documentId: DocumentId, anchor: number, head: number): Promise<CursorUpdate> {
    return this.enqueue(documentId, async () => {
      const revision = this.rev.get(documentId) ?? 0;
      return this.transport.reportCursor({ documentId, revision, anchor, head }, this.location(documentId));
    });
  }

  /**
   * Report a cursor update directly without queueing.
   *
   * Rare path for callers that already hold the execution revision.
   */
  reportCursor(update: CursorUpdate): Promise<CursorUpdate> {
    return this.transport.reportCursor(update, this.location(update.documentId));
  }

  /**
   * Fetch a Neovim grid screen batch for the raw view.
   *
   * Read-only display data; text mutations never flow through here.
   */
  fetchGrid(documentId: DocumentId, width = 80, height = 24): Promise<GridUpdate> {
    return this.transport.fetchGrid(documentId, width, height);
  }

  /**
   * Fetch the current Neovim config state for the settings panel.
   *
   * Best-effort display data; apply flows go through `configure`.
   */
  fetchConfig(documentId: DocumentId): Promise<NvimConfig> {
    return this.transport.fetchConfig(documentId, this.location(documentId));
  }
}

/**
 * Browser demo registry that never claims authority.
 *
 * Every mutation rejects with the shared read-only message; no revision is
 * tracked and no save is ever simulated.
 */
export class ReadonlyRegistry {
  /** Reject native whole-buffer selection in the read-only browser demo. */
  selectAll(): Promise<never> { return this.reject(); }
  /** Reject native-selection formatting in the read-only browser demo. */
  formatEditorSelection(): Promise<never> { return this.reject(); }
  /** Reject table navigation without native document ownership. */
  routeTableTab(): Promise<never> { return this.reject(); }
  /** Reject native editor-context reads without a desktop owner. */
  fetchEditorContext(): Promise<never> { return this.reject(); }
  /** Reject every editor action in the read-only browser demo. */
  editorAction(): Promise<never> { return this.reject(); }
  /** Reject editor Enter without modifying read-only documents. */
  routeEditorEnter(): Promise<never> { return this.reject(); }
  /** Reject without tracking, preserving the read-only contract. */
  private reject(): Promise<never> {
    return Promise.reject(new LocalizedError(READONLY_MESSAGE));
  }
  /** No-op snapshot tracking outside Tauri. */
  noteSnapshot(): void {
    // No revisions are tracked outside Tauri.
  }
  /** Reject GUI edits in the browser demo. */
  applyEdits(): Promise<never> {
    return this.reject();
  }
  /** Reject captured GUI edits in the browser demo. */
  applyGuiEdits(): Promise<never> {
    return this.reject();
  }
  /** Reject native text insertion in the browser demo. */
  insertNativeText(): Promise<never> { return this.reject(); }
  /** Reject Vim input in the browser demo. */
  vimInput(_documentId?: string, _keys?: string): Promise<never> {
    return this.reject();
  }
  /** Reject copy-aware Vim input in the browser demo. */
  vimInputWithCopy(): Promise<never> {
    return this.reject();
  }
  /** Reject character routing in the browser demo. */
  routeCharKey(_documentId?: string, _key?: string, _range?: { start: number; end: number }): Promise<never> {
    return this.reject();
  }
  /** Reject captured paste routing in the browser demo. */
  routeCapturedPaste(): Promise<never> {
    return this.reject();
  }
  /** Reject undo in the browser demo. */
  undo(): Promise<never> {
    return this.reject();
  }
  /** Reject redo in the browser demo. */
  redo(): Promise<never> {
    return this.reject();
  }
  /** Reject save in the browser demo, never simulating success. */
  save(): Promise<never> {
    return this.reject();
  }
  /** Reject reload in the browser demo. */
  reload(): Promise<never> {
    return this.reject();
  }
  /** Reject rename in the browser demo. */
  rename(): Promise<never> {
    return this.reject();
  }
  /** Reject configure in the browser demo. */
  configure(): Promise<never> {
    return this.reject();
  }
  /** Reject workspace image insertion in the browser demo. */
  insertWorkspaceImage(): Promise<never> {
    return this.reject();
  }
  /** Reject external image import in the browser demo. */
  importExternalImage(): Promise<never> {
    return this.reject();
  }
  /** Reject image paste in the browser demo. */
  pasteImage(): Promise<never> {
    return this.reject();
  }
  /** Reject snapshot fetch in the browser demo. */
  fetchSnapshot(): Promise<never> {
    return this.reject();
  }
  /** Reject mode fetch in the browser demo. */
  fetchMode(): Promise<never> {
    return this.reject();
  }
  /** Reject cursor fetch in the browser demo. */
  fetchCursor(): Promise<never> {
    return this.reject();
  }
  /** Reject cursor report in the browser demo. */
  reportCursor(): Promise<never> {
    return this.reject();
  }
  /** Reject staged cursor in the browser demo. */
  stageCursor(): Promise<never> {
    return this.reject();
  }
  /** Reject immediate cursor jump in the browser demo. */
  reportCursorNow(): Promise<never> {
    return this.reject();
  }
  /** Reject grid fetch in the browser demo. */
  fetchGrid(): Promise<never> {
    return this.reject();
  }
  /** Reject config fetch in the browser demo. */
  fetchConfig(): Promise<never> {
    return this.reject();
  }
}

/** Usable document client: serial registry on desktop, read-only in browser. */
export type DocumentClient = RegistryClient | ReadonlyRegistry;
