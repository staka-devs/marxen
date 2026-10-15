//! Wire contract v1. Rust owns this definition; export-contracts generates TypeScript.
pub mod ai;
pub mod isolation;
pub mod vim_settings;
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

/// An effective native mapping shown as an explicit lhs-to-rhs pair in editor menus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorMapping {
    pub lhs: String,
    pub rhs: String,
}

/// Runtime opt-in and effective mappings read from the active Neovim configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorPresentation {
    /// True only when Neovim permits modification and the buffer is not marked read-only.
    pub editable: bool,
    pub selection_toolbar: bool,
    pub mappings: Vec<EditorMapping>,
}

/// Revision-bound native selection and mode captured for one editor-menu invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorContext {
    pub cursor: CursorUpdate,
    pub mode: VimMode,
    pub presentation: EditorPresentation,
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
    NotText,
    InvalidUtf8,
    AlreadyExists,
    NotFound,
    NoWorkspace,
    UnknownDocument,
    UnsavedChanges {
        snapshot: DocumentSnapshot,
    },
    Conflict {
        path: String,
    },
    Io {
        detail: String,
    },
    Neovim {
        detail: String,
    },
    Contract {
        error: ContractError,
    },
    InvalidImage,
    /// Invalid, unsupported or over-budget native search pattern.
    SearchPattern,
    /// Search context or source text no longer agrees with the captured result.
    StaleSearch,
    /// A bounded search cannot authorize an exhaustive replacement.
    SearchIncomplete,
}

impl std::fmt::Display for WorkspaceError {
    /// Render the error's debug variant and fields, propagating formatter failures.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for WorkspaceError {}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<WorkspaceFileKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceFileKind {
    Markdown,
    Text,
    Image,
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
    /// Visible portion of this match, relative to the bounded preview in UTF-16.
    pub preview_range: Utf16Range,
    /// Fingerprint of the complete searched text, including closed files.
    pub content_token: String,
}

/// Native matching flags; regular expressions follow regex 1.13.1 syntax.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

impl Default for SearchOptions {
    /// Default to literal, Unicode case-insensitive substring search.
    fn default() -> Self {
        Self {
            case_sensitive: false,
            whole_word: false,
            regex: false,
        }
    }
}

/// Explicit reason a search result is incomplete, never an exact total count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SearchLimit {
    Matches,
    Candidates,
    FileBytes,
    WorkspaceBytes,
    Files,
    Time,
}

/// Bounded search results whose completeness gates all-replacement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    pub limit: Option<SearchLimit>,
}

/// Captured search context for a native revision-bound replacement plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchReplaceRequest {
    pub root: String,
    pub path: String,
    pub query: String,
    pub options: SearchOptions,
    pub replacement: String,
    pub content_token: String,
    pub revision: Option<Revision>,
    /// Null plans all matches in this unchanged file; otherwise selects the exact hit.
    pub range: Option<Utf16Range>,
}

/// Native document and exact edits; applying them still requires the snapshot revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchReplacePlan {
    pub document: OpenDocument,
    pub edits: Vec<TextEdit>,
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

/// Return the document/workspace contract declarations as exported TypeScript
/// with the generation notice and UTF-16 range convention; no files are written.
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
        EditorMapping::decl(&cfg),
        EditorPresentation::decl(&cfg),
        EditorContext::decl(&cfg),
        VimMode::decl(&cfg),
        ModeUpdate::decl(&cfg),
        DocumentEvent::decl(&cfg),
        ConnectionState::decl(&cfg),
        RuntimeStatus::decl(&cfg),
        ContractError::decl(&cfg),
        WorkspaceError::decl(&cfg),
        WorkspaceInfo::decl(&cfg),
        WorkspaceFileKind::decl(&cfg),
        WorkspaceEntry::decl(&cfg),
        OpenDocument::decl(&cfg),
        SearchMatch::decl(&cfg),
        SearchOptions::decl(&cfg),
        SearchLimit::decl(&cfg),
        SearchResults::decl(&cfg),
        SearchReplaceRequest::decl(&cfg),
        SearchReplacePlan::decl(&cfg),
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
    let mut output = "// Generated from src-tauri/src/contracts/mod.rs. Run npm run contracts:generate.\n// Do not edit by hand. Global offsets count UTF-16 code units; ranges are [start, end).\n".to_owned();
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
}
