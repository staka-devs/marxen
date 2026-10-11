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
  DocumentId,
  DocumentSnapshot,
  GridUpdate,
  ModeUpdate,
  NvimConfig,
  OpenDocument,
  SaveRequest,
  TextEdit,
  Utf16Range,
  VimMode,
  VimInputResult,
  YankCopy,
} from "../../contracts/contracts";
import { isStaleError, READONLY_MESSAGE, StaleResync } from "../../domain/document-errors";
import type { DocumentTransport } from "../ports";

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
  private queues = new Map<DocumentId, Promise<unknown>>();
  private rev = new Map<DocumentId, number>();
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

  /**
   * Record an authoritative snapshot, keeping only newer-or-equal revisions.
   *
   * Called for every pushed snapshot so queued tasks bind the fresh revision.
   */
  noteSnapshot(snapshot: DocumentSnapshot): void {
    const current = this.rev.get(snapshot.documentId);
    if (current === undefined || snapshot.revision >= current) {
      this.rev.set(snapshot.documentId, snapshot.revision);
    }
  }

  /**
   * Record an acknowledged snapshot and return it for chaining.
   *
   * Updates the execution-time revision before the caller merges the view.
   */
  private bump(snapshot: DocumentSnapshot): DocumentSnapshot {
    this.rev.set(snapshot.documentId, snapshot.revision);
    return snapshot;
  }

  /**
   * Serialize one async task behind the document tail, never dropping later tasks.
   *
   * The stored tail swallows rejections so a failed task cannot skip its
   * successors; the returned promise still rejects to the caller.
   */
  private enqueue<T>(documentId: DocumentId, task: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(documentId) ?? Promise.resolve();
    const next = tail.then(task, task);
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

  /**
   * Re-read the fresh snapshot and reject as a stale resync.
   *
   * Records the fresh revision so exactly one retry builds against it; the
   * shell replaces its view instead of retrying blindly.
   */
  private async resync(documentId: DocumentId): Promise<never> {
    const snapshot = await this.transport.fetchSnapshot(documentId);
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
  private async replaceGuiRange(documentId: DocumentId, revision: number, range: Utf16Range, text: string): Promise<DocumentSnapshot> {
    const snapshot = this.bump(await this.transport.applyEdits({ documentId, baseRevision: revision }, [{ range, text }]));
    const head = range.start + text.length;
    await this.transport.reportCursor({ documentId, revision: snapshot.revision, anchor: head, head });
    return snapshot;
  }

  /**
   * Apply GUI range edits serially, resyncing once on stale rejection.
   *
   * Rejects with `StaleResync` carrying the fresh snapshot when the base
   * revision moved out of band.
   */
  applyEdits(request: SaveRequest, edits: TextEdit[]): Promise<DocumentSnapshot> {
    if (!this.isSaveRequest(request)) return Promise.reject(new Error("invalid request"));
    return this.enqueue(request.documentId, async () => {
      try {
        return this.bump(await this.transport.applyEdits(request, edits));
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(request.documentId);
        throw cause;
      }
    });
  }

  /**
   * Feed keys through real Neovim, binding the revision at execution time.
   *
   * Rapid bursts order against successive acknowledgements because the
   * revision is read inside the serial queue, never at keydown.
   */
  vimInput(documentId: DocumentId, keys: string): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => {
      const revision = this.rev.get(documentId) ?? 0;
      try {
        return this.bump(await this.transport.input({ documentId, baseRevision: revision }, keys));
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
      const revision = this.rev.get(documentId) ?? 0;
      try {
        const result = await this.transport.inputWithCopy({ documentId, baseRevision: revision }, keys);
        this.bump(result.snapshot);
        if (result.copy) await onCopy(result.copy);
        return result;
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
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
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot; copyReady?: boolean } | { action: "gui"; snapshot: DocumentSnapshot }> {
    return this.enqueue(documentId, async () => {
      // A mode revision is never proof of known source text: on mismatch the
      // buffer moved out of band (external/native/AI edit), so refresh and
      // reject instead of mutating offsets that may point elsewhere.
      const known = this.rev.get(documentId) ?? 0;
      const update = await this.transport.fetchMode(documentId);
      if (update.revision !== known) await this.resync(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      if (update.mode !== "insert" && update.mode !== "replace") {
        this.pendingPrefix.set(documentId, "");
        try {
          if (onCopy) {
            const result = await this.transport.inputWithCopy({ documentId, baseRevision: revision }, key);
            this.bump(result.snapshot);
            if (result.copy) await onCopy(result.copy);
            return { action: "vim" as const, snapshot: result.snapshot, copyReady: result.copyReady };
          }
          return { action: "vim" as const, snapshot: this.bump(await this.transport.input({ documentId, baseRevision: revision }, key)) };
        } catch (cause) {
          if (isStaleError(cause)) await this.resync(documentId);
          throw cause;
        }
      }
      const pending = this.pendingPrefix.get(documentId) ?? "";
      const mapped = await this.transport.hasMapping(documentId, "i", pending + key);
      try {
        if (mapped) {
          this.pendingPrefix.set(documentId, (pending + key).slice(-16));
          return { action: "vim" as const, snapshot: this.bump(await this.transport.input({ documentId, baseRevision: revision }, key)) };
        }
        this.pendingPrefix.set(documentId, "");
        return {
          action: "gui" as const,
          snapshot: await this.replaceGuiRange(documentId, revision, range, key),
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
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot } | { action: "gui"; snapshot: DocumentSnapshot }> {
    return this.enqueue(documentId, async () => {
      // A mode revision is never proof of known source text: on mismatch the
      // buffer moved out of band (external/native/AI edit), so refresh and
      // reject instead of mutating offsets that may point elsewhere.
      const known = this.rev.get(documentId) ?? 0;
      const update = await this.transport.fetchMode(documentId);
      if (update.revision !== known) await this.resync(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      if (keyNotation !== null && (update.mode === "insert" || update.mode === "replace")) {
        const mapped = await this.transport.hasMapping(documentId, "i", keyNotation);
        if (mapped) {
          try {
            return { action: "vim" as const, snapshot: this.bump(await this.transport.input({ documentId, baseRevision: revision }, keyNotation)) };
          } catch (cause) {
            if (isStaleError(cause)) await this.resync(documentId);
            throw cause;
          }
        }
      } else if (keyNotation !== null) {
        try {
          return { action: "vim" as const, snapshot: this.bump(await this.transport.input({ documentId, baseRevision: revision }, keyNotation)) };
        } catch (cause) {
          if (isStaleError(cause)) await this.resync(documentId);
          throw cause;
        }
      }
      try {
        return {
          action: "gui" as const,
          snapshot: await this.replaceGuiRange(documentId, revision, range, text),
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
    return this.enqueue(documentId, async () => this.bump(await this.transport.undo(documentId)));
  }

  /**
   * Redo through the native stack for one document, serialized with edits.
   *
   * Shares the same queue as undo and key input so history never interleaves.
   */
  redo(documentId: DocumentId): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => this.bump(await this.transport.redo(documentId)));
  }

  /**
   * Save the document at the queued revision, tracking the result revision.
   *
   * Only newer-or-equal results advance the tracker so late completions never
   * rewind the execution-time revision.
   */
  save(request: SaveRequest) {
    return this.enqueue(request.documentId, async () => {
      const result = await this.transport.saveDocument(request);
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
    return this.enqueue(request.documentId, async () => this.bump(await this.transport.reloadDocument(request)));
  }

  /**
   * Rename the document, keeping its ID and serializing with edits.
   *
   * The returned `OpenDocument` carries the fresh snapshot for the shell.
   */
  rename(request: SaveRequest, path: string): Promise<OpenDocument> {
    return this.enqueue(request.documentId, () => this.transport.renameMarkdown(request, path));
  }

  /**
   * Apply a Neovim config file and restart the buffer actor.
   *
   * Serialized per document because configure resets Undo and mode.
   */
  configure(request: SaveRequest, path: string | null): Promise<NvimConfig> {
    return this.enqueue(request.documentId, () => this.transport.configure(request, path));
  }

  /**
   * Insert a workspace image reference at the given range, serially.
   *
   * Stale bases resync instead of writing at a shifted offset.
   */
  insertWorkspaceImage(request: SaveRequest, path: string, range: Utf16Range) {
    return this.enqueue(request.documentId, async () => {
      try {
        return this.bump(await this.transport.insertWorkspaceImage(request, path, range));
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
        const result = await this.transport.importExternalImage(request, path, range);
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
      const result = await this.transport.pasteImage(args.request, args.name, args.bytes, args.range);
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
    return this.transport.fetchSnapshot(documentId).then((snapshot) => {
      this.noteSnapshot(snapshot);
      return snapshot;
    });
  }

  /**
   * Fetch the current native mode with its revision for display.
   *
   * Best-effort display data; routing re-reads inside the queue.
   */
  fetchMode(documentId: DocumentId): Promise<{ mode: VimMode; revision: number }> {
    return this.transport.fetchMode(documentId).then((update: ModeUpdate) => ({ mode: update.mode, revision: update.revision }));
  }

  /**
   * Fetch the last known native cursor for display refreshes.
   *
   * Failures stay with the caller; the editor keeps its own selection.
   */
  fetchCursor(documentId: DocumentId): Promise<CursorUpdate> {
    return this.transport.fetchCursor(documentId);
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
        return await this.transport.reportCursor({ documentId, revision, anchor: latest.anchor, head: latest.head });
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
      return this.transport.reportCursor({ documentId, revision, anchor, head });
    });
  }

  /**
   * Report a cursor update directly without queueing.
   *
   * Rare path for callers that already hold the execution revision.
   */
  reportCursor(update: CursorUpdate): Promise<CursorUpdate> {
    return this.transport.reportCursor(update);
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
    return this.transport.fetchConfig(documentId);
  }
}

/**
 * Browser demo registry that never claims authority.
 *
 * Every mutation rejects with the shared read-only message; no revision is
 * tracked and no save is ever simulated.
 */
export class ReadonlyRegistry {
  /** Reject without tracking, preserving the read-only contract. */
  private reject(): Promise<never> {
    return Promise.reject(new Error(READONLY_MESSAGE));
  }
  /** No-op snapshot tracking outside Tauri. */
  noteSnapshot(): void {
    // No revisions are tracked outside Tauri.
  }
  /** Reject GUI edits in the browser demo. */
  applyEdits(): Promise<never> {
    return this.reject();
  }
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
