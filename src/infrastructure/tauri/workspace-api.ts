// Tauri workspace transport (infrastructure).
//
// All `workspace_*` / `nvim_*` / document IPC lives here. No React, no DOM
// rendering: callers go through the application ports and the composition
// root injects this transport, so presentation never imports Tauri directly.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WorkspaceEventSource } from "../../application/ports";
import type {
  RootScope,
  RootEvent,
  DocumentLocation,
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
  SearchOptions,
  SearchResults,
  SearchReplaceRequest,
  SearchReplacePlan,
  TextEdit,
  Utf16Range,
  VimInputResult,
  WorkspaceEntry,
  WorkspaceEvent,
  WorkspaceInfo,
} from "../../contracts/contracts";

let currentScope: RootScope | undefined;
const rootScopes = new Map<string, RootScope>();
const locations = new Map<DocumentId, DocumentLocation>();
const recoveryLocations = new Map<DocumentId, DocumentLocation>();

/** Remember only Rust-issued document positions, without rewinding a renamed location. */
function rememberSnapshot(snapshot: DocumentSnapshot): void {
  const location = snapshot.location;
  const previous = locations.get(snapshot.documentId);
  if (location && (!previous || previous.scope.generation !== location.scope.generation || location.position >= previous.position)) locations.set(snapshot.documentId, location);
}

/** Retain native snapshot ownership for subsequent document operations. */
function rememberResult<T>(result: T): T {
  if (Array.isArray(result)) { for (const item of result) rememberResult(item); return result; }
  if (!result || typeof result !== "object") return result;
  const value = result as { documentId?: string; text?: string; snapshot?: DocumentSnapshot; document?: OpenDocument };
  if (value.snapshot) rememberSnapshot(value.snapshot);
  if (value.document) rememberSnapshot(value.document.snapshot);
  if (typeof value.documentId === "string" && typeof value.text === "string") rememberSnapshot(result as unknown as DocumentSnapshot);
  return result;
}

/** Invoke a root use case with the incarnation captured before crossing IPC. */
function rootInvoke<T>(command: string, args: Record<string, unknown> = {}, scope = currentScope): Promise<T> {
  return invoke<T>(command, { ...args, scope }).then(rememberResult);
}

/** Invoke a document use case with its supplied or last acknowledged native location. */
function documentInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const documentId = args.documentId as string | undefined;
  const expected = args.expected as CursorUpdate | undefined;
  const location = args.location ?? locations.get(documentId ?? expected?.documentId ?? "");
  return invoke<T>(command, { ...args, location }).then(rememberResult);
}

/** Filter late event batches by their producing incarnation before exposing legacy event payloads. */
function eventsForScope(events: RootEvent[], scope = currentScope): WorkspaceEvent[] {
  return events.filter((entry) => entry.scope.rootId === scope?.rootId && entry.scope.generation === scope?.generation).map((entry) => {
    if (entry.event.type === "snapshot") rememberSnapshot(entry.event.payload);
    return entry.event;
  });
}

/** Native commands never read/write files in JS; ranges count UTF-16 units. */
export const workspaceApi = {
  /** Retain ownership for native snapshots delivered by isolation imports or event streams. */
  noteSnapshot: rememberSnapshot,
  /** Read native editor-menu data at the supplied revision. */
  fetchEditorContext: (request: SaveRequest) => documentInvoke<EditorContext>("fetch_editor_context", { ...request }),
  /** Apply clipboard actions using actor-owned cursor and text. */
  editorClipboard: (expected: CursorUpdate, action: "copy" | "cut" | "paste", location?: DocumentLocation) => documentInvoke<DocumentSnapshot>("editor_clipboard", { expected, action, location }),
  /** Undo/redo authoritative history guarded by revision. */
  editorHistory: (request: SaveRequest, redo: boolean) => documentInvoke<DocumentSnapshot>("editor_history", { ...request, redo }),
  /** Open a workspace root and return its info. */
  openWorkspace: async (path: string) => {
    const info = await invoke<WorkspaceInfo>("open_workspace", { path });
    currentScope = info.scope;
    rootScopes.set(info.root, info.scope);
    return info;
  },
  /** List direct children of a workspace-relative directory. */
  listWorkspace: (path = "") => rootInvoke<WorkspaceEntry[]>("list_workspace", { path }),
  /** List currently open documents from the registry. */
  listDocuments: () => rootInvoke<OpenDocument[]>("list_documents"),
  /** Open a Markdown file through the registry. */
  openMarkdown: (path: string) => rootInvoke<OpenDocument>("open_markdown", { path }),
  /** Open a supported plain-text file through the registry. */
  openTextFile: (path: string) => rootInvoke<OpenDocument>("open_text_file", { path }),
  /** Load workspace image bytes for viewer and clipboard embedding. */
  loadWorkspaceImage: (path: string) => rootInvoke<ImageData>("load_workspace_image", { path }),
  /** Insert a workspace image reference at the given UTF-16 range. */
  insertWorkspaceImage: (request: SaveRequest, path: string, range: Utf16Range) =>
    documentInvoke<DocumentSnapshot>("insert_workspace_image", { ...request, path, range }),
  /** Copy an external image into the workspace and insert a reference. */
  importExternalImage: (request: SaveRequest, path: string, range: Utf16Range) =>
    documentInvoke<PasteResult>("import_external_image", { ...request, path, range }),
  /** Create a new Markdown document with optional initial text. */
  createMarkdown: (path: string, text = "") => rootInvoke<OpenDocument>("create_markdown", { path, text }),
  /** Create a contained directory using the existing Rust workspace owner. */
  createFolder: (path: string) => rootInvoke<WorkspaceEntry>("create_folder", { path }),
  /** Rename a Markdown document, keeping its document ID. */
  renameMarkdown: (request: SaveRequest, path: string) => documentInvoke<OpenDocument>("rename_markdown", { ...request, path }),
  /** Fetch the authoritative snapshot for a document ID. */
  fetchSnapshot: (documentId: DocumentId, location?: DocumentLocation) => documentInvoke<DocumentSnapshot>("fetch_snapshot", { documentId, location }),
  /** Apply GUI range edits at the given base revision. */
  applyEdits: (request: SaveRequest, edits: TextEdit[], expectedCursor?: CursorUpdate) => documentInvoke<DocumentSnapshot>("apply_gui_edits", { ...request, edits, ...(expectedCursor ? { expectedCursor } : {}) }),
  /** Save the document at the given base revision. */
  saveDocument: (request: SaveRequest) => documentInvoke<SaveResult>("save_document", { ...request }),
  /** Reload the document from disk at the given base revision. */
  reloadDocument: (request: SaveRequest) => documentInvoke<DocumentSnapshot>("reload_document", { ...request }),
  /** Close a document with an explicit save/discard/cancel decision. */
  closeDocument: (request: SaveRequest, action: CloseAction) => documentInvoke<boolean>("close_document", { ...request, action }),
  /** Full-text workspace search through the native index. */
  searchWorkspace: (query: string, options: SearchOptions, root: string) => rootInvoke<SearchResults>("search_workspace", { query, options, root }, rootScopes.get(root)),
  /** Request native revision-bound literal edits over authoritative search ranges. */
  planSearchReplacement: (request: SearchReplaceRequest) => rootInvoke<SearchReplacePlan>("plan_search_replacement", { request }, request.scope ?? rootScopes.get(request.root)),
  /** Poll queued workspace events for reconnecting consumers. */
  pollEvents: () => { const scope = currentScope; return rootInvoke<RootEvent[]>("poll_workspace_events", {}, scope).then((events) => eventsForScope(events, scope)); },
  /** List crash-recovery entries. */
  listRecovery: () => rootInvoke<RecoveryEntry[]>("list_recovery").then((entries) => { for (const entry of entries) recoveryLocations.set(entry.documentId, entry.location); return entries; }),
  /** Restore a crash-recovery entry into an open document. */
  restoreRecovery: (documentId: DocumentId) => invoke<OpenDocument>("restore_recovery", { documentId, location: recoveryLocations.get(documentId) }).then(rememberResult),
  /** Discard a crash-recovery entry without opening it. */
  discardRecovery: (documentId: DocumentId) => invoke<void>("discard_recovery", { documentId, location: recoveryLocations.get(documentId) }),
  /** Load a document-relative image for preview hydration. */
  loadImage: (documentId: DocumentId, path: string) => documentInvoke<ImageData>("load_relative_image", { documentId, path }),
  /** Paste image bytes, replacing the given UTF-16 range. */
  pasteImage: (request: SaveRequest, name: string, bytes: Uint8Array, range: Utf16Range) =>
    documentInvoke<PasteResult>("paste_image", { ...request, name, bytes: Array.from(bytes), range }),
  /** Feed raw keys through real Neovim. */
  input: (request: SaveRequest, keys: string) => documentInvoke<DocumentSnapshot>("nvim_input", { ...request, keys }),
  /** Fetch the current Neovim mode for a document. */
  fetchMode: (documentId: DocumentId, location?: DocumentLocation) => documentInvoke<ModeUpdate>("fetch_mode", { documentId, location }),
  /** Feed keys natively and report yank/copy side effects. */
  inputWithCopy: (request: SaveRequest, keys: string) => documentInvoke<VimInputResult>("nvim_input_with_copy", { ...request, keys }),
  /** Check whether an Insert-mode mapping prefix exists. */
  hasMapping: (documentId: DocumentId, mode: string, lhs: string, location?: DocumentLocation) =>
    documentInvoke<boolean>("has_nvim_mapping", { documentId, mode, lhs, location }),
  /** Fetch the last known native cursor for a document. */
  fetchCursor: (documentId: DocumentId, location?: DocumentLocation) => documentInvoke<CursorUpdate>("fetch_cursor", { documentId, location }),
  /** Report a GUI selection to the native cursor tracker. */
  reportCursor: (update: CursorUpdate, location?: DocumentLocation) => documentInvoke<CursorUpdate>("report_cursor", { ...update, location }),
  /** Fetch a Neovim grid screen batch. */
  fetchGrid: (documentId: DocumentId, width = 80, height = 24) => documentInvoke<GridUpdate>("fetch_grid", { documentId, width, height }),
  /** Undo through the native undo stack. */
  undo: (documentId: DocumentId, location?: DocumentLocation) => documentInvoke<DocumentSnapshot>("undo_document", { documentId, location }),
  /** Redo through the native undo stack. */
  redo: (documentId: DocumentId, location?: DocumentLocation) => documentInvoke<DocumentSnapshot>("redo_document", { documentId, location }),
  /** Apply a Neovim config file and restart the buffer actor. */
  configure: (request: SaveRequest, path: string | null) => documentInvoke<NvimConfig>("configure_document", { ...request, path }),
  /** Fetch the current Neovim config state for a document. */
  fetchConfig: (documentId: DocumentId, location?: DocumentLocation) => documentInvoke<NvimConfig>("fetch_config", { documentId, location }),
};

/**
 * Subscribe to pushed workspace events, falling back to polling.
 *
 * Outside Tauri the subscription resolves to a no-op unlisten so the browser
 * demo keeps its manual inputs without a transport.
 */
export function listenWorkspaceEvents(callback: (events: WorkspaceEvent[]) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<RootEvent[]>("marxen:workspace", (event) => callback(eventsForScope(event.payload)));
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
