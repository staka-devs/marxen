// Tauri workspace transport (infrastructure).
//
// All `workspace_*` / `nvim_*` / document IPC lives here. No React, no DOM
// rendering: callers go through the application ports and the composition
// root injects this transport, so presentation never imports Tauri directly.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WorkspaceEventSource } from "../../application/ports";
import type {
  CloseAction,
  CursorUpdate,
  EditorContext,
  DocumentId,
  DocumentSnapshot,
  GridUpdate,
  ImageData,
  ModeUpdate,
  NvimConfig,
  OpenDocument,
  PasteResult,
  RecoveryEntry,
  SaveRequest,
  SaveResult,
  SearchMatch,
  TextEdit,
  Utf16Range,
  VimInputResult,
  WorkspaceEntry,
  WorkspaceEvent,
  WorkspaceInfo,
} from "../../contracts/contracts";

/** Native commands never read/write files in JS; ranges count UTF-16 units. */
export const workspaceApi = {
  /** Read native editor-menu data at the supplied revision. */
  fetchEditorContext: (request: SaveRequest) => invoke<EditorContext>("fetch_editor_context", { ...request }),
  /** Apply clipboard actions using actor-owned cursor and text. */
  editorClipboard: (expected: CursorUpdate, action: "copy" | "cut" | "paste") => invoke<DocumentSnapshot>("editor_clipboard", { expected, action }),
  /** Undo/redo authoritative history guarded by revision. */
  editorHistory: (request: SaveRequest, redo: boolean) => invoke<DocumentSnapshot>("editor_history", { ...request, redo }),
  /** Open a workspace root and return its info. */
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  /** List direct children of a workspace-relative directory. */
  listWorkspace: (path = "") => invoke<WorkspaceEntry[]>("list_workspace", { path }),
  /** List currently open documents from the registry. */
  listDocuments: () => invoke<OpenDocument[]>("list_documents"),
  /** Open a Markdown file through the registry. */
  openMarkdown: (path: string) => invoke<OpenDocument>("open_markdown", { path }),
  /** Open a supported plain-text file through the registry. */
  openTextFile: (path: string) => invoke<OpenDocument>("open_text_file", { path }),
  /** Load workspace image bytes for viewer and clipboard embedding. */
  loadWorkspaceImage: (path: string) => invoke<ImageData>("load_workspace_image", { path }),
  /** Insert a workspace image reference at the given UTF-16 range. */
  insertWorkspaceImage: (request: SaveRequest, path: string, range: Utf16Range) =>
    invoke<DocumentSnapshot>("insert_workspace_image", { ...request, path, range }),
  /** Copy an external image into the workspace and insert a reference. */
  importExternalImage: (request: SaveRequest, path: string, range: Utf16Range) =>
    invoke<PasteResult>("import_external_image", { ...request, path, range }),
  /** Create a new Markdown document with optional initial text. */
  createMarkdown: (path: string, text = "") => invoke<OpenDocument>("create_markdown", { path, text }),
  /** Create a contained directory using the existing Rust workspace owner. */
  createFolder: (path: string) => invoke<WorkspaceEntry>("create_folder", { path }),
  /** Rename a Markdown document, keeping its document ID. */
  renameMarkdown: (request: SaveRequest, path: string) => invoke<OpenDocument>("rename_markdown", { ...request, path }),
  /** Fetch the authoritative snapshot for a document ID. */
  fetchSnapshot: (documentId: DocumentId) => invoke<DocumentSnapshot>("fetch_snapshot", { documentId }),
  /** Apply GUI range edits at the given base revision. */
  applyEdits: (request: SaveRequest, edits: TextEdit[], expectedCursor?: CursorUpdate) => invoke<DocumentSnapshot>("apply_gui_edits", { ...request, edits, ...(expectedCursor ? { expectedCursor } : {}) }),
  /** Save the document at the given base revision. */
  saveDocument: (request: SaveRequest) => invoke<SaveResult>("save_document", { ...request }),
  /** Reload the document from disk at the given base revision. */
  reloadDocument: (request: SaveRequest) => invoke<DocumentSnapshot>("reload_document", { ...request }),
  /** Close a document with an explicit save/discard/cancel decision. */
  closeDocument: (request: SaveRequest, action: CloseAction) => invoke<boolean>("close_document", { ...request, action }),
  /** Full-text workspace search through the native index. */
  searchWorkspace: (query: string) => invoke<SearchMatch[]>("search_workspace", { query }),
  /** Poll queued workspace events for reconnecting consumers. */
  pollEvents: () => invoke<WorkspaceEvent[]>("poll_workspace_events"),
  /** List crash-recovery entries. */
  listRecovery: () => invoke<RecoveryEntry[]>("list_recovery"),
  /** Restore a crash-recovery entry into an open document. */
  restoreRecovery: (documentId: DocumentId) => invoke<OpenDocument>("restore_recovery", { documentId }),
  /** Discard a crash-recovery entry without opening it. */
  discardRecovery: (documentId: DocumentId) => invoke<void>("discard_recovery", { documentId }),
  /** Load a document-relative image for preview hydration. */
  loadImage: (documentId: DocumentId, path: string) => invoke<ImageData>("load_relative_image", { documentId, path }),
  /** Paste image bytes, replacing the given UTF-16 range. */
  pasteImage: (request: SaveRequest, name: string, bytes: Uint8Array, range: Utf16Range) =>
    invoke<PasteResult>("paste_image", { ...request, name, bytes: Array.from(bytes), range }),
  /** Feed raw keys through real Neovim. */
  input: (request: SaveRequest, keys: string) => invoke<DocumentSnapshot>("nvim_input", { ...request, keys }),
  /** Fetch the current Neovim mode for a document. */
  fetchMode: (documentId: DocumentId) => invoke<ModeUpdate>("fetch_mode", { documentId }),
  /** Feed keys natively and report yank/copy side effects. */
  inputWithCopy: (request: SaveRequest, keys: string) => invoke<VimInputResult>("nvim_input_with_copy", { ...request, keys }),
  /** Check whether an Insert-mode mapping prefix exists. */
  hasMapping: (documentId: DocumentId, mode: string, lhs: string) =>
    invoke<boolean>("has_nvim_mapping", { documentId, mode, lhs }),
  /** Fetch the last known native cursor for a document. */
  fetchCursor: (documentId: DocumentId) => invoke<CursorUpdate>("fetch_cursor", { documentId }),
  /** Report a GUI selection to the native cursor tracker. */
  reportCursor: (update: CursorUpdate) => invoke<CursorUpdate>("report_cursor", { ...update }),
  /** Fetch a Neovim grid screen batch. */
  fetchGrid: (documentId: DocumentId, width = 80, height = 24) => invoke<GridUpdate>("fetch_grid", { documentId, width, height }),
  /** Undo through the native undo stack. */
  undo: (documentId: DocumentId) => invoke<DocumentSnapshot>("undo_document", { documentId }),
  /** Redo through the native undo stack. */
  redo: (documentId: DocumentId) => invoke<DocumentSnapshot>("redo_document", { documentId }),
  /** Apply a Neovim config file and restart the buffer actor. */
  configure: (request: SaveRequest, path: string | null) => invoke<NvimConfig>("configure_document", { ...request, path }),
  /** Fetch the current Neovim config state for a document. */
  fetchConfig: (documentId: DocumentId) => invoke<NvimConfig>("fetch_config", { documentId }),
};

/**
 * Subscribe to pushed workspace events, falling back to polling.
 *
 * Outside Tauri the subscription resolves to a no-op unlisten so the browser
 * demo keeps its manual inputs without a transport.
 */
export function listenWorkspaceEvents(callback: (events: WorkspaceEvent[]) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<WorkspaceEvent[]>("marxen:workspace", (event) => callback(event.payload));
}

/** Event source adapter satisfying the application port with Tauri events. */
export const workspaceEventSource: WorkspaceEventSource = {
  /** Subscribe to pushed events, resolving to an unlisten function. */
  listen: listenWorkspaceEvents,
};

/**
 * Report whether the Tauri native transport is available.
 *
 * The browser demo uses this to stay read-only; tests mock `isTauri`.
 */
export function isDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}
