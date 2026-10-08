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
 * Returns null for pure modifiers and UI-reserved keys the shell handles
 * itself (the shell filters Ctrl+P / Ctrl+S etc. before calling this).
 * Multi-character keys (IME-committed text) pass through verbatim so they
 * are typed natively; composition preedit never reaches here.
 */
export function serializeVimKey(event: VimKey): string | null {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return null;
  if (ctrlKey || metaKey) {
    const mod = "C";
    const base = key.length === 1 ? key.toLowerCase() : key;
    const named: Record<string, string> = {
      Enter: "CR",
      Backspace: "BS",
      Tab: "Tab",
      Escape: "Esc",
      " ": "Space",
    };
    const inner = named[base] ?? base;
    void metaKey;
    return `<${mod}-${inner}>`;
  }
  if (altKey) {
    return `<M-${key.length === 1 ? key : key}>`;
  }
  switch (key) {
    case "Enter":
      return "<CR>";
    case "Backspace":
      return "<BS>";
    case "Tab":
      return "<Tab>";
    case "Escape":
      return "<Esc>";
    case "Delete":
      return "<Del>";
    case "ArrowUp":
      return "<Up>";
    case "ArrowDown":
      return "<Down>";
    case "ArrowLeft":
      return "<Left>";
    case "ArrowRight":
      return "<Right>";
    case "Home":
      return "<Home>";
    case "End":
      return "<End>";
    case "PageUp":
      return "<PageUp>";
    case "PageDown":
      return "<PageDown>";
    case "F1":
    case "F2":
    case "F3":
    case "F4":
    case "F5":
    case "F6":
    case "F7":
    case "F8":
    case "F9":
    case "F10":
    case "F11":
    case "F12":
      return shiftKey ? `<S-${key}>` : `<${key}>`;
    case " ":
      return " ";
    default:
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
   * Mapping-first insert as ONE serial task: the revision is read at
   * execution time (never at event time), then the pending prefix plus the
   * key is queried via `has_nvim_mapping`. A claimed key feeds natively; an
   * unclaimed key becomes a GUI caret insert. Either way the snapshot feeds
   * back so bursts keep source order with no duplication.
   */
  routeInsertKey(
    documentId: DocumentId,
    pending: string,
    key: string,
    at: number,
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot } | { action: "gui"; snapshot: DocumentSnapshot }> {
    return this.enqueue(documentId, async () => {
      const revision = this.rev.get(documentId) ?? 0;
      let mapped = false;
      try {
        mapped = await workspaceApi.hasMapping(documentId, "i", pending + key);
      } catch {
        // Mapping state unreadable: fall through to the GUI range edit so a
        // keystroke is never swallowed by the router.
      }
      try {
        if (mapped) {
          return { action: "vim" as const, snapshot: this.bump(await workspaceApi.input({ documentId, baseRevision: revision }, key)) };
        }
        return {
          action: "gui" as const,
          snapshot: this.bump(
            await workspaceApi.applyEdits({ documentId, baseRevision: revision }, [{ range: { start: at, end: at }, text: key }]),
          ),
        };
      } catch (cause) {
        if (isStaleError(cause)) await this.resync(documentId);
        throw cause;
      }
    });
  }

  /**
   * Clipboard paste as ONE serial task: an explicit insert-mode <C-v>
   * mapping wins and feeds natively, otherwise the clipboard text lands as
   * a single GUI range insert. The caller prevents default BEFORE awaiting
   * this so no duplicate default paste can interleave.
   */
  routePasteText(
    documentId: DocumentId,
    keyNotation: string,
    text: string,
    at: number,
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot } | { action: "gui"; snapshot: DocumentSnapshot }> {
    return this.enqueue(documentId, async () => {
      const revision = this.rev.get(documentId) ?? 0;
      let mapped = false;
      try {
        mapped = await workspaceApi.hasMapping(documentId, "i", keyNotation);
      } catch {
        // Mapping state unreadable: land the text rather than swallowing it.
      }
      try {
        if (mapped) {
          return { action: "vim" as const, snapshot: this.bump(await workspaceApi.input({ documentId, baseRevision: revision }, keyNotation)) };
        }
        return {
          action: "gui" as const,
          snapshot: this.bump(
            await workspaceApi.applyEdits({ documentId, baseRevision: revision }, [{ range: { start: at, end: at }, text }]),
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
    return this.enqueue(args.request.documentId, () => workspaceApi.pasteImage(args.request, args.name, args.bytes, args.range));
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
  routeInsertKey(_documentId?: string, _pending?: string, _key?: string, _at?: number): Promise<never> {
    return this.reject();
  }
  routePasteText(): Promise<never> {
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
