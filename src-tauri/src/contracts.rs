//! Wire contract v1. Rust owns this definition; export-contracts generates TypeScript.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct DocumentId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Revision(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Utf16Offset(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Utf8ByteOffset(pub u32);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSnapshot {
    pub document_id: DocumentId,
    pub revision: Revision,
    pub text: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Utf16Range {
    pub start: Utf16Offset,
    pub end: Utf16Offset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextEdit {
    pub range: Utf16Range,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum EditSource {
    Gui,
    Neovim,
    Ai,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditRequest {
    pub document_id: DocumentId,
    pub base_revision: Revision,
    pub source: EditSource,
    pub edits: Vec<TextEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    pub document_id: DocumentId,
    pub base_revision: Revision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveResult {
    pub document_id: DocumentId,
    pub revision: Revision,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorUpdate {
    pub document_id: DocumentId,
    pub revision: Revision,
    pub anchor: Utf16Offset,
    pub head: Utf16Offset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum VimMode {
    Normal,
    Insert,
    Replace,
    Visual,
    VisualLine,
    VisualBlock,
    CommandLine,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModeUpdate {
    pub document_id: DocumentId,
    pub revision: Revision,
    pub mode: VimMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum DocumentEvent {
    Snapshot(DocumentSnapshot),
    Saved(SaveResult),
    Cursor(CursorUpdate),
    Mode(ModeUpdate),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStatus {
    pub contract_version: u32,
    pub connection: ConnectionState,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ContractError {
    InvalidDocumentId,
    WrongDocument,
    StaleRevision {
        expected: Revision,
        received: Revision,
    },
    RevisionExhausted,
    OffsetOutOfBounds,
    SplitSurrogatePair,
    NotUtf8Boundary,
    ReversedRange,
    OverlappingEdits,
    EmptyEdits,
}

pub fn typescript() -> String {
    let cfg = ts_rs::Config::default();
    let declarations = [
        DocumentId::decl(&cfg),
        Revision::decl(&cfg),
        Utf16Offset::decl(&cfg),
        Utf8ByteOffset::decl(&cfg),
        DocumentSnapshot::decl(&cfg),
        Utf16Range::decl(&cfg),
        TextEdit::decl(&cfg),
        EditSource::decl(&cfg),
        EditRequest::decl(&cfg),
        SaveRequest::decl(&cfg),
        SaveResult::decl(&cfg),
        CursorUpdate::decl(&cfg),
        VimMode::decl(&cfg),
        ModeUpdate::decl(&cfg),
        DocumentEvent::decl(&cfg),
        ConnectionState::decl(&cfg),
        RuntimeStatus::decl(&cfg),
        ContractError::decl(&cfg),
    ];
    let mut output = "// Generated from src-tauri/src/contracts.rs. Run npm run contracts:generate.\n// Do not edit by hand. Global offsets count UTF-16 code units; ranges are [start, end).\n".to_owned();
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
}
