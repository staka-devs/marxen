// Document registry client: serial, revision-aware requests against the
// Issue #4 workspace IPC (`workspaceApi` in `./workspace`).
//
// The real Neovim buffer is the only authority. Mutating calls for one
// document are serialized through a per-document promise queue so Vim key
// input, GUI range edits, undo/redo, save, and configure never interleave.
// Stale revisions are never retried blindly: the client re-reads the fresh
// snapshot and surfaces it to the shell, which replaces its view.
// No frontend history is kept here and no revision is ever minted locally.
//
// When IPC is absent (browser demo) the document is read-only: mutations
// are rejected with a Japanese message and save success is never simulated.

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
  WorkspaceError,
} from "../shared/contracts";
import { isDesktop as isDesktopShell, workspaceApi } from "./workspace";

export const READONLY_MESSAGE = "ブラウザ表示では編集できません。デスクトップで開いてください。";

export function isDesktop(): boolean {
  return isDesktopShell();
}

/** A stale rejection carrying the freshly re-read authoritative snapshot. */
export class StaleResync extends Error {
  readonly snapshot: DocumentSnapshot;
  constructor(snapshot: DocumentSnapshot) {
    super(`改訂が古いため最新の原文に再同期しました（リビジョン ${snapshot.revision}）。`);
    this.name = "StaleResync";
    this.snapshot = snapshot;
  }
}

/** True when a Tauri rejection is a revision-stale contract error. */
export function isStaleError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const record = cause as { code?: unknown; error?: unknown };
  if (record.code !== "contract") return false;
  const inner = record.error as { code?: unknown } | undefined;
  return typeof inner === "object" && inner !== null && inner.code === "stale_revision";
}

export function workspaceErrorText(cause: unknown): string {
  if (cause instanceof StaleResync) return cause.message;
  if (cause instanceof Error) {
    // Tauri serializes WorkspaceError as a plain object, but real Error
    // instances (transport failures) keep their message.
    if (cause.message && cause.message !== "{}") return describeWorkspaceError(cause);
    return cause.message || String(cause);
  }
  return describeWorkspaceError(cause);
}

function describeWorkspaceError(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return String(cause);
  const record = cause as { code?: unknown; [key: string]: unknown };
  switch (record.code) {
    case "contract": {
      const inner = record.error as { code?: unknown; expected?: unknown; received?: unknown } | undefined;
      if (inner?.code === "stale_revision") {
        return `改訂が古いため再同期してください（期待 ${String(inner.expected)}, 受信 ${String(inner.received)}）。`;
      }
      return `契約エラー: ${String(inner?.code ?? "不明")}`;
    }
    case "unsaved_changes":
      return "未保存の変更があるため操作できません。";
    case "conflict":
      return `保存競合: ディスクが変更されています（${String(record.path ?? "")}）。本文は保持しています。`;
    case "no_workspace":
      return "フォルダーが開かれていません。フォルダーを開いてください。";
    case "not_found":
      return "ファイルが見つかりません。";
    case "already_exists":
      return "宛先に既存のファイルがあるため上書きしません。";
    case "outside_workspace":
      return "ワークスペースの外には操作できません。";
    case "not_markdown":
      return "Markdown ファイル（.md / .markdown）のみ開けます。";
    case "invalid_utf8":
      return "UTF-8 ではないため開けません。";
    case "invalid_path":
      return "パスが正しくありません。";
    case "invalid_image":
      return "対応画像（PNG/JPEG/GIF/WebP、20 MiB 以下）のみ扱えます。";
    case "neovim":
      return `Neovim エラー: ${String(record.detail ?? "")}`;
    case "io":
      return `入出力エラー: ${String(record.detail ?? "")}`;
    default:
      return typeof record.code === "string" ? record.code : JSON.stringify(cause);
  }
}

export interface VimKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Serialize a DOM key event to Neovim input notation for `nvim_input`.
 * Returns null for pure modifiers, platform IME keys, and UI-reserved keys
 * the shell handles itself (the shell filters Ctrl+P / Ctrl+S etc. before
 * calling this). Platform IME keys return null BEFORE any modifier
 * formatting so the OS default (e.g. real Alt+backquote IME toggle) is never
 * prevented and no invalid `<M-KanjiMode>` text is fed. Named keys are
 * normalized before modifiers so Ctrl+ArrowUp becomes `<C-Up>`, never
 * `<C-ArrowUp>`. Multi-character keys (IME-committed text) pass through
 * verbatim so they are typed natively; composition preedit never reaches
 * here. Both the shell router and the raw grid view share this serializer.
 */
const NAMED_VIM_KEYS: Record<string, string> = {
  Enter: "CR",
  Backspace: "BS",
  Tab: "Tab",
  Escape: "Esc",
  Delete: "Del",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  " ": "Space",
};

/** DOM keys owned by the platform IME or the composition system. Never Vim. */
const PLATFORM_IME_KEYS = new Set([
  "KanjiMode",
  "Convert",
  "NonConvert",
  "Hiragana",
  "HiraganaKatakana",
  "Katakana",
  "Zenkaku",
  "Hankaku",
  "ZenkakuHankaku",
  "Romaji",
  "Alphanumeric",
  "ModeChange",
  "HangulMode",
  "JunjaMode",
  "FinalMode",
  "HanjaMode",
  "Eisu",
  "Process",
  "Dead",
  "Unidentified",
]);

export function serializeVimKey(event: VimKey): string | null {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return null;
  if (PLATFORM_IME_KEYS.has(key)) return null;
  const normalized = NAMED_VIM_KEYS[key] ?? key;
  if (ctrlKey || metaKey) {
    const mod = "C";
    const base = normalized.length === 1 ? normalized.toLowerCase() : normalized;
    void metaKey;
    return `<${mod}-${base}>`;
  }
  if (altKey) {
    return `<M-${normalized}>`;
  }
  switch (normalized) {
    case "CR":
      return "<CR>";
    case "BS":
      return "<BS>";
    case "Tab":
      return "<Tab>";
    case "Esc":
      return "<Esc>";
    case "Del":
      return "<Del>";
    case "Up":
      return "<Up>";
    case "Down":
      return "<Down>";
    case "Left":
      return "<Left>";
    case "Right":
      return "<Right>";
    case "Home":
      return "<Home>";
    case "End":
      return "<End>";
    case "PageUp":
      return "<PageUp>";
    case "PageDown":
      return "<PageDown>";
    case "Space":
      return " ";
    default:
      if (/^F\d{1,2}$/.test(normalized)) return shiftKey ? `<S-${normalized}>` : `<${normalized}>`;
      return key;
  }
}

export interface PasteImageArgs {
  request: SaveRequest;
  name: string;
  bytes: Uint8Array;
  range: Utf16Range;
}

/**
 * Registry-backed document client. One instance per shell; mutating requests
 * for the same document are serialized. The client tracks the latest
 * acknowledged revision per document so queued tasks always build requests
 * against the revision at execution time, never at event time.
 */
export class RegistryClient {
  private queues = new Map<DocumentId, Promise<unknown>>();
  private rev = new Map<DocumentId, number>();
  private cursorStaged = new Map<DocumentId, Array<{ anchor: number; head: number }>>();
  /** Insert-mode mapping prefix per document, owned inside the serial queue. */
  private pendingPrefix = new Map<DocumentId, string>();

  /** Record an authoritative snapshot (newer-or-equal wins). */
  noteSnapshot(snapshot: DocumentSnapshot): void {
    const current = this.rev.get(snapshot.documentId);
    if (current === undefined || snapshot.revision >= current) {
      this.rev.set(snapshot.documentId, snapshot.revision);
    }
  }

  private bump(snapshot: DocumentSnapshot): DocumentSnapshot {
    this.rev.set(snapshot.documentId, snapshot.revision);
    return snapshot;
  }

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

  private async resync(documentId: DocumentId): Promise<never> {
    const snapshot = await workspaceApi.fetchSnapshot(documentId);
    // Record the fresh revision so exactly one retry builds against it.
    this.noteSnapshot(snapshot);
    throw new StaleResync(snapshot);
  }

  private isSaveRequest(value: SaveRequest): value is SaveRequest {
    return typeof value.documentId === "string" && typeof value.baseRevision === "number";
  }

  applyEdits(request: SaveRequest, edits: TextEdit[]): Promise<DocumentSnapshot> {
    if (!this.isSaveRequest(request)) return Promise.reject(new Error("invalid request"));
    return this.enqueue(request.documentId, async () => {
      try {
        return this.bump(await workspaceApi.applyEdits(request, edits));
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(request.documentId);
        throw cause;
      }
    });
  }

  /** Feed keys through real Neovim (mappings/macros fire), then sync.
   *  The revision binds at queue execution, never at keydown, so rapid
   *  bursts order against successive acknowledgements. */
  vimInput(documentId: DocumentId, keys: string): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => {
      const revision = this.rev.get(documentId) ?? 0;
      try {
        return this.bump(await workspaceApi.input({ documentId, baseRevision: revision }, keys));
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  /**
   * Printable character routing with the actual native mode read inside the
   * serial queue. The shell enqueues synchronously on keydown (multi-key
   * g/gg and operator prefixes never wait), and the decision happens at
   * execution: insert/replace runs the mapping-first insert flow against the
   * queue-owned pending prefix, any other mode feeds the key natively so a
   * Visual install followed immediately by a key cannot append raw GUI chars
   * from stale Normal/Insert refs. Mapping precedence is fail-closed.
   */
  routeCharKey(
    documentId: DocumentId,
    key: string,
    range: { start: number; end: number },
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot } | { action: "gui"; snapshot: DocumentSnapshot }> {
    return this.enqueue(documentId, async () => {
      // A mode revision is never proof of known source text: on mismatch the
      // buffer moved out of band (external/native/AI edit), so refresh and
      // reject instead of mutating offsets that may point elsewhere.
      const known = this.rev.get(documentId) ?? 0;
      const update = await workspaceApi.fetchMode(documentId);
      if (update.revision !== known) await this.resync(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      if (update.mode !== "insert" && update.mode !== "replace") {
        this.pendingPrefix.set(documentId, "");
        try {
          return { action: "vim" as const, snapshot: this.bump(await workspaceApi.input({ documentId, baseRevision: revision }, key)) };
        } catch (cause) {
          if (isStaleError(cause)) await this.resync(documentId);
          throw cause;
        }
      }
      const pending = this.pendingPrefix.get(documentId) ?? "";
      const mapped = await workspaceApi.hasMapping(documentId, "i", pending + key);
      try {
        if (mapped) {
          this.pendingPrefix.set(documentId, (pending + key).slice(-16));
          return { action: "vim" as const, snapshot: this.bump(await workspaceApi.input({ documentId, baseRevision: revision }, key)) };
        }
        this.pendingPrefix.set(documentId, "");
        return {
          action: "gui" as const,
          snapshot: this.bump(
            await workspaceApi.applyEdits({ documentId, baseRevision: revision }, [{ range, text: key }]),
          ),
        };
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  /**
   * Captured paste as ONE serial task from a synchronously-read paste event.
   * `keyNotation` carries the keyboard gesture (`"<C-v>"`) or null for
   * context-menu pastes, which never simulate a mapping. The actual native
   * mode is read inside the queue: a keyboard paste in insert/replace queries
   * the explicit mapping first (fail-closed on unreadable state), a keyboard
   * gesture that lands outside insert feeds natively, and otherwise the
   * captured text replaces the exact half-open range as a single GUI edit.
   * The caller prevents default synchronously BEFORE awaiting this so no
   * default insertion can interleave and the paste lands exactly once.
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
      const update = await workspaceApi.fetchMode(documentId);
      if (update.revision !== known) await this.resync(documentId);
      const revision = this.rev.get(documentId) ?? 0;
      if (keyNotation !== null && (update.mode === "insert" || update.mode === "replace")) {
        const mapped = await workspaceApi.hasMapping(documentId, "i", keyNotation);
        if (mapped) {
          try {
            return { action: "vim" as const, snapshot: this.bump(await workspaceApi.input({ documentId, baseRevision: revision }, keyNotation)) };
          } catch (cause) {
            if (isStaleError(cause)) await this.resync(documentId);
            throw cause;
          }
        }
      } else if (keyNotation !== null) {
        try {
          return { action: "vim" as const, snapshot: this.bump(await workspaceApi.input({ documentId, baseRevision: revision }, keyNotation)) };
        } catch (cause) {
          if (isStaleError(cause)) await this.resync(documentId);
          throw cause;
        }
      }
      try {
        return {
          action: "gui" as const,
          snapshot: this.bump(
            await workspaceApi.applyEdits({ documentId, baseRevision: revision }, [{ range, text }]),
          ),
        };
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  undo(documentId: DocumentId): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => this.bump(await workspaceApi.undo(documentId)));
  }

  redo(documentId: DocumentId): Promise<DocumentSnapshot> {
    return this.enqueue(documentId, async () => this.bump(await workspaceApi.redo(documentId)));
  }

  save(request: SaveRequest) {
    return this.enqueue(request.documentId, async () => {
      const result = await workspaceApi.saveDocument(request);
      const current = this.rev.get(request.documentId);
      if (current === undefined || result.revision >= current) this.rev.set(request.documentId, result.revision);
      return result;
    });
  }

  reload(request: SaveRequest) {
    return this.enqueue(request.documentId, async () => this.bump(await workspaceApi.reloadDocument(request)));
  }

  rename(request: SaveRequest, path: string): Promise<OpenDocument> {
    return this.enqueue(request.documentId, () => workspaceApi.renameMarkdown(request, path));
  }

  configure(request: SaveRequest, path: string | null): Promise<NvimConfig> {
    return this.enqueue(request.documentId, () => workspaceApi.configure(request, path));
  }

  pasteImage(args: PasteImageArgs) {
    return this.enqueue(args.request.documentId, async () => {
      const result = await workspaceApi.pasteImage(args.request, args.name, args.bytes, args.range);
      this.bump(result.snapshot);
      return result;
    });
  }

  fetchSnapshot(documentId: DocumentId): Promise<DocumentSnapshot> {
    return workspaceApi.fetchSnapshot(documentId).then((snapshot) => {
      this.noteSnapshot(snapshot);
      return snapshot;
    });
  }

  fetchMode(documentId: DocumentId): Promise<{ mode: VimMode; revision: number }> {
    return workspaceApi.fetchMode(documentId).then((update: ModeUpdate) => ({ mode: update.mode, revision: update.revision }));
  }

  fetchCursor(documentId: DocumentId): Promise<CursorUpdate> {
    return workspaceApi.fetchCursor(documentId);
  }

  /**
   * Stage a GUI selection for serial reporting. Only the latest staged
   * selection per document is sent, so rapid gestures cannot interleave with
   * mutations or echo back into a feedback loop. Best-effort: failures stay
   * silent and the editor keeps its own selection.
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
        return await workspaceApi.reportCursor({ documentId, revision, anchor: latest.anchor, head: latest.head });
      } catch {
        return null;
      }
    });
  }

  /** Immediate cursor move for explicit jumps, at the execution revision. */
  reportCursorNow(documentId: DocumentId, anchor: number, head: number): Promise<CursorUpdate> {
    return this.enqueue(documentId, async () => {
      const revision = this.rev.get(documentId) ?? 0;
      return workspaceApi.reportCursor({ documentId, revision, anchor, head });
    });
  }

  reportCursor(update: CursorUpdate): Promise<CursorUpdate> {
    return workspaceApi.reportCursor(update);
  }

  fetchGrid(documentId: DocumentId, width = 80, height = 24): Promise<GridUpdate> {
    return workspaceApi.fetchGrid(documentId, width, height);
  }

  fetchConfig(documentId: DocumentId): Promise<NvimConfig> {
    return workspaceApi.fetchConfig(documentId);
  }
}

/** Browser demo: read-only. Never claims a save or a revision bump. */
export class ReadonlyRegistry {
  private reject(): Promise<never> {
    return Promise.reject(new Error(READONLY_MESSAGE));
  }
  noteSnapshot(): void {
    // No revisions are tracked outside Tauri.
  }
  applyEdits(): Promise<never> {
    return this.reject();
  }
  vimInput(_documentId?: string, _keys?: string): Promise<never> {
    return this.reject();
  }
  routeCharKey(_documentId?: string, _key?: string, _range?: { start: number; end: number }): Promise<never> {
    return this.reject();
  }
  routeCapturedPaste(): Promise<never> {
    return this.reject();
  }
  undo(): Promise<never> {
    return this.reject();
  }
  redo(): Promise<never> {
    return this.reject();
  }
  save(): Promise<never> {
    return this.reject();
  }
  reload(): Promise<never> {
    return this.reject();
  }
  rename(): Promise<never> {
    return this.reject();
  }
  configure(): Promise<never> {
    return this.reject();
  }
  pasteImage(): Promise<never> {
    return this.reject();
  }
  fetchSnapshot(): Promise<never> {
    return this.reject();
  }
  fetchMode(): Promise<never> {
    return this.reject();
  }
  fetchCursor(): Promise<never> {
    return this.reject();
  }
  reportCursor(): Promise<never> {
    return this.reject();
  }
  stageCursor(): Promise<never> {
    return this.reject();
  }
  reportCursorNow(): Promise<never> {
    return this.reject();
  }
  fetchGrid(): Promise<never> {
    return this.reject();
  }
  fetchConfig(): Promise<never> {
    return this.reject();
  }
}

export type DocumentClient = RegistryClient | ReadonlyRegistry;

export function createClient(): DocumentClient {
  return isDesktop() ? new RegistryClient() : new ReadonlyRegistry();
}

/**
 * Composition gate: while `composing` (IME preedit), buffer editor
 * transactions and commit exactly once on `compositionend`. The registry
 * contract accepts only committed text; preedit never reaches Neovim.
 * Normal-mode IME keys are not intercepted as motions: the gate only
 * suppresses document changes, never key handling.
 *
 * Note: jsdom/Vitest composition tests exercise DOM event plumbing only.
 * Real TSF (Windows WebView2), NSTextInput (macOS WKWebView), and
 * IBus/Fcitx (Linux WebKitGTK) behavior is unverified here by design.
 */
export class CompositionGate {
  private composing = false;
  private pending: TextEdit[] = [];

  get isComposing(): boolean {
    return this.composing;
  }

  start(): void {
    this.composing = true;
    this.pending = [];
  }

  /** Buffer while composing; pass through when not composing. */
  offer(edits: TextEdit[]): TextEdit[] | null {
    if (!this.composing) return edits;
    this.pending = edits;
    return null;
  }

  /** Commit once: returns the final edits and clears the gate. */
  commit(finalEdits?: TextEdit[]): TextEdit[] | null {
    this.composing = false;
    if (finalEdits && finalEdits.length > 0) {
      this.pending = [];
      return finalEdits;
    }
    const out = this.pending;
    this.pending = [];
    return out.length > 0 ? out : null;
  }

  cancel(): void {
    this.composing = false;
    this.pending = [];
  }
}

// Re-exported so shells keep importing error shapes from one place.
export type { WorkspaceError };
