//! AI IPC schema v1. Owned by Issue #7; kept separate from contracts.rs (owned by #3).
//!
//! Rust owns this definition; export-ai-contracts generates TypeScript into
//! src/shared/ai-contracts.ts. JSON fields are camelCase, enum values are
//! snake_case. AI schema version is independent from the document contract.
//!
//! Rules enforced by this schema and src/ai.rs:
//! - There is no Claude Code preset and no preset may launch it.
//! - Transports take argv arrays; no shell interpolation happens anywhere.
//! - Agents only see isolated staging copies (see #8); live documents and
//!   absolute paths never cross this boundary from JavaScript.
//! - Agent output is proposal text with base revisions, never a direct write.
//! - Secrets live in the OS credential store; they never appear on this wire.
use crate::contracts::{DocumentId, Revision, Utf16Range};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Independent version of the AI IPC schema.
pub const AI_CONTRACT_VERSION: u32 = 3;

/// OS credential store layout. Secrets are addressed, never transferred.
pub const SECRET_SERVICE: &str = "dev.staka.marxen";

/// Which backend produced a request. Anthropic is independent and opt-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
    Acp,
    OpenaiCompatible,
    Anthropic,
}

/// ACP agent presets. There is intentionally no Claude Code preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AcpPreset {
    Codex,
    Opencode,
    Copilot,
    Custom,
}

/// argv array for one agent process. Executed directly, never via a shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpArgv {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpConfig {
    pub preset: AcpPreset,
    /// Required exactly when preset is custom.
    pub argv: Option<AcpArgv>,
    /// Explicit choices advertised by this agent; applied before each prompt.
    #[serde(default)]
    #[ts(optional)]
    pub selections: Option<Vec<AcpSelection>>,
}

/// One explicit agent configuration choice; never an unvalidated command argument.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpSelection {
    pub id: String,
    pub value: String,
}

/// A model or reasoning choice published by the connected ACP agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpChoice {
    pub value: String,
    pub name: String,
}

/// Select-only agent controls supported by this client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpConfigOption {
    pub id: String,
    pub name: String,
    pub category: String,
    pub current_value: String,
    pub options: Vec<AcpChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenAiConfig {
    pub endpoint: String,
    pub model: String,
}

/// Anthropic Messages is a separate opt-in backend. `enabled` must be true
/// for any Anthropic request to run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnthropicConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiProviderConfig {
    pub kind: AiProviderKind,
    pub acp: Option<AcpConfig>,
    pub openai: Option<OpenAiConfig>,
    pub anthropic: Option<AnthropicConfig>,
}

/// How the model output is used. Only workspace mode may yield file patches,
/// and those still require reviewed revision application (see #8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PromptMode {
    Ask,
    Generate,
    Rewrite,
    Workspace,
}

/// Exact scope sent to the model: document, revision, ranges, excerpt text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptContext {
    pub document_id: DocumentId,
    pub revision: Revision,
    pub ranges: Vec<Utf16Range>,
    pub text: String,
}

/// Opaque handle of an isolated staging copy owned by #8. Agents never
/// receive live document paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct IsolatedCopyId(pub String);

/// Opaque ACP session handle minted by Rust after `session/new`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AcpSessionId(pub String);

/// Opaque streaming run handle used for progress events and cancel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AiRunId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagingTarget {
    pub copy_id: IsolatedCopyId,
}

/// One completed turn carried explicitly for multi-turn HTTP conversations.
/// Bounded and validated by Rust; cancelled or failed turns are never stored
/// here by the caller. ACP keeps its own session handling and receives the
/// same turns as prompt preamble text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatHistoryMessage {
    pub role: ChatRole,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPromptRequest {
    pub provider: AiProviderConfig,
    pub mode: PromptMode,
    pub prompt: String,
    pub contexts: Vec<PromptContext>,
    pub staging: StagingTarget,
    /// Resume an existing ACP session. Required to be absent for HTTP backends.
    pub session_id: Option<AcpSessionId>,
    /// Explicit multi-turn history (oldest first). Only completed turns;
    /// bounded and validated by Rust before any side effect.
    #[serde(default)]
    pub history: Vec<ChatHistoryMessage>,
}

/// Which snapshot a proposal was derived from. The editor owner (#8) applies
/// proposals only after review and an exact revision check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRef {
    pub document_id: DocumentId,
    pub revision: Revision,
}

/// Model output as reviewable text. Never applied directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalText {
    pub text: String,
    pub base_contexts: Vec<ContextRef>,
}

/// Echo of exactly what was sent, shown in the AI panel next to the answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSummary {
    pub document_id: DocumentId,
    pub revision: Revision,
    pub ranges: Vec<Utf16Range>,
    pub chars: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamStarted {
    pub run_id: AiRunId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamChunk {
    pub run_id: AiRunId,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamDone {
    pub run_id: AiRunId,
    pub proposal: ProposalText,
    pub sent: Vec<ContextSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamError {
    pub run_id: Option<AiRunId>,
    pub error: AiError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamCancelled {
    pub run_id: AiRunId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Started(StreamStarted),
    Chunk(StreamChunk),
    Done(StreamDone),
    Error(StreamError),
    Cancelled(StreamCancelled),
}

/// Explicit machine-readable failures. The panel maps each code to Japanese.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AiError {
    InvalidConfig { detail: String },
    MissingCredentials { provider: AiProviderKind },
    MissingBinary { command: String },
    SpawnFailed { detail: String },
    ConnectionFailed { detail: String },
    AuthFailed { detail: String },
    StreamFailed { detail: String },
    RequestCancelled,
    SessionRequired,
    SessionBusy,
    UnknownSession,
    StagingUnresolved { copy_id: IsolatedCopyId },
    LiveTargetRejected { detail: String },
    UnsupportedProtocol { version: u32 },
    ClaudeCodeRefused { command: String },
    CredentialStoreFailed { detail: String },
}

/// Credential presence only. Values never cross the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialRef {
    pub provider: AiProviderKind,
    pub has_secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiTestResult {
    /// Choices returned by an explicit ACP handshake; absent on local/API checks.
    #[serde(default)]
    #[ts(optional)]
    pub config_options: Option<Vec<AcpConfigOption>>,
    pub ok: bool,
    pub detail: String,
}

/// Return exported AI IPC TypeScript declarations and document-type imports,
/// prefixed with the independent AI schema version; no files are written.
pub fn typescript() -> String {
    let cfg = ts_rs::Config::default();
    let declarations = [
        AiProviderKind::decl(&cfg),
        AcpPreset::decl(&cfg),
        AcpArgv::decl(&cfg),
        AcpConfig::decl(&cfg),
        AcpSelection::decl(&cfg),
        AcpChoice::decl(&cfg),
        AcpConfigOption::decl(&cfg),
        OpenAiConfig::decl(&cfg),
        AnthropicConfig::decl(&cfg),
        AiProviderConfig::decl(&cfg),
        PromptMode::decl(&cfg),
        PromptContext::decl(&cfg),
        IsolatedCopyId::decl(&cfg),
        AcpSessionId::decl(&cfg),
        AiRunId::decl(&cfg),
        StagingTarget::decl(&cfg),
        ChatRole::decl(&cfg),
        ChatHistoryMessage::decl(&cfg),
        AiPromptRequest::decl(&cfg),
        ContextRef::decl(&cfg),
        ProposalText::decl(&cfg),
        ContextSummary::decl(&cfg),
        StreamStarted::decl(&cfg),
        StreamChunk::decl(&cfg),
        StreamDone::decl(&cfg),
        StreamError::decl(&cfg),
        StreamCancelled::decl(&cfg),
        AiStreamEvent::decl(&cfg),
        AiError::decl(&cfg),
        CredentialRef::decl(&cfg),
        AiTestResult::decl(&cfg),
    ];
    let mut output = format!(
        "// Generated from src-tauri/src/contracts/ai.rs. Run npm run ai-contracts:generate.\n// Do not edit by hand. AI IPC schema version {AI_CONTRACT_VERSION}.\n"
    );
    output.push_str("import type { DocumentId, Revision, Utf16Range } from \"./contracts\";\n");
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output
}
