//! AI IPC data exported separately from document contracts.
//!
//! Rust owns this definition; export-ai-contracts generates TypeScript into
//! src/contracts/ai-contracts.ts. JSON fields are camelCase, enum values are
//! snake_case. AI schema version is independent from the document contract.
//!
//! Rules enforced by these contracts and the AI use cases:
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
pub const AI_CONTRACT_VERSION: u32 = 5;

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

/// Where a usage report was observed on the ACP wire. Only official fields
/// are recorded; arbitrary `_meta` names are never scraped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AcpUsageSource {
    UsageUpdate,
    PromptResponse,
}

/// Honestly reported scope of a usage figure. `Session` covers cumulative
/// session figures from `usage_update` (context occupancy plus session cost).
/// `PromptResponseUndefined` marks unstable `PromptResponse.usage`, whose
/// turn-versus-session scope differs across implementations (official ACP
/// issue #1860); such reports are never summed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AcpUsageScope {
    Session,
    PromptResponseUndefined,
}

/// Cumulative session cost exactly as reported. The decimal amount is kept as
/// text so the `Eq` contract holds without binary float rounding; it is never
/// derived from token counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageCost {
    /// Decimal amount text from the validated wire number (for example `"12.34"`).
    pub amount: String,
    /// ISO 4217 code as reported (for example `"USD"`).
    pub currency: String,
}

/// Latest reported usage for one public provider/run/session. Every optional
/// counter is absent when unreported, never zero-filled or estimated. Quota,
/// reset time, credit consumption, and Copilot credits have no standardized
/// ACP fields and stay absent here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportedUsage {
    pub provider: AiProviderKind,
    /// ACP preset that produced the report, when the provider is ACP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preset: Option<AcpPreset>,
    pub run_id: AiRunId,
    pub session_id: AcpSessionId,
    pub source: AcpUsageSource,
    pub scope: AcpUsageScope,
    /// Tokens currently in context (`usage_update.used`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub used: Option<u64>,
    /// Total context window size in tokens (`usage_update.size`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub size: Option<u64>,
    /// Reported input tokens (`PromptResponse.usage.inputTokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub input_tokens: Option<u64>,
    /// Reported output tokens (`PromptResponse.usage.outputTokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub output_tokens: Option<u64>,
    /// Reported total tokens (`PromptResponse.usage.totalTokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub total_tokens: Option<u64>,
    /// Reported cache-read tokens (`PromptResponse.usage.cachedReadTokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cached_read_tokens: Option<u64>,
    /// Reported cache-write tokens (`PromptResponse.usage.cachedWriteTokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cached_write_tokens: Option<u64>,
    /// Reported reasoning tokens (official `thoughtTokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub reasoning_tokens: Option<u64>,
    /// Cumulative session cost exactly as reported in `usage_update.cost`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost: Option<UsageCost>,
    /// Unix milliseconds when Rust received the report.
    #[ts(type = "number")]
    pub received_ms: u64,
}

/// A quota window reported by Codex, separate from a prompt's context occupancy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageWindow {
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub window_duration_mins: Option<u32>,
    /// Unix seconds reported for the next reset; omitted when unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub resets_at: Option<u64>,
}

/// Provider-reported remaining credit status, without inferred currency or spend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub balance: Option<String>,
}

/// One independently metered Codex bucket from the official account RPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexUsageBucket {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub primary: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub secondary: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credits: Option<UsageCredits>,
}

/// Read-only Codex account usage; credentials and account identity never cross IPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexAccountUsage {
    pub buckets: Vec<CodexUsageBucket>,
    #[ts(type = "number")]
    pub received_ms: u64,
}

/// Nonterminal usage payload. Delivery never settles a run; `Done`, `Error`,
/// and `Cancelled` remain the only terminal events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamUsage {
    pub run_id: AiRunId,
    pub usage: ReportedUsage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Started(StreamStarted),
    Chunk(StreamChunk),
    Usage(StreamUsage),
    Done(StreamDone),
    Error(StreamError),
    Cancelled(StreamCancelled),
}

/// Explicit machine-readable failures mapped to display text by the UI.
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
        StreamUsage::decl(&cfg),
        StreamDone::decl(&cfg),
        StreamError::decl(&cfg),
        StreamCancelled::decl(&cfg),
        AcpUsageSource::decl(&cfg),
        AcpUsageScope::decl(&cfg),
        UsageCost::decl(&cfg),
        ReportedUsage::decl(&cfg),
        UsageWindow::decl(&cfg),
        UsageCredits::decl(&cfg),
        CodexUsageBucket::decl(&cfg),
        CodexAccountUsage::decl(&cfg),
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
