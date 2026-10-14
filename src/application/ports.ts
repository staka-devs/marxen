// Narrow application ports (application).
//
// Interface boundary between use cases and concrete adapters. Domain types
// only; no Tauri, DOM, React, or browser globals. The composition root
// injects infrastructure implementations, so presentation never imports
// infrastructure directly and domain/application never pull singletons.

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
  SearchOptions,
  SearchResults,
  SearchReplaceRequest,
  SearchReplacePlan,
  TextEdit,
  Utf16Range,
  VimInputResult,
  VimMode,
  WorkspaceEntry,
  WorkspaceEvent,
  WorkspaceInfo,
  YankCopy,
} from "../contracts/contracts";
import type {
  AiPromptRequest,
  AiProviderConfig,
  AiTestResult,
  CredentialRef,
  AiProviderKind,
  AiStreamEvent,
  AiRunId,
} from "../contracts/ai-contracts";
import type {
  ApproveResult,
  IsolationDiff,
  IsolatedCopyInfo,
  StagedImportOutcome,
  StagedProposal,
} from "../contracts/isolation-contracts";
import type { PromptContext, PromptMode, ProposalText, IsolatedCopyId } from "../contracts/ai-contracts";
import type { ImageResolver } from "../domain/image-sources";

/** Revision-aware document gateway owned by the registry transport. */
export interface DocumentGateway {
  /** Format only a captured native selection at its exact source and revision. */
  formatEditorSelection(cursor: CursorUpdate, beforeText: string, kind: import("../domain/markdown-gui").FormatKind): Promise<DocumentSnapshot>;
  /** Capture authoritative menu data at queue execution. */
  fetchEditorContext(documentId: DocumentId): Promise<EditorContext>;
  /** Run one guarded menu action against the captured native cursor/revision. */
  editorAction(cursor: CursorUpdate, action: EditorAction): Promise<DocumentSnapshot>;
  /** Record an authoritative snapshot (newer-or-equal wins). */
  noteSnapshot(snapshot: DocumentSnapshot): void;
  /** Apply GUI edits serially, resyncing once on stale. */
  applyEdits(request: SaveRequest, edits: TextEdit[], current?: () => boolean): Promise<DocumentSnapshot>;
  /** Commit a locally captured GUI change only against its exact source text. */
  applyGuiEdits(request: SaveRequest, beforeText: string, edits: TextEdit[], selection?: { anchor: number; head: number }): Promise<DocumentSnapshot>;
  /** Insert committed text at the native cursor after queued mode transitions. */
  insertNativeText(documentId: DocumentId, text: string): Promise<DocumentSnapshot>;
  /** Feed keys through real Neovim, binding the revision at execution time. */
  vimInput(documentId: DocumentId, keys: string): Promise<DocumentSnapshot>;
  /** Feed keys natively with copy side effects in queue order. */
  vimInputWithCopy(documentId: DocumentId, keys: string, onCopy: (copy: YankCopy) => Promise<void>): Promise<VimInputResult>;
  /** Route Enter with an optional Markdown hard break at the queued native cursor. */
  routeEditorEnter(documentId: DocumentId, hardBreak: boolean, hasSelection: boolean, onCopy: (copy: YankCopy) => Promise<void>): Promise<VimInputResult>;
  /** Navigate source table cells in Insert mode while preserving actual Tab mappings. */
  routeTableTab(documentId: DocumentId, backwards: boolean, offset: number, beforeText: string, onCopy?: (copy: YankCopy) => Promise<void>): Promise<VimInputResult | { cursor: CursorUpdate }>;
  /** Route one printable char using native mode and optional captured GUI source. */
  routeCharKey(
    documentId: DocumentId,
    key: string,
    range: { start: number; end: number },
    onCopy?: (copy: YankCopy) => Promise<void>,
    beforeText?: string,
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot; copyReady?: boolean } | { action: "gui"; snapshot: DocumentSnapshot }>;
  /** Apply one captured paste as a single serial task. */
  routeCapturedPaste(
    documentId: DocumentId,
    keyNotation: string | null,
    text: string,
    range: { start: number; end: number },
    beforeText?: string,
    nativeCursor?: boolean,
  ): Promise<{ action: "vim"; snapshot: DocumentSnapshot } | { action: "gui"; snapshot: DocumentSnapshot }>;
  /** Undo through the native stack. */
  undo(documentId: DocumentId): Promise<DocumentSnapshot>;
  /** Redo through the native stack. */
  redo(documentId: DocumentId): Promise<DocumentSnapshot>;
  /** Save at the queued revision. */
  save(request: SaveRequest): Promise<SaveResult>;
  /** Reload from disk. */
  reload(request: SaveRequest): Promise<DocumentSnapshot>;
  /** Rename a document. */
  rename(request: SaveRequest, path: string): Promise<OpenDocument>;
  /** Apply a Neovim config and restart the actor. */
  configure(request: SaveRequest, path: string | null): Promise<NvimConfig>;
  /** Insert a workspace image reference. */
  insertWorkspaceImage(request: SaveRequest, path: string, range: Utf16Range): Promise<DocumentSnapshot>;
  /** Import an external image and insert a reference. */
  importExternalImage(request: SaveRequest, path: string, range: Utf16Range): Promise<PasteResult>;
  /** Paste image bytes replacing the exact range. */
  pasteImage(args: { request: SaveRequest; name: string; bytes: Uint8Array; range: Utf16Range }): Promise<PasteResult>;
  /** Fetch the authoritative snapshot. */
  fetchSnapshot(documentId: DocumentId): Promise<DocumentSnapshot>;
  /** Fetch the native mode with revision. */
  fetchMode(documentId: DocumentId): Promise<{ mode: VimMode; revision: number }>;
  /** Fetch the native cursor. */
  fetchCursor(documentId: DocumentId): Promise<CursorUpdate>;
  /** Stage a GUI selection, coalescing rapid gestures. */
  stageCursor(documentId: DocumentId, anchor: number, head: number): Promise<CursorUpdate | null>;
  /** Report an explicit jump at the execution revision. */
  reportCursorNow(documentId: DocumentId, anchor: number, head: number): Promise<CursorUpdate>;
  /** Report a cursor update directly without queueing. */
  reportCursor(update: CursorUpdate): Promise<CursorUpdate>;
  /** Fetch a grid screen batch. */
  fetchGrid(documentId: DocumentId, width?: number, height?: number): Promise<GridUpdate>;
  /** Fetch the Neovim config state. */
  fetchConfig(documentId: DocumentId): Promise<NvimConfig>;
}
/**
 * Raw document transport port behind the registry use cases.
 *
 * One method per native document command; the registry serializes calls,
 * binds revisions at execution time, and resyncs on stale rejections. The
 * Tauri workspace API satisfies this port structurally, so the composition
 * root injects it directly with no forwarding wrappers.
 */
export interface DocumentTransport {
  /** Read native selection, active mappings and the explicit popup opt-in. */
  fetchEditorContext(request: SaveRequest): Promise<EditorContext>;
  /** Copy/cut/paste a native selection guarded against cursor or revision drift. */
  editorClipboard(cursor: CursorUpdate, action: "copy" | "cut" | "paste"): Promise<DocumentSnapshot>;
  /** Undo/redo native history after atomically validating the requested revision. */
  editorHistory(request: SaveRequest, redo: boolean): Promise<DocumentSnapshot>;
  /** Apply GUI range edits at the given base revision. */
  applyEdits(request: SaveRequest, edits: TextEdit[], expectedCursor?: CursorUpdate): Promise<DocumentSnapshot>;
  /** Feed raw keys through real Neovim. */
  input(request: SaveRequest, keys: string): Promise<DocumentSnapshot>;
  /** Feed keys natively and report yank/copy side effects. */
  inputWithCopy(request: SaveRequest, keys: string): Promise<VimInputResult>;
  /** Fetch the current Neovim mode for a document. */
  fetchMode(documentId: DocumentId): Promise<ModeUpdate>;
  /** Check whether an Insert-mode mapping prefix exists. */
  hasMapping(documentId: DocumentId, mode: string, lhs: string): Promise<boolean>;
  /** Fetch the authoritative snapshot for a document ID. */
  fetchSnapshot(documentId: DocumentId): Promise<DocumentSnapshot>;
  /** Report a GUI selection to the native cursor tracker. */
  reportCursor(update: CursorUpdate): Promise<CursorUpdate>;
  /** Fetch the last known native cursor for a document. */
  fetchCursor(documentId: DocumentId): Promise<CursorUpdate>;
  /** Undo through the native undo stack. */
  undo(documentId: DocumentId): Promise<DocumentSnapshot>;
  /** Redo through the native undo stack. */
  redo(documentId: DocumentId): Promise<DocumentSnapshot>;
  /** Save the document at the given base revision. */
  saveDocument(request: SaveRequest): Promise<SaveResult>;
  /** Reload the document from disk at the given base revision. */
  reloadDocument(request: SaveRequest): Promise<DocumentSnapshot>;
  /** Rename a Markdown document, keeping its document ID. */
  renameMarkdown(request: SaveRequest, path: string): Promise<OpenDocument>;
  /** Apply a Neovim config file and restart the buffer actor. */
  configure(request: SaveRequest, path: string | null): Promise<NvimConfig>;
  /** Insert a workspace image reference at the given UTF-16 range. */
  insertWorkspaceImage(request: SaveRequest, path: string, range: Utf16Range): Promise<DocumentSnapshot>;
  /** Copy an external image into the workspace and insert a reference. */
  importExternalImage(request: SaveRequest, path: string, range: Utf16Range): Promise<PasteResult>;
  /** Paste image bytes, replacing the given UTF-16 range. */
  pasteImage(request: SaveRequest, name: string, bytes: Uint8Array, range: Utf16Range): Promise<PasteResult>;
  /** Fetch a Neovim grid screen batch. */
  fetchGrid(documentId: DocumentId, width?: number, height?: number): Promise<GridUpdate>;
  /** Fetch the current Neovim config state for a document. */
  fetchConfig(documentId: DocumentId): Promise<NvimConfig>;
}
/** Explicit native editor-menu actions; no browser history or clipboard state. */
export type EditorAction = "copy" | "cut" | "paste" | "undo" | "redo";

/** Workspace file and recovery gateway over native IPC. */
export interface WorkspaceGateway {
  /** Open a workspace root. */
  openWorkspace(path: string): Promise<WorkspaceInfo>;
  /** List direct children of a workspace-relative directory. */
  listWorkspace(path?: string): Promise<WorkspaceEntry[]>;
  /** List open documents. */
  listDocuments(): Promise<OpenDocument[]>;
  /** Open a Markdown file. */
  openMarkdown(path: string): Promise<OpenDocument>;
  /** Open a plain-text file. */
  openTextFile(path: string): Promise<OpenDocument>;
  /** Create a Markdown document. */
  createMarkdown(path: string, text?: string): Promise<OpenDocument>;
  /** Rename a Markdown document. */
  renameMarkdown(request: SaveRequest, path: string): Promise<OpenDocument>;
  /** Close a document with an explicit decision. */
  closeDocument(request: SaveRequest, action: CloseAction): Promise<boolean>;
  /** Native full-text search. */
  searchWorkspace(query: string, options: SearchOptions, root: string): Promise<SearchResults>;
  /** Prepare authoritative match edits only for unchanged searched content and root. */
  planSearchReplacement(request: SearchReplaceRequest): Promise<SearchReplacePlan>;
  /** Poll queued workspace events. */
  pollEvents(): Promise<WorkspaceEvent[]>;
  /** List crash-recovery entries. */
  listRecovery(): Promise<RecoveryEntry[]>;
  /** Restore a recovery entry. */
  restoreRecovery(documentId: DocumentId): Promise<OpenDocument>;
  /** Discard a recovery entry. */
  discardRecovery(documentId: DocumentId): Promise<void>;
  /** Load a document-relative image. */
  loadImage(documentId: DocumentId, path: string): Promise<ImageData>;
  /** Load a workspace image by path. */
  loadWorkspaceImage(path: string): Promise<ImageData>;
  /** Fetch a snapshot for replace flows. */
  fetchSnapshot(documentId: DocumentId): Promise<DocumentSnapshot>;
  /** Fetch a Neovim grid screen batch for the raw view. */
  fetchGrid(documentId: DocumentId, width?: number, height?: number): Promise<GridUpdate>;
}

/** Workspace event subscription with polling fallback. */
export interface WorkspaceEventSource {
  /** Subscribe to pushed events, resolving to an unlisten function. */
  listen(callback: (events: WorkspaceEvent[]) => void): Promise<() => void>;
}

/** AI streaming session with owned cancellation. */
export interface AiPromptSession {
  runId: AiRunId;
  /** Cancel the owned run once and release the listener. */
  stop: () => Promise<void>;
}

/** AI gateway over native IPC and the OS credential store. */
export interface AiGateway {
  /** Start a streaming prompt with early-event buffering. */
  startPrompt(request: AiPromptRequest, onEvent: (event: AiStreamEvent) => void): Promise<AiPromptSession>;
  /** Best-effort cancel without surfacing cancel errors. */
  cancelPromptSafe(stop: () => Promise<void>): Promise<void>;
  /** Answer a pending permission request with the exact chosen option ID. */
  replyPermission(runId: AiRunId, requestId: string, optionId: string): Promise<void>;
  /** Read credential presence for a provider. */
  getCredentialState(kind: AiProviderKind): Promise<CredentialRef>;
  /** Store a secret in the OS store. */
  setCredential(kind: AiProviderKind, secret: string): Promise<void>;
  /** Delete a secret from the OS store. */
  deleteCredential(kind: AiProviderKind): Promise<void>;
  /** Test a provider connection. */
  testConnection(config: AiProviderConfig, live: boolean): Promise<AiTestResult>;
}

/** Isolation staging gateway pinned by Rust until settlement. */
export interface IsolationGateway {
  /** Register contexts as an isolated copy. */
  createCopy(contexts: PromptContext[]): Promise<IsolatedCopyInfo>;
  /** Fetch diffs with drift detection for a copy. */
  fetchDiff(copyId: IsolatedCopyId): Promise<IsolationDiff[]>;
  /** List new agent-created Markdown files for import. */
  fetchNewFiles(copyId: IsolatedCopyId): Promise<import("../contracts/isolation-contracts").StagedNewFile[]>;
  /** Import staged files into the approved copy's original workspace. */
  importNewFiles(copyId: IsolatedCopyId, files: Array<{ rel: string; content: string }>): Promise<StagedImportOutcome[]>;
  /** Stage a validated proposal into the copy. */
  stageProposal(copyId: IsolatedCopyId, proposal: ProposalText, mode: PromptMode): Promise<StagedProposal>;
  /** Approve and apply the staged copy with scoped rollback. */
  approveCopy(copyId: IsolatedCopyId): Promise<ApproveResult>;
  /** Reject the staged copy without touching disk. */
  rejectCopy(copyId: IsolatedCopyId): Promise<void>;
  /** Cancel the copy after runs settle. */
  cancelCopy(copyId: IsolatedCopyId): Promise<void>;
}

/** Runtime status gateway for Neovim connectivity. */
export interface RuntimeGateway {
  /** Read the native runtime status, or disconnected in the browser. */
  readStatus(): Promise<import("../contracts/contracts").RuntimeStatus>;
}

/** Native dialog gateway for folder and config pickers. */
export interface DialogGateway {
  /** Native folder picker; null when cancelled or unavailable. */
  pickFolder(title?: string): Promise<string | null>;
  /** Native config-file picker; name validated by the caller. */
  pickConfigFile(title?: string): Promise<string | null>;
}

/** Native file-drop subscription. */
export interface DropGateway {
  /** Subscribe to native drag-drop events. */
  listen(onDrop: (drop: { position: { x: number; y: number }; paths: string[] }) => void): Promise<() => void>;
}

/** Clipboard gateway owned by Rust after async formatting. */
export interface ClipboardGateway {
  /** Copy a yank through Rust without browser activation permission. */
  copyYank(copy: YankCopy, documentId: string): Promise<void>;
}

/** Non-secret AI profile store. */
export interface AiProfileStore {
  /** Load the sanitized profile or defaults. */
  load(): import("../domain/ai-profile").AiProfile;
  /** Persist a sanitized profile; failures stay silent. */
  save(profile: import("../domain/ai-profile").AiProfile): void;
}

/** View-only editor preferences store. */
export interface EditorPreferencesStore {
  /** Load normalized preferences or defaults. */
  load(): import("../domain/editor-preferences").EditorPreferences;
  /** Persist normalized preferences, reporting success. */
  save(preferences: import("../domain/editor-preferences").EditorPreferences): boolean;
}

/** Image byte loader with per-document scoping. */
export interface ImageLoader {
  /** Resolve a relative source to a displayable URL or null. */
  resolve(documentId: string, src: string, signal: AbortSignal): Promise<string | null>;
  /** Shared resolver factory for the active document. */
  forDocument(documentId: string): ImageResolver;
}
