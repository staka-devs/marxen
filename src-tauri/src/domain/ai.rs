//! Deterministic AI validation, ACP envelopes, SSE decoding, and proposal rules.
use crate::contracts::ai::*;
use crate::contracts::Utf16Range;
use crate::domain::validation::validate_document_id;
use serde_json::Value;
use std::path::Path;
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

/// Preserve a validation explanation as an `InvalidConfig` error.
fn invalid(detail: impl Into<String>) -> AiError {
    AiError::InvalidConfig {
        detail: detail.into(),
    }
}

/// Require a 1–128-byte ASCII alphanumeric/hyphen/underscore handle.
/// Invalid input yields `InvalidConfig` with the supplied handle label.
pub(crate) fn validate_handle(id: &str, what: &str) -> Result<(), AiError> {
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

/// Validate the opaque staging-copy handle before it can be resolved.
pub fn validate_copy_id(id: &IsolatedCopyId) -> Result<(), AiError> {
    validate_handle(&id.0, "隔離コピーの ID")
}

/// Require the ACP session handle to use the bounded ASCII handle syntax.
pub fn validate_session_id(id: &AcpSessionId) -> Result<(), AiError> {
    validate_handle(&id.0, "ACP セッション ID")
}

/// Require a streaming run handle to use the bounded ASCII handle syntax.
pub fn validate_run_id(id: &AiRunId) -> Result<(), AiError> {
    validate_handle(&id.0, "実行 ID")
}

/// Take the final command-path component using either slash convention.
fn basename_of(command: &str) -> &str {
    command.rsplit(['/', '\\']).next().unwrap_or(command)
}

/// Recognize `claude`/`claude-code` basenames after removing a literal `.exe`
/// suffix and folding ASCII case, for rejection before process launch.
pub fn is_claude_command(command: &str) -> bool {
    let base = basename_of(command);
    let stem = base
        .strip_suffix(".exe")
        .unwrap_or(base)
        .to_ascii_lowercase();
    stem == "claude" || stem == "claude-code"
}

/// Return `codex-acp`, `opencode acp`, or an empty custom-command template.
/// This constructs argv only; it neither discovers nor installs an executable.
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
        AcpPreset::Copilot => AcpArgv {
            command: "copilot".into(),
            args: vec!["--acp".into(), "--stdio".into()],
        },
        AcpPreset::Custom => AcpArgv {
            command: String::new(),
            args: Vec::new(),
        },
    }
}

/// Bound the command to 1–512 bytes, at most 64 args, and 4096 bytes per arg.
/// Reject NULs and recognized Claude Code commands; no process is launched.
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
    if let Some(selected) = &config.selections {
        if selected.len() > 8 {
            return Err(invalid("モデル設定が多すぎます"));
        }
        let mut ids = std::collections::HashSet::new();
        for selection in selected {
            validate_model(&selection.id)?;
            validate_model(&selection.value)?;
            if !ids.insert(&selection.id) {
                return Err(invalid("モデル設定の ID が重複しています"));
            }
        }
    }
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

/// Check a literal HTTP(S) prefix, nonempty host, and absence of whitespace or `@`.
/// Return the endpoint without trailing slashes, or `InvalidConfig`; this is a
/// lexical check and does not parse the full URL or contact the server.
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

/// Accept a 1–256-byte model name without NUL or LF, otherwise return `InvalidConfig`.
pub fn validate_model(model: &str) -> Result<(), AiError> {
    if model.is_empty() || model.len() > 256 || model.bytes().any(|b| b == 0 || b == b'\n') {
        return Err(invalid("model は 1〜256 文字で指定します"));
    }
    Ok(())
}

/// Require exactly the configuration matching the selected backend and validate
/// its argv or endpoint/model; Anthropic additionally requires explicit opt-in.
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

/// Allow at most 32 history messages, each with nonblank text of at most 20,000
/// Unicode scalars and no NUL; invalid history returns `InvalidConfig`.
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

/// Validate provider, nonblank prompt (20,000 scalars max), history, and handles.
/// Limit contexts to 16, ranges to 1–32 per context, and excerpts to 512,000 bytes;
/// reject reversed UTF-16 ranges and HTTP session IDs. Snapshot equality,
/// range overlap, and source boundaries require separate authority checks.
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

/// Select the Japanese instruction describing how the requested proposal mode is used.
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

/// Join half-open UTF-16 ranges as `[start, end)` labels in their supplied order.
fn format_ranges(ranges: &[Utf16Range]) -> String {
    ranges
        .iter()
        .map(|range| format!("[{}, {})", range.start.0, range.end.0))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Deterministic user message. Tests assert this exact shape as "what was sent".
/// Compose the mode instruction, scoped contexts, and prompt with no history preamble.
pub fn compose_user_message(mode: PromptMode, prompt: &str, contexts: &[PromptContext]) -> String {
    compose_user_message_with_history(mode, prompt, contexts, &[])
}

/// Render mode, history in supplied order, document/revision/range headers,
/// exact excerpts, and the current prompt into one deterministic text message.
/// History/excerpts receive a framing LF only when missing; inputs are not validated here.
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

/// Echo each sent document, revision, ranges, and excerpt length in Unicode scalars.
/// Preserve context order and omit the excerpt text from the summary.
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

/// Attach the request's document/revision references to reviewable output text.
/// This records provenance and performs no document mutation.
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

/// Find the byte immediately after the first LF-LF or CRLF-CRLF SSE separator.
/// Return `None` until a complete separator has arrived.
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

/// Decode an SSE event lossily, ignore comments/non-data fields, and collect
/// `data:` payloads with LF separators between nonempty accumulated payloads.
/// Return `None` if there is no data field, even when other SSE fields exist.
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
    /// Append HTTP bytes and drain complete SSE events in arrival order.
    /// Keep incomplete bytes for the next chunk and omit events without data fields.
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

    /// Consume the remaining bytes as a final event even without a blank-line separator.
    /// Return `None` for an empty buffer or a remainder without data fields.
    pub fn finish(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let raw = std::mem::take(&mut self.buf);
        event_data(&raw)
    }
}

/// Recognize the OpenAI-compatible `[DONE]` sentinel with surrounding whitespace allowed.
pub fn is_stream_done(data: &str) -> bool {
    data.trim() == "[DONE]"
}

/// Classify HTTP 401/403 as authentication failures and all other statuses as
/// connection failures, retaining at most 300 Unicode scalars of response text.
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

/// Accept all 2xx statuses; otherwise return the bounded HTTP failure classification.
pub fn map_http_status(status: u16, body: &str) -> Option<AiError> {
    if (200..300).contains(&status) {
        None
    } else {
        Some(http_error(status, body))
    }
}

/// Extract streamed text from an OpenAI-compatible chat chunk.
/// Missing content is ignored; malformed JSON or provider errors fail the stream,
/// with recognized unauthorized/API-key messages classified as authentication failures.
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
/// Return text deltas or a message-stop signal, ignore other envelopes, and
/// classify authentication/permission errors separately from other stream errors.
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

/// ACP protocol version advertised and accepted by this client.
pub const ACP_PROTOCOL_VERSION: u32 = 1;

/// Identify Marxen and its Cargo package version in the ACP initialization payload.
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

/// Classified ACP response, notification, or request awaiting a client answer.
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

/// Distinguish agent requests from responses using a nonnull ID and string method.
/// Remaining messages with a method field are notifications; envelopes with
/// neither a usable response ID nor method field return `StreamFailed`.
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

/// Read one of the five supported `result.stopReason` values from a prompt response.
/// Missing, non-string, or unknown reasons return `StreamFailed`.
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
/// Denial prefers `reject_once`, then `reject_always`, and falls back to cancelled
/// when no usable rejection option exists; approval options are never selected.
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

/// Build an ACP v1 initialize request with client identity and no advertised capabilities.
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

/// Build `session/new` with the staging directory as lossy UTF-8 cwd and no MCP servers.
/// The caller supplies and authorizes the directory; this only constructs the envelope.
pub fn acp_session_new(id: u64, staging_dir: &Path) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/new",
        "params": { "cwd": staging_dir.to_string_lossy(), "mcpServers": [] }
    })
}

/// Build a `session/prompt` request containing one composed text block without history.
pub fn acp_session_prompt(
    id: u64,
    session_id: &str,
    mode: PromptMode,
    prompt: &str,
    contexts: &[PromptContext],
) -> serde_json::Value {
    acp_session_prompt_with_history(id, session_id, mode, prompt, contexts, &[])
}

/// Build a `session/prompt` request whose single text block explicitly includes
/// ordered history, scoped excerpts, and the current prompt for the supplied session.
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
/// Only `agent_message_chunk` updates with string content are returned; all other shapes are ignored.
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
    /// Create an idle tracker with no recorded session.
    pub fn new() -> Self {
        Self {
            phase: AcpPhase::Idle,
            session: None,
        }
    }

    /// Return the current locally tracked lifecycle phase without advancing it.
    pub fn phase(&self) -> AcpPhase {
        self.phase
    }

    /// Borrow the session ID recorded by the last session-open event, if any.
    pub fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }

    /// Advance only an idle tracker to initialized; later phases remain unchanged.
    pub fn initialized(&mut self) {
        if self.phase == AcpPhase::Idle {
            self.phase = AcpPhase::Initialized;
        }
    }

    /// Replace the recorded session ID and mark the tracker ready without validating the ID.
    pub fn session_opened(&mut self, session_id: String) {
        self.session = Some(session_id);
        self.phase = AcpPhase::Ready;
    }

    /// Enter prompting from ready, optionally requiring the recorded session ID.
    /// Return busy, session-required, or unknown-session errors without changing phase.
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

    /// Return a prompting tracker to ready and leave all other phases untouched.
    pub fn prompt_finished(&mut self) {
        if self.phase == AcpPhase::Prompting {
            self.phase = AcpPhase::Ready;
        }
    }
}

impl Default for AcpSessionTracker {
    /// Use the same idle, sessionless state as `new`.
    fn default() -> Self {
        Self::new()
    }
}

// ---- OS credential store ----

/// Choose the stable credential-store account key for the selected backend.
pub fn credential_account(kind: AiProviderKind) -> &'static str {
    match kind {
        AiProviderKind::Acp => "ai/acp",
        AiProviderKind::OpenaiCompatible => "ai/openai-compatible",
        AiProviderKind::Anthropic => "ai/anthropic",
    }
}

/// Require 1–8192 secret bytes without interpreting or normalizing their contents.
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
    /// Validated API root shared by provider-specific connection probes.
    pub base: String,
    pub url: String,
    pub model: String,
    pub backend: HttpBackend,
}

/// Validate the selected HTTP backend's endpoint/model and append `/chat/completions`
/// or `/messages`; reject ACP and Anthropic without opt-in as invalid configuration.
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
                base,
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
                base,
                model: anthropic.model.clone(),
                backend: HttpBackend::Anthropic,
            })
        }
        AiProviderKind::Acp => Err(invalid("ACP には HTTP driver を使いません")),
    }
}

/// Map history to ordered HTTP role/content objects, preserving text without validation.
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

/// Build a streaming chat-completions body with history messages followed by one
/// scoped current-user message; history is not duplicated in that message's text.
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

/// Build a streaming Messages body with a 2048-token cap, mode system instruction,
/// ordered history messages, and one scoped current-user message without duplicated history.
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

/// Preserve detailed errors or render a Japanese explanation for structured AI failures,
/// including missing binaries, session state, cancellation, and protocol versions.
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
