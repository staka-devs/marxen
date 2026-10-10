//! Deterministic AI validation, ACP envelopes, SSE decoding, and proposal rules.
use crate::contracts::ai::*;
use crate::contracts::Utf16Range;
use crate::domain::validation::validate_document_id;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
pub const MAX_PROMPT_CHARS: usize = 20_000;
pub const MAX_HISTORY_MESSAGES: usize = 32;
pub const MAX_HISTORY_CHARS: usize = 20_000;
pub const MAX_CONTEXTS: usize = 16;
pub const MAX_RANGES_PER_CONTEXT: usize = 32;
pub const MAX_EXCERPT_BYTES: usize = 512_000;
pub const MAX_SECRET_BYTES: usize = 8_192;
pub const MAX_ARGV_ARGS: usize = 64;
pub const MAX_ARGV_ARG_BYTES: usize = 4_096;
pub const MAX_COMMAND_BYTES: usize = 512;
pub const ACP_DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
pub const HTTP_TEST_TIMEOUT: Duration = Duration::from_secs(20);

fn invalid(detail: impl Into<String>) -> AiError {
    AiError::InvalidConfig {
        detail: detail.into(),
    }
}

fn validate_handle(id: &str, what: &str) -> Result<(), AiError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid(format!("{what} は 1〜128 文字の英数字・-・_ です")));
    }
    Ok(())
}

pub fn validate_copy_id(id: &IsolatedCopyId) -> Result<(), AiError> {
    validate_handle(&id.0, "隔離コピーの ID")
}

pub fn validate_session_id(id: &AcpSessionId) -> Result<(), AiError> {
    validate_handle(&id.0, "ACP セッション ID")
}

pub fn validate_run_id(id: &AiRunId) -> Result<(), AiError> {
    validate_handle(&id.0, "実行 ID")
}

fn basename_of(command: &str) -> &str {
    command.rsplit(['/', '\\']).next().unwrap_or(command)
}

/// Claude Code must never be launched from a preset or custom argv.
pub fn is_claude_command(command: &str) -> bool {
    let base = basename_of(command);
    let stem = base
        .strip_suffix(".exe")
        .unwrap_or(base)
        .to_ascii_lowercase();
    stem == "claude" || stem == "claude-code"
}

pub fn preset_argv(preset: AcpPreset) -> AcpArgv {
    match preset {
        // Official adapter package @agentclientprotocol/codex-acp.
        // The binary must already be installed; never auto-downloaded.
        // Never `codex acp`: that subcommand does not exist.
        AcpPreset::Codex => AcpArgv {
            command: "codex-acp".into(),
            args: vec![],
        },
        // Per https://opencode.ai/docs/acp/ : `opencode acp`.
        AcpPreset::Opencode => AcpArgv {
            command: "opencode".into(),
            args: vec!["acp".into()],
        },
        AcpPreset::Custom => AcpArgv {
            command: String::new(),
            args: Vec::new(),
        },
    }
}

pub fn validate_argv(argv: &AcpArgv) -> Result<(), AiError> {
    if argv.command.is_empty() || argv.command.len() > MAX_COMMAND_BYTES {
        return Err(invalid("コマンドは 1〜512 バイトで指定します"));
    }
    if argv.command.bytes().any(|b| b == 0) {
        return Err(invalid("コマンドに NUL 文字は使えません"));
    }
    if is_claude_command(&argv.command) {
        return Err(AiError::ClaudeCodeRefused {
            command: argv.command.clone(),
        });
    }
    if argv.args.len() > MAX_ARGV_ARGS {
        return Err(invalid("引数は 64 個までです"));
    }
    for arg in &argv.args {
        if arg.len() > MAX_ARGV_ARG_BYTES || arg.bytes().any(|b| b == 0) {
            return Err(invalid("引数が長すぎるか NUL 文字を含みます"));
        }
    }
    Ok(())
}

/// Resolve the effective argv. Preset binaries are user-installed; a missing
/// binary surfaces as MissingBinary only when actually spawned or probed.
pub fn resolve_acp_argv(config: &AcpConfig) -> Result<AcpArgv, AiError> {
    match config.preset {
        AcpPreset::Custom => match &config.argv {
            Some(argv) => {
                validate_argv(argv)?;
                Ok(argv.clone())
            }
            None => Err(invalid("カスタム preset にはコマンドと引数が必要です")),
        },
        preset => {
            if config.argv.is_some() {
                return Err(invalid("preset 固定の引数は変更できません"));
            }
            Ok(preset_argv(preset))
        }
    }
}

/// Presence of the agent binary without spawning it.
pub fn validate_endpoint(endpoint: &str) -> Result<String, AiError> {
    let rest = endpoint
        .strip_prefix("http://")
        .or_else(|| endpoint.strip_prefix("https://"))
        .ok_or_else(|| invalid("endpoint は http:// または https:// です"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    if host.is_empty() || endpoint.bytes().any(|b| b.is_ascii_whitespace()) {
        return Err(invalid("endpoint の形式が正しくありません"));
    }
    if endpoint.contains('@') {
        return Err(invalid("endpoint に認証情報を含めないでください"));
    }
    Ok(endpoint.trim_end_matches('/').to_owned())
}

pub fn validate_model(model: &str) -> Result<(), AiError> {
    if model.is_empty() || model.len() > 256 || model.bytes().any(|b| b == 0 || b == b'\n') {
        return Err(invalid("model は 1〜256 文字で指定します"));
    }
    Ok(())
}

pub fn validate_provider_config(config: &AiProviderConfig) -> Result<(), AiError> {
    match config.kind {
        AiProviderKind::Acp => {
            if config.openai.is_some() || config.anthropic.is_some() {
                return Err(invalid("ACP には他の backend 設定を付けません"));
            }
            let acp = config
                .acp
                .as_ref()
                .ok_or_else(|| invalid("ACP の設定が必要です"))?;
            resolve_acp_argv(acp).map(|_| ())
        }
        AiProviderKind::OpenaiCompatible => {
            if config.acp.is_some() || config.anthropic.is_some() {
                return Err(invalid("OpenAI 互換には他の backend 設定を付けません"));
            }
            let openai = config
                .openai
                .as_ref()
                .ok_or_else(|| invalid("OpenAI 互換の設定が必要です"))?;
            validate_endpoint(&openai.endpoint)?;
            validate_model(&openai.model)
        }
        AiProviderKind::Anthropic => {
            if config.acp.is_some() || config.openai.is_some() {
                return Err(invalid("Anthropic には他の backend 設定を付けません"));
            }
            let anthropic = config
                .anthropic
                .as_ref()
                .ok_or_else(|| invalid("Anthropic の設定が必要です"))?;
            if !anthropic.enabled {
                return Err(invalid("Anthropic は opt-in です。有効化してから使います"));
            }
            validate_endpoint(&anthropic.endpoint)?;
            validate_model(&anthropic.model)
        }
    }
}

pub fn validate_history(history: &[ChatHistoryMessage]) -> Result<(), AiError> {
    if history.len() > MAX_HISTORY_MESSAGES {
        return Err(invalid("履歴は 32 件までです"));
    }
    for message in history {
        let chars = message.text.chars().count();
        if message.text.trim().is_empty() || chars > MAX_HISTORY_CHARS {
            return Err(invalid("履歴の1件は 1〜20000 文字です"));
        }
        if message.text.bytes().any(|b| b == 0) {
            return Err(invalid("履歴に NUL 文字は使えません"));
        }
    }
    Ok(())
}

pub fn validate_prompt_request(request: &AiPromptRequest) -> Result<(), AiError> {
    validate_provider_config(&request.provider)?;
    let prompt_chars = request.prompt.chars().count();
    if request.prompt.trim().is_empty() || prompt_chars > MAX_PROMPT_CHARS {
        return Err(invalid("プロンプトは 1〜20000 文字です"));
    }
    validate_history(&request.history)?;
    if request.contexts.len() > MAX_CONTEXTS {
        return Err(invalid("送信対象は 16 件までです"));
    }
    let needs_session = matches!(request.provider.kind, AiProviderKind::Acp);
    match (&request.session_id, needs_session) {
        (Some(id), true) => validate_session_id(id)?,
        (Some(_), false) => {
            return Err(invalid("HTTP backend に session_id は不要です"));
        }
        (None, _) => {}
    }
    validate_copy_id(&request.staging.copy_id)?;
    // Ranges are source-document UTF-16 offsets, not excerpt offsets: an
    // excerpt may be shorter than the document, so only structural checks
    // (ordering) happen here. Authority checks (ranges, excerpts, revisions
    // against the captured Rust snapshots) run in the production paths via
    // IsolationManager::authorize_prompt before any side effect.
    for context in &request.contexts {
        validate_document_id(&context.document_id)
            .map_err(|_| invalid("文書 ID が正しくありません"))?;
        if context.ranges.is_empty() || context.ranges.len() > MAX_RANGES_PER_CONTEXT {
            return Err(invalid("範囲は 1〜32 個です"));
        }
        if context.text.len() > MAX_EXCERPT_BYTES {
            return Err(invalid("送信抜粋が大きすぎます"));
        }
        for range in &context.ranges {
            if range.start.0 > range.end.0 {
                return Err(invalid("範囲の開始は終了以下です"));
            }
        }
    }
    Ok(())
}

fn mode_instruction(mode: PromptMode) -> &'static str {
    match mode {
        PromptMode::Ask => "文書について質問に回答してください。編集中の文書は変更しません。",
        PromptMode::Generate => {
            "文書の続きや新規文書を生成してください。編集中の文書は変更しません。"
        }
        PromptMode::Rewrite => {
            "指定範囲の書き換え案を提示してください。編集中の文書は変更しません。"
        }
        PromptMode::Workspace => {
            "作業コピー内の修正案を提示してください。提案テキストのみを返し、直接書き込みません。"
        }
    }
}

fn format_ranges(ranges: &[Utf16Range]) -> String {
    ranges
        .iter()
        .map(|range| format!("[{}, {})", range.start.0, range.end.0))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Deterministic user message. Tests assert this exact shape as "what was sent".
/// History (completed turns only, oldest first) is rendered explicitly between
/// the mode instruction and the current contexts so ACP agents see the same
/// multi-turn scope without session resume.
pub fn compose_user_message(mode: PromptMode, prompt: &str, contexts: &[PromptContext]) -> String {
    compose_user_message_with_history(mode, prompt, contexts, &[])
}

pub fn compose_user_message_with_history(
    mode: PromptMode,
    prompt: &str,
    contexts: &[PromptContext],
    history: &[ChatHistoryMessage],
) -> String {
    let mut out = String::from(mode_instruction(mode));
    out.push('\n');
    for message in history {
        let role = match message.role {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        };
        out.push_str(&format!("--- history {role} ---\n"));
        out.push_str(&message.text);
        if !message.text.ends_with('\n') {
            out.push('\n');
        }
    }
    for context in contexts {
        out.push_str(&format!(
            "--- context document={} revision={} ranges={} ---\n",
            context.document_id.0,
            context.revision.0,
            format_ranges(&context.ranges)
        ));
        out.push_str(&context.text);
        if !context.text.ends_with('\n') {
            out.push('\n');
        }
    }
    out.push_str("--- prompt ---\n");
    out.push_str(prompt);
    out
}

pub fn summarize_contexts(request: &AiPromptRequest) -> Vec<ContextSummary> {
    request
        .contexts
        .iter()
        .map(|context| ContextSummary {
            document_id: context.document_id.clone(),
            revision: context.revision,
            ranges: context.ranges.clone(),
            chars: context.text.chars().count() as u32,
        })
        .collect()
}

pub fn proposal_from_text(text: String, request: &AiPromptRequest) -> ProposalText {
    ProposalText {
        text,
        base_contexts: request
            .contexts
            .iter()
            .map(|context| ContextRef {
                document_id: context.document_id.clone(),
                revision: context.revision,
            })
            .collect(),
    }
}

// ---- Server-sent events (shared by OpenAI-compatible and Anthropic) ----

/// Incremental SSE decoder tolerant to chunked HTTP bodies.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
}

fn split_boundary(buffer: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < buffer.len() {
        if buffer[i] == b'\n' && buffer[i + 1] == b'\n' {
            return Some(i + 2);
        }
        if i + 3 < buffer.len()
            && buffer[i] == b'\r'
            && buffer[i + 1] == b'\n'
            && buffer[i + 2] == b'\r'
            && buffer[i + 3] == b'\n'
        {
            return Some(i + 4);
        }
        i += 1;
    }
    None
}

fn event_data(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let mut data = String::new();
    let mut has_data = false;
    for line in text.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            has_data = true;
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest);
        }
    }
    has_data.then_some(data)
}

impl SseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = split_boundary(&self.buf) {
            let raw: Vec<u8> = self.buf.drain(..end).collect();
            if let Some(data) = event_data(&raw) {
                events.push(data);
            }
        }
        events
    }

    pub fn finish(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let raw = std::mem::take(&mut self.buf);
        event_data(&raw)
    }
}

pub fn is_stream_done(data: &str) -> bool {
    data.trim() == "[DONE]"
}

fn http_error(status: u16, body: &str) -> AiError {
    let excerpt: String = body.chars().take(300).collect();
    if status == 401 || status == 403 {
        return AiError::AuthFailed {
            detail: format!("認証に失敗しました (HTTP {status}): {excerpt}"),
        };
    }
    AiError::ConnectionFailed {
        detail: format!("HTTP {status}: {excerpt}"),
    }
}

pub fn map_http_status(status: u16, body: &str) -> Option<AiError> {
    if (200..300).contains(&status) {
        None
    } else {
        Some(http_error(status, body))
    }
}

/// Extract streamed text from an OpenAI-compatible chat chunk.
pub fn openai_delta_text(data: &str) -> Result<Option<String>, AiError> {
    let value: serde_json::Value =
        serde_json::from_str(data).map_err(|_| AiError::StreamFailed {
            detail: "OpenAI 互換の応答を解釈できません".into(),
        })?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(|message| message.as_str())
            .unwrap_or("unknown error");
        let code = error
            .get("code")
            .and_then(|code| code.as_str())
            .unwrap_or("");
        if message.contains("401")
            || message.contains("unauthorized")
            || message.contains("invalid_api_key")
            || code.contains("invalid_api_key")
            || code.contains("unauthorized")
        {
            return Err(AiError::AuthFailed {
                detail: message.to_owned(),
            });
        }
        return Err(AiError::StreamFailed {
            detail: message.to_owned(),
        });
    }
    Ok(value
        .pointer("/choices/0/delta/content")
        .and_then(|content| content.as_str())
        .map(str::to_owned))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnthropicSignal {
    Text(String),
    End,
    Ignore,
}

/// Extract streamed text from an Anthropic Messages SSE envelope.
pub fn anthropic_signal(data: &str) -> Result<AnthropicSignal, AiError> {
    let value: serde_json::Value =
        serde_json::from_str(data).map_err(|_| AiError::StreamFailed {
            detail: "Anthropic の応答を解釈できません".into(),
        })?;
    let kind = value
        .get("type")
        .and_then(|kind| kind.as_str())
        .unwrap_or("");
    match kind {
        "content_block_delta" => {
            let delta = value.get("delta");
            let delta_type = delta
                .and_then(|delta| delta.get("type"))
                .and_then(|kind| kind.as_str())
                .unwrap_or("");
            if delta_type == "text_delta" {
                if let Some(text) = delta
                    .and_then(|delta| delta.get("text"))
                    .and_then(|text| text.as_str())
                {
                    return Ok(AnthropicSignal::Text(text.to_owned()));
                }
            }
            Ok(AnthropicSignal::Ignore)
        }
        "message_stop" => Ok(AnthropicSignal::End),
        "error" => {
            let error = &value["error"];
            let message = error
                .get("message")
                .and_then(|message| message.as_str())
                .unwrap_or("unknown error");
            let kind = error
                .get("type")
                .and_then(|kind| kind.as_str())
                .unwrap_or("");
            if kind == "authentication_error" || kind == "permission_error" {
                return Err(AiError::AuthFailed {
                    detail: message.to_owned(),
                });
            }
            Err(AiError::StreamFailed {
                detail: message.to_owned(),
            })
        }
        _ => Ok(AnthropicSignal::Ignore),
    }
}

// ---- ACP stdio transport: newline-delimited compact UTF-8 JSON-RPC ----
// Official transport (https://agentclientprotocol.com/protocol/v1/transports):
// one compact JSON value per line, no embedded newlines, UTF-8 only.
// Content-Length framing is NOT used and is rejected by compliant agents.

/// Maximum size of one NDJSON line (8 MiB). Larger lines are stream errors.
pub const ACP_PROTOCOL_VERSION: u32 = 1;

pub fn client_info() -> serde_json::Value {
    serde_json::json!({
        "name": "marxen",
        "title": "Marxen",
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// Encode one ACP message: compact JSON plus a single `\n`.
/// serde_json never emits raw newlines inside strings, so the framing holds.
pub fn encode_acp_message(value: &serde_json::Value) -> Vec<u8> {
    let mut out = serde_json::to_vec(value).expect("ACP message serializes");
    out.push(b'\n');
    out
}

/// Incremental NDJSON reader. Handles fragmentation (splits mid-line and
/// mid-UTF-8), coalescing (several lines per read), CRLF tolerance, and
/// skips stray empty lines. Anything else is an explicit stream error.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentIncoming {
    /// Response to our request (`id` present, no `method`).
    Response { id: serde_json::Value, body: Value },
    /// Notification from the agent (no `id`).
    Notification(Value),
    /// Request from the agent that needs our response (`id` and `method`).
    AgentRequest {
        id: serde_json::Value,
        method: String,
        params: Value,
    },
}

pub fn classify_incoming(message: Value) -> Result<AgentIncoming, AiError> {
    let id = message.get("id");
    let method = message.get("method").and_then(|method| method.as_str());
    match (id, method) {
        (Some(id), Some(method)) if !id.is_null() => Ok(AgentIncoming::AgentRequest {
            id: id.clone(),
            method: method.to_owned(),
            params: message.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(id), None) if !id.is_null() => Ok(AgentIncoming::Response {
            id: id.clone(),
            body: message,
        }),
        (None | Some(_), _) if message.get("method").is_some() => {
            Ok(AgentIncoming::Notification(message))
        }
        _ => Err(AiError::StreamFailed {
            detail: "ACP の応答を解釈できません".into(),
        }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
}

pub fn parse_stop_reason(body: &Value) -> Result<StopReason, AiError> {
    match body
        .pointer("/result/stopReason")
        .and_then(|reason| reason.as_str())
    {
        Some("end_turn") => Ok(StopReason::EndTurn),
        Some("max_tokens") => Ok(StopReason::MaxTokens),
        Some("max_turn_requests") => Ok(StopReason::MaxTurnRequests),
        Some("refusal") => Ok(StopReason::Refusal),
        Some("cancelled") => Ok(StopReason::Cancelled),
        _ => Err(AiError::StreamFailed {
            detail: "prompt が stopReason を返しませんでした".into(),
        }),
    }
}

/// How to answer an inbound `session/request_permission`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionAnswer {
    /// No approval UI exists, so deny by selecting a reject option.
    Deny,
    /// The turn is being cancelled; answer with the `cancelled` outcome.
    Cancelled,
}

/// Build the `result` payload answering `session/request_permission`.
/// Exact shapes per the official schema: `{outcome: {outcome: "selected",
/// optionId}}` or `{outcome: {outcome: "cancelled"}}`.
pub fn answer_permission(params: &Value, mode: PermissionAnswer) -> Value {
    if mode == PermissionAnswer::Cancelled {
        return serde_json::json!({ "outcome": { "outcome": "cancelled" } });
    }
    let options = params.get("options").and_then(|options| options.as_array());
    let pick = |kind: &str| {
        options?.iter().find_map(|option| {
            (option.get("kind")?.as_str()? == kind)
                .then(|| option.get("optionId")?.as_str())
                .flatten()
                .map(str::to_owned)
        })
    };
    if let Some(option_id) = pick("reject_once").or_else(|| pick("reject_always")) {
        return serde_json::json!({
            "outcome": { "outcome": "selected", "optionId": option_id }
        });
    }
    serde_json::json!({ "outcome": { "outcome": "cancelled" } })
}

/// JSON-RPC error for agent methods this client does not implement
/// (fs/*, terminal/*, elicitation/*: no client capabilities are advertised).
pub fn method_not_found(id: &Value, method: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32601,
            "message": format!("method not supported: {method}")
        }
    })
}

pub fn acp_initialize(id: u64) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {},
            "clientInfo": client_info(),
        }
    })
}

/// Negotiate the protocol version. Anything but v1 is an explicit error.
pub fn check_protocol_version(body: &Value) -> Result<u32, AiError> {
    let version = body
        .pointer("/result/protocolVersion")
        .and_then(|version| version.as_u64())
        .ok_or_else(|| AiError::StreamFailed {
            detail: "initialize が protocolVersion を返しませんでした".into(),
        })?;
    let version = u32::try_from(version).map_err(|_| AiError::StreamFailed {
        detail: "protocolVersion が大きすぎます".into(),
    })?;
    if version != ACP_PROTOCOL_VERSION {
        return Err(AiError::UnsupportedProtocol { version });
    }
    Ok(version)
}

pub fn acp_session_new(id: u64, staging_dir: &Path) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/new",
        "params": { "cwd": staging_dir.to_string_lossy(), "mcpServers": [] }
    })
}

pub fn acp_session_prompt(
    id: u64,
    session_id: &str,
    mode: PromptMode,
    prompt: &str,
    contexts: &[PromptContext],
) -> serde_json::Value {
    acp_session_prompt_with_history(id, session_id, mode, prompt, contexts, &[])
}

pub fn acp_session_prompt_with_history(
    id: u64,
    session_id: &str,
    mode: PromptMode,
    prompt: &str,
    contexts: &[PromptContext],
    history: &[ChatHistoryMessage],
) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": compose_user_message_with_history(mode, prompt, contexts, history) }]
        }
    })
}

/// `session/cancel` is a notification: no `id`, no response expected.
/// The agent answers by responding to `session/prompt` with stopReason
/// `cancelled`.
pub fn acp_session_cancel_notification(session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id }
    })
}

/// Pull streamed agent text out of a `session/update` notification.
pub fn acp_update_text(message: &serde_json::Value) -> Option<String> {
    if message.get("method")?.as_str()? != "session/update" {
        return None;
    }
    let update = message.pointer("/params/update")?;
    match update.get("sessionUpdate")?.as_str()? {
        "agent_message_chunk" => update
            .pointer("/content/text")
            .and_then(|text| text.as_str())
            .map(str::to_owned),
        _ => None,
    }
}

// ---- ACP session lifecycle tracker ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpPhase {
    Idle,
    Initialized,
    Ready,
    Prompting,
}

#[derive(Debug)]
pub struct AcpSessionTracker {
    phase: AcpPhase,
    session: Option<String>,
}

impl AcpSessionTracker {
    pub fn new() -> Self {
        Self {
            phase: AcpPhase::Idle,
            session: None,
        }
    }

    pub fn phase(&self) -> AcpPhase {
        self.phase
    }

    pub fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }

    pub fn initialized(&mut self) {
        if self.phase == AcpPhase::Idle {
            self.phase = AcpPhase::Initialized;
        }
    }

    pub fn session_opened(&mut self, session_id: String) {
        self.session = Some(session_id);
        self.phase = AcpPhase::Ready;
    }

    pub fn prompt_started(&mut self, session_id: Option<&str>) -> Result<(), AiError> {
        if self.phase == AcpPhase::Prompting {
            return Err(AiError::SessionBusy);
        }
        if self.phase != AcpPhase::Ready {
            return Err(AiError::SessionRequired);
        }
        if let Some(wanted) = session_id {
            if self.session.as_deref() != Some(wanted) {
                return Err(AiError::UnknownSession);
            }
        }
        self.phase = AcpPhase::Prompting;
        Ok(())
    }

    pub fn prompt_finished(&mut self) {
        if self.phase == AcpPhase::Prompting {
            self.phase = AcpPhase::Ready;
        }
    }
}

impl Default for AcpSessionTracker {
    fn default() -> Self {
        Self::new()
    }
}

// ---- OS credential store ----

pub fn credential_account(kind: AiProviderKind) -> &'static str {
    match kind {
        AiProviderKind::Acp => "ai/acp",
        AiProviderKind::OpenaiCompatible => "ai/openai-compatible",
        AiProviderKind::Anthropic => "ai/anthropic",
    }
}

pub fn validate_secret(secret: &str) -> Result<(), AiError> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        return Err(invalid("資格情報は 1〜8192 バイトです"));
    }
    Ok(())
}

pub enum HttpBackend {
    OpenAi,
    Anthropic,
}

pub struct HttpTarget {
    pub url: String,
    pub model: String,
    pub backend: HttpBackend,
}

pub fn http_target(config: &AiProviderConfig) -> Result<HttpTarget, AiError> {
    match config.kind {
        AiProviderKind::OpenaiCompatible => {
            let openai = config
                .openai
                .as_ref()
                .ok_or_else(|| invalid("OpenAI 互換の設定が必要です"))?;
            let base = validate_endpoint(&openai.endpoint)?;
            validate_model(&openai.model)?;
            Ok(HttpTarget {
                url: format!("{base}/chat/completions"),
                model: openai.model.clone(),
                backend: HttpBackend::OpenAi,
            })
        }
        AiProviderKind::Anthropic => {
            let anthropic = config
                .anthropic
                .as_ref()
                .ok_or_else(|| invalid("Anthropic の設定が必要です"))?;
            if !anthropic.enabled {
                return Err(invalid("Anthropic は opt-in です。有効化してから使います"));
            }
            let base = validate_endpoint(&anthropic.endpoint)?;
            validate_model(&anthropic.model)?;
            Ok(HttpTarget {
                url: format!("{base}/messages"),
                model: anthropic.model.clone(),
                backend: HttpBackend::Anthropic,
            })
        }
        AiProviderKind::Acp => Err(invalid("ACP には HTTP driver を使いません")),
    }
}

pub(crate) fn history_messages(history: &[ChatHistoryMessage]) -> Vec<serde_json::Value> {
    history
        .iter()
        .map(|message| {
            let role = match message.role {
                ChatRole::User => "user",
                ChatRole::Assistant => "assistant",
            };
            serde_json::json!({ "role": role, "content": message.text })
        })
        .collect()
}

pub(crate) fn openai_body(request: &AiPromptRequest, model: &str) -> serde_json::Value {
    let mut messages = history_messages(&request.history);
    messages.push(serde_json::json!({
        "role": "user",
        "content": compose_user_message_with_history(request.mode, &request.prompt, &request.contexts, &[])
    }));
    serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages
    })
}

pub(crate) fn anthropic_body(request: &AiPromptRequest, model: &str) -> serde_json::Value {
    let mut messages = history_messages(&request.history);
    messages.push(serde_json::json!({
        "role": "user",
        "content": compose_user_message_with_history(request.mode, &request.prompt, &request.contexts, &[])
    }));
    serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        "stream": true,
        "system": mode_instruction(request.mode),
        "messages": messages
    })
}

pub fn error_detail(error: &AiError) -> String {
    match error {
        AiError::InvalidConfig { detail }
        | AiError::SpawnFailed { detail }
        | AiError::ConnectionFailed { detail }
        | AiError::AuthFailed { detail }
        | AiError::StreamFailed { detail } => detail.clone(),
        AiError::MissingBinary { command } => format!("{command} が見つかりません"),
        AiError::MissingCredentials { .. } => "資格情報がありません".into(),
        AiError::RequestCancelled => "取り消しました".into(),
        AiError::SessionRequired => "セッションが必要です".into(),
        AiError::SessionBusy => "実行中です".into(),
        AiError::UnknownSession => "不明なセッションです".into(),
        AiError::StagingUnresolved { .. } => "作業コピーを解決できません".into(),
        AiError::LiveTargetRejected { detail } => detail.clone(),
        AiError::UnsupportedProtocol { version } => {
            format!("protocol version {version} には未対応です")
        }
        AiError::ClaudeCodeRefused { command } => format!("{command} は起動しません"),
        AiError::CredentialStoreFailed { detail } => detail.clone(),
    }
}
