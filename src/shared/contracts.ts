// Generated from src-tauri/src/contracts.rs. Run npm run contracts:generate.
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
export type VimMode = "normal" | "insert" | "replace" | "visual" | "visual_line" | "visual_block" | "command_line" | "terminal";
export type ModeUpdate = { documentId: DocumentId, revision: Revision, mode: VimMode, };
export type DocumentEvent = { "type": "snapshot", "payload": DocumentSnapshot } | { "type": "saved", "payload": SaveResult } | { "type": "cursor", "payload": CursorUpdate } | { "type": "mode", "payload": ModeUpdate };
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type RuntimeStatus = { contractVersion: number, connection: ConnectionState, detail: string, };
export type ContractError = { "code": "invalid_document_id" } | { "code": "wrong_document" } | { "code": "stale_revision", expected: Revision, received: Revision, } | { "code": "revision_exhausted" } | { "code": "offset_out_of_bounds" } | { "code": "split_surrogate_pair" } | { "code": "not_utf8_boundary" } | { "code": "reversed_range" } | { "code": "overlapping_edits" } | { "code": "empty_edits" };
