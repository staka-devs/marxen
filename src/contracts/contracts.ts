// Generated from src-tauri/src/contracts/mod.rs. Run npm run contracts:generate.
// Do not edit by hand. Global offsets count UTF-16 code units; ranges are [start, end).
export type DocumentId = string;
export type Revision = number;
export type Utf16Offset = number;
export type Utf8ByteOffset = number;
export type DocumentSnapshot = { documentId: DocumentId, revision: Revision, text: string, dirty: boolean, };
export type Utf16Range = { start: Utf16Offset, end: Utf16Offset, };
export type TextEdit = { range: Utf16Range, text: string, };
export type EditSource = "gui" | "neovim" | "ai";
export type EditRequest = { documentId: DocumentId, baseRevision: Revision, source: EditSource, edits: Array<TextEdit>, };
export type SaveRequest = { documentId: DocumentId, baseRevision: Revision, };
export type SaveResult = { documentId: DocumentId, revision: Revision, dirty: boolean, };
export type CursorUpdate = { documentId: DocumentId, revision: Revision, anchor: Utf16Offset, head: Utf16Offset, };
export type EditorMapping = { lhs: string, rhs: string, };
export type EditorPresentation = { 
/**
 * True only when Neovim permits modification and the buffer is not marked read-only.
 */
editable: boolean, selectionToolbar: boolean, mappings: Array<EditorMapping>, };
export type EditorContext = { cursor: CursorUpdate, mode: VimMode, presentation: EditorPresentation, };
export type VimMode = "normal" | "insert" | "replace" | "visual" | "visual_line" | "visual_block" | "command_line" | "terminal";
export type ModeUpdate = { documentId: DocumentId, revision: Revision, mode: VimMode, };
export type DocumentEvent = { "type": "snapshot", "payload": DocumentSnapshot } | { "type": "saved", "payload": SaveResult } | { "type": "cursor", "payload": CursorUpdate } | { "type": "mode", "payload": ModeUpdate };
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type RuntimeStatus = { contractVersion: number, connection: ConnectionState, detail: string, };
export type ContractError = { "code": "invalid_document_id" } | { "code": "wrong_document" } | { "code": "stale_revision", expected: Revision, received: Revision, } | { "code": "revision_exhausted" } | { "code": "offset_out_of_bounds" } | { "code": "split_surrogate_pair" } | { "code": "not_utf8_boundary" } | { "code": "reversed_range" } | { "code": "overlapping_edits" } | { "code": "empty_edits" };
export type WorkspaceError = { "code": "invalid_path" } | { "code": "outside_workspace" } | { "code": "not_markdown" } | { "code": "not_text" } | { "code": "invalid_utf8" } | { "code": "already_exists" } | { "code": "not_found" } | { "code": "no_workspace" } | { "code": "unknown_document" } | { "code": "unsaved_changes", snapshot: DocumentSnapshot, } | { "code": "conflict", path: string, } | { "code": "io", detail: string, } | { "code": "neovim", detail: string, } | { "code": "contract", error: ContractError, } | { "code": "invalid_image" };
export type WorkspaceInfo = { root: string, };
export type WorkspaceFileKind = "markdown" | "text" | "image";
export type WorkspaceEntry = { path: string, name: string, directory: boolean, markdown: boolean, kind?: WorkspaceFileKind, };
export type OpenDocument = { path: string | null, snapshot: DocumentSnapshot, };
export type SearchMatch = { path: string, documentId: DocumentId | null, revision: Revision | null, range: Utf16Range, line: number, preview: string, };
export type CloseAction = "save" | "discard" | "cancel";
export type RecoveryEntry = { documentId: DocumentId, path: string | null, revision: Revision, conflict: boolean, };
export type WorkspaceEvent = { "type": "external_change", "payload": { documentId: DocumentId, path: string, dirty: boolean, deleted: boolean, } } | { "type": "snapshot", "payload": DocumentSnapshot } | { "type": "saved", "payload": SaveResult } | { "type": "error", "payload": { documentId: DocumentId, error: WorkspaceError, } };
export type ImageData = { mime: string, bytes: Array<number>, };
export type PasteResult = { path: string, snapshot: DocumentSnapshot, };
export type NvimConfig = { path: string | null, errors: Array<string>, 
/**
 * Copy selectors read from the active vimrc. Values use Neovim key
 * notation (for example `<F6>`), so the shell can compare them with its
 * serialized DOM key events without inventing a second mapping language.
 */
copyKeys: { [key in string]: string }, };
export type CopyFormat = "markdown" | "text" | "rich" | "html";
export type YankCopy = { format: CopyFormat, 
/**
 * Exact native TextYankPost contents, including linewise newlines.
 */
text: string, };
export type VimInputResult = { snapshot: DocumentSnapshot, copy: YankCopy | null, copyReady: boolean, };
export type GridUpdate = { documentId: DocumentId, revision: Revision, updates: unknown[], };
