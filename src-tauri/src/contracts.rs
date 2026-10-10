//! Wire contract v1. Rust owns this definition; export-contracts generates TypeScript.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum WorkspaceError {
    InvalidPath,
    OutsideWorkspace,
    NotMarkdown,
    InvalidUtf8,
    AlreadyExists,
    NotFound,
    NoWorkspace,
    UnknownDocument,
    UnsavedChanges { snapshot: DocumentSnapshot },
    Conflict { path: String },
    Io { detail: String },
    Neovim { detail: String },
    Contract { error: ContractError },
    InvalidImage,
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for WorkspaceError {}
impl From<std::io::Error> for WorkspaceError {
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            detail: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub markdown: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocument {
    pub path: Option<String>,
    pub snapshot: DocumentSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub document_id: Option<DocumentId>,
    pub revision: Option<Revision>,
    pub range: Utf16Range,
    pub line: u32,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CloseAction {
    Save,
    Discard,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub document_id: DocumentId,
    pub path: Option<String>,
    pub revision: Revision,
    pub conflict: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceEvent {
    ExternalChange {
        document_id: DocumentId,
        path: String,
        dirty: bool,
        deleted: bool,
    },
    Snapshot(DocumentSnapshot),
    Saved(SaveResult),
    Error {
        document_id: DocumentId,
        error: WorkspaceError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    pub path: String,
    pub snapshot: DocumentSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NvimConfig {
    pub path: Option<String>,
    pub errors: Vec<String>,
    /// Copy selectors read from the active vimrc. Values use Neovim key
    /// notation (for example `<F6>`), so the shell can compare them with its
    /// serialized DOM key events without inventing a second mapping language.
    pub copy_keys: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CopyFormat {
    Markdown,
    Text,
    Rich,
    Html,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct YankCopy {
    pub format: CopyFormat,
    /// Exact native TextYankPost contents, including linewise newlines.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VimInputResult {
    pub snapshot: DocumentSnapshot,
    pub copy: Option<YankCopy>,
    pub copy_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GridUpdate {
    pub document_id: DocumentId,
    pub revision: Revision,
    #[ts(type = "unknown[]")]
    pub updates: Vec<serde_json::Value>,
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
        WorkspaceError::decl(&cfg),
        WorkspaceInfo::decl(&cfg),
        WorkspaceEntry::decl(&cfg),
        OpenDocument::decl(&cfg),
        SearchMatch::decl(&cfg),
        CloseAction::decl(&cfg),
        RecoveryEntry::decl(&cfg),
        WorkspaceEvent::decl(&cfg),
        ImageData::decl(&cfg),
        PasteResult::decl(&cfg),
        NvimConfig::decl(&cfg),
        CopyFormat::decl(&cfg),
        YankCopy::decl(&cfg),
        VimInputResult::decl(&cfg),
        GridUpdate::decl(&cfg),
    ];
    let mut output = "// Generated from src-tauri/src/contracts.rs. Run npm run contracts:generate.\n// Do not edit by hand. Global offsets count UTF-16 code units; ranges are [start, end).\n".to_owned();
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
}
