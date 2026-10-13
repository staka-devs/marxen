//! AI transports owned by Issue #7: ACP subprocesses, OpenAI-compatible SSE,
//! independent opt-in Anthropic Messages, OS credential store, and Tauri commands.
//!
//! Boundaries (see ADR-0070):
//! - No Claude Code preset exists and Claude binaries are refused at validation.
//! - Subprocesses spawn from argv arrays; nothing goes through a shell.
//! - Agents only see isolated staging copies resolved by #8, never live paths.
//! - Model output becomes proposal text with base revisions, never a write.
//! - Tests use mock servers and a mock subprocess; no real credentials.
use crate::ai_contracts::*;
use crate::contracts::Utf16Range;
use crate::validation::{utf16_to_utf8, validate_document_id};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(feature = "desktop")]
use std::sync::LazyLock;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
#[cfg(feature = "desktop")]
use tauri::Emitter;

pub const MAX_PROMPT_CHARS: usize = 20_000;
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
pub fn find_on_path(command: &str) -> Option<PathBuf> {
    if command.contains('/') || command.contains('\\') || command.contains(':') {
        let path = Path::new(command);
        return path.is_file().then(|| path.to_path_buf());
    }
    let probe = |name: &str| {
        std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
            let candidate = dir.join(name);
            candidate.is_file().then_some(candidate)
        })
    };
    if cfg!(windows) {
        probe(command).or_else(|| probe(&format!("{command}.exe")))
    } else {
        probe(command)
    }
}

fn validate_endpoint(endpoint: &str) -> Result<String, AiError> {
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

fn validate_model(model: &str) -> Result<(), AiError> {
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

pub fn validate_prompt_request(request: &AiPromptRequest) -> Result<(), AiError> {
    validate_provider_config(&request.provider)?;
    let prompt_chars = request.prompt.chars().count();
    if request.prompt.trim().is_empty() || prompt_chars > MAX_PROMPT_CHARS {
        return Err(invalid("プロンプトは 1〜20000 文字です"));
    }
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
            utf16_to_utf8(&context.text, range.start)
                .map_err(|_| invalid("範囲が抜粋テキストの境界にありません"))?;
            utf16_to_utf8(&context.text, range.end)
                .map_err(|_| invalid("範囲が抜粋テキストの境界にありません"))?;
        }
    }
    Ok(())
}

fn mode_instruction(mode: PromptMode) -> &'static str {
    match mode {
        PromptMode::Ask => "文書について質問に回答してください。原文は変更しません。",
        PromptMode::Generate => "文書の続きや新規文書を生成してください。原文は変更しません。",
        PromptMode::Rewrite => "指定範囲の書き換え案を提示してください。原文は変更しません。",
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
pub fn compose_user_message(mode: PromptMode, prompt: &str, contexts: &[PromptContext]) -> String {
    let mut out = String::from(mode_instruction(mode));
    out.push('\n');
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
pub const MAX_ACP_LINE_BYTES: usize = 8_388_608;
/// Grace period for an agent to answer `session/prompt` after `session/cancel`.
pub const CANCEL_GRACE: Duration = Duration::from_secs(5);
/// Maximum silence between prompt-loop iterations before re-checking the
/// cancel flag. Agents that go quiet (for example while waiting for our
/// next message) must not delay cancellation past this bound.
pub const ACP_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Grace period for an agent to exit after we close its stdin.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Latest ACP major protocol version this client speaks.
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
#[derive(Debug, Default)]
pub struct NdjsonReader<R: BufRead> {
    inner: R,
    buf: Vec<u8>,
}

impl<R: BufRead> NdjsonReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buf: Vec::new(),
        }
    }

    /// Read one message. `Ok(None)` only on clean EOF with no pending bytes.
    pub fn next_value(&mut self) -> Result<Option<serde_json::Value>, AiError> {
        loop {
            if let Some(end) = self.buf.iter().position(|byte| *byte == b'\n') {
                let raw: Vec<u8> = self.buf.drain(..=end).collect();
                let mut line = &raw[..raw.len() - 1];
                if line.ends_with(b"\r") {
                    line = &line[..line.len() - 1];
                }
                if line.is_empty() {
                    continue;
                }
                if line.len() > MAX_ACP_LINE_BYTES {
                    return Err(AiError::StreamFailed {
                        detail: "ACP の応答が大きすぎます".into(),
                    });
                }
                let text = std::str::from_utf8(line).map_err(|_| AiError::StreamFailed {
                    detail: "ACP の応答が UTF-8 ではありません".into(),
                })?;
                return serde_json::from_str(text)
                    .map(Some)
                    .map_err(|_| AiError::StreamFailed {
                        detail: "ACP の応答を解釈できません".into(),
                    });
            }
            if self.buf.len() > MAX_ACP_LINE_BYTES + 1 {
                return Err(AiError::StreamFailed {
                    detail: "ACP の応答が大きすぎます".into(),
                });
            }
            let mut chunk = [0u8; 4096];
            match self.inner.read(&mut chunk) {
                Ok(0) => {
                    if self.buf.is_empty() {
                        return Ok(None);
                    }
                    return Err(AiError::StreamFailed {
                        detail: "エージェントが途中で標準出力を閉じました".into(),
                    });
                }
                Ok(read) => self.buf.extend_from_slice(&chunk[..read]),
                Err(_) => {
                    return Err(AiError::StreamFailed {
                        detail: "ACP の応答を読み取れません".into(),
                    });
                }
            }
        }
    }
}

/// One classified inbound message.
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
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": compose_user_message(mode, prompt, contexts) }]
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

pub trait AgentKeyring: Send + Sync {
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError>;
    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError>;
    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError>;
    fn has(&self, kind: AiProviderKind) -> Result<bool, AiError> {
        Ok(self
            .get(kind)?
            .map(|secret| !secret.is_empty())
            .unwrap_or(false))
    }
}

/// In-memory keyring for tests and dry runs. Never used for real secrets.
#[derive(Debug, Default)]
pub struct MemoryKeyring {
    inner: Mutex<HashMap<String, String>>,
}

impl AgentKeyring for MemoryKeyring {
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError> {
        Ok(self
            .inner
            .lock()
            .expect("keyring lock")
            .get(credential_account(kind))
            .cloned())
    }

    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError> {
        validate_secret(secret)?;
        self.inner
            .lock()
            .expect("keyring lock")
            .insert(credential_account(kind).to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError> {
        self.inner
            .lock()
            .expect("keyring lock")
            .remove(credential_account(kind));
        Ok(())
    }
}

/// Real OS backend: Windows Credential Manager, macOS Keychain, Linux Secret Service.
pub struct OsKeyring;

fn keyring_entry(kind: AiProviderKind) -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(SECRET_SERVICE, credential_account(kind)).map_err(|error| {
        AiError::CredentialStoreFailed {
            detail: format!("資格情報ストアを開けません: {error}"),
        }
    })
}

impl AgentKeyring for OsKeyring {
    fn get(&self, kind: AiProviderKind) -> Result<Option<String>, AiError> {
        let entry = keyring_entry(kind)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AiError::CredentialStoreFailed {
                detail: format!("資格情報を読めません: {error}"),
            }),
        }
    }

    fn set(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError> {
        validate_secret(secret)?;
        keyring_entry(kind)?
            .set_password(secret)
            .map_err(|error| AiError::CredentialStoreFailed {
                detail: format!("資格情報を保存できません: {error}"),
            })
    }

    fn delete(&self, kind: AiProviderKind) -> Result<(), AiError> {
        let entry = keyring_entry(kind)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AiError::CredentialStoreFailed {
                detail: format!("資格情報を削除できません: {error}"),
            }),
        }
    }
}

// ---- Staging resolution (interface owned with #8) ----

/// Map an isolated copy handle to its staging directory. #8 implements the
/// real mapping; until then production uses RejectingResolver.
pub trait StagingResolver: Send + Sync {
    fn root(&self) -> &Path;
    fn resolve(&self, copy_id: &IsolatedCopyId) -> Result<PathBuf, AiError>;
}

pub struct RejectingResolver;

impl StagingResolver for RejectingResolver {
    fn root(&self) -> &Path {
        Path::new("")
    }

    fn resolve(&self, copy_id: &IsolatedCopyId) -> Result<PathBuf, AiError> {
        Err(AiError::StagingUnresolved {
            copy_id: copy_id.clone(),
        })
    }
}

/// Reject paths that escape the staging root (traversal or absolute detours).
pub fn guard_staging_path(root: &Path, candidate: &Path) -> Result<PathBuf, AiError> {
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        use std::path::Component;
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AiError::LiveTargetRejected {
                        detail: "作業コピーの外を指しています".into(),
                    });
                }
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => {
                return Err(AiError::LiveTargetRejected {
                    detail: "作業コピーの外を指しています".into(),
                });
            }
        }
    }
    let joined = root.join(normalized);
    if !joined.starts_with(root) || root.as_os_str().is_empty() {
        return Err(AiError::LiveTargetRejected {
            detail: "作業コピーの外を指しています".into(),
        });
    }
    Ok(joined)
}

// ---- Mock transport (tests and connection dry runs) ----

pub struct MockScript {
    pub chunks: Vec<String>,
    pub fail: Option<AiError>,
}

pub struct ProposalAssembler {
    text: String,
}

impl ProposalAssembler {
    pub fn new() -> Self {
        Self {
            text: String::new(),
        }
    }

    pub fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
    }

    pub fn finish(self, request: &AiPromptRequest) -> ProposalText {
        proposal_from_text(self.text, request)
    }
}

impl Default for ProposalAssembler {
    fn default() -> Self {
        Self::new()
    }
}

pub fn run_mock_script(
    request: &AiPromptRequest,
    run_id: &AiRunId,
    script: &MockScript,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) -> String {
    let composed = compose_user_message(request.mode, &request.prompt, &request.contexts);
    emit(AiStreamEvent::Started(StreamStarted {
        run_id: run_id.clone(),
    }));
    if cancel.load(Ordering::SeqCst) {
        emit(AiStreamEvent::Cancelled(StreamCancelled {
            run_id: run_id.clone(),
        }));
        return composed;
    }
    if let Some(error) = &script.fail {
        emit(AiStreamEvent::Error(StreamError {
            run_id: Some(run_id.clone()),
            error: error.clone(),
        }));
        return composed;
    }
    let mut assembler = ProposalAssembler::new();
    for chunk in &script.chunks {
        if cancel.load(Ordering::SeqCst) {
            emit(AiStreamEvent::Cancelled(StreamCancelled {
                run_id: run_id.clone(),
            }));
            return composed;
        }
        assembler.push(chunk);
        emit(AiStreamEvent::Chunk(StreamChunk {
            run_id: run_id.clone(),
            text: chunk.clone(),
        }));
    }
    emit(AiStreamEvent::Done(StreamDone {
        run_id: run_id.clone(),
        proposal: assembler.finish(request),
        sent: summarize_contexts(request),
    }));
    composed
}

// ---- Run registry (cancel routing shared by commands and tests) ----

pub struct RunEntry {
    pub cancel: Arc<AtomicBool>,
    pub timed_out: Arc<AtomicBool>,
    pub child: Mutex<Option<Child>>,
}

pub struct RunRegistry {
    next: AtomicU64,
    entries: Mutex<HashMap<String, RunEntry>>,
}

impl RunRegistry {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self) -> (AiRunId, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let run_id = AiRunId(format!("run_{id}"));
        let cancel = Arc::new(AtomicBool::new(false));
        self.entries.lock().expect("run registry lock").insert(
            run_id.0.clone(),
            RunEntry {
                cancel: cancel.clone(),
                timed_out: Arc::new(AtomicBool::new(false)),
                child: Mutex::new(None),
            },
        );
        (run_id, cancel)
    }

    fn with_entry(&self, id: &AiRunId, f: impl FnOnce(&RunEntry)) -> bool {
        match self.entries.lock().expect("run registry lock").get(&id.0) {
            Some(entry) => {
                f(entry);
                true
            }
            None => false,
        }
    }

    pub fn cancel_flag(&self, id: &AiRunId) -> Option<Arc<AtomicBool>> {
        self.entries
            .lock()
            .expect("run registry lock")
            .get(&id.0)
            .map(|entry| entry.cancel.clone())
    }

    /// Signal cancel and kill a live agent process. Returns false when the
    /// run already finished.
    pub fn cancel(&self, id: &AiRunId) -> bool {
        self.with_entry(id, |entry| {
            entry.cancel.store(true, Ordering::SeqCst);
            if let Some(mut child) = entry.child.lock().expect("child lock").take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        })
    }

    pub fn timeout_cancel(&self, id: &AiRunId) -> bool {
        self.with_entry(id, |entry| {
            entry.timed_out.store(true, Ordering::SeqCst);
            entry.cancel.store(true, Ordering::SeqCst);
            if let Some(mut child) = entry.child.lock().expect("child lock").take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        })
    }

    pub fn was_timed_out(&self, id: &AiRunId) -> bool {
        self.entries
            .lock()
            .expect("run registry lock")
            .get(&id.0)
            .map(|entry| entry.timed_out.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    pub fn set_child(&self, id: &AiRunId, child: Child) -> bool {
        self.with_entry(id, |entry| {
            *entry.child.lock().expect("child lock") = Some(child);
        })
    }

    pub fn take_child(&self, id: &AiRunId) -> Option<Child> {
        self.entries
            .lock()
            .expect("run registry lock")
            .get(&id.0)
            .and_then(|entry| entry.child.lock().expect("child lock").take())
    }

    pub fn remove(&self, id: &AiRunId) {
        self.entries
            .lock()
            .expect("run registry lock")
            .remove(&id.0);
    }
}

impl Default for RunRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---- ACP subprocess driver (blocking stdio, no shell) ----

pub struct AcpRunParams {
    pub argv: AcpArgv,
    pub staging_dir: PathBuf,
    pub timeout: Duration,
}

fn spawn_acp(argv: &AcpArgv, staging_dir: &Path) -> Result<Child, AiError> {
    // argv goes directly to the OS. No shell, no interpolation.
    Command::new(&argv.command)
        .args(&argv.args)
        .current_dir(staging_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AiError::MissingBinary {
                    command: argv.command.clone(),
                }
            } else {
                AiError::SpawnFailed {
                    detail: format!("エージェントを起動できません: {error}"),
                }
            }
        })
}

// ---- ACP connection: id routing, permissions, cancel, cleanup ----

/// One line read from the agent's stdout.
#[derive(Debug)]
pub enum ConnLine {
    Value(serde_json::Value),
    Eof,
}

#[derive(Debug)]
pub enum ReadFail {
    Timeout,
    Stream(AiError),
}

/// One live agent subprocess. stdin is written from the driver thread while a
/// side thread pumps stdout lines through a channel, so cancel and timeout
/// handling never blocks on a read. Request/response id matching,
/// notification dispatch, and inbound agent requests all flow through here.
pub struct AgentConn {
    stdin: ChildStdin,
    rx: mpsc::Receiver<Result<ConnLine, AiError>>,
    next_id: u64,
}

impl AgentConn {
    pub fn launch(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        let (tx, rx) = mpsc::channel();
        let mut reader = NdjsonReader::new(BufReader::new(stdout));
        std::thread::spawn(move || loop {
            match reader.next_value() {
                Ok(Some(value)) => {
                    if tx.send(Ok(ConnLine::Value(value))).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = tx.send(Ok(ConnLine::Eof));
                    break;
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                    break;
                }
            }
        });
        Self {
            stdin,
            rx,
            next_id: 1,
        }
    }

    pub fn fresh_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn write(&mut self, message: &serde_json::Value) -> Result<(), AiError> {
        self.stdin
            .write_all(&encode_acp_message(message))
            .map_err(|_| AiError::StreamFailed {
                detail: "エージェントに送信できません".into(),
            })?;
        self.stdin.flush().map_err(|_| AiError::StreamFailed {
            detail: "エージェントに送信できません".into(),
        })
    }

    pub fn notify(&mut self, message: &serde_json::Value) -> Result<(), AiError> {
        self.write(message)
    }

    pub fn read_next(&self, timeout: Option<Duration>) -> Result<ConnLine, ReadFail> {
        let received = match timeout {
            Some(limit) => self.rx.recv_timeout(limit),
            None => self
                .rx
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(Ok(line)) => Ok(line),
            Ok(Err(error)) => Err(ReadFail::Stream(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ReadFail::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(ConnLine::Eof),
        }
    }

    fn answer_agent_request(
        &mut self,
        id: &serde_json::Value,
        method: &str,
        params: &Value,
        permission: PermissionAnswer,
    ) -> Result<(), AiError> {
        let response = if method == "session/request_permission" {
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": answer_permission(params, permission),
            })
        } else {
            method_not_found(id, method)
        };
        self.write(&response)
    }

    /// Send a prebuilt request (carrying its own `id`) and wait for the
    /// matching response. Interleaved notifications go to `sink`; inbound
    /// agent requests are answered inline so they never deadlock the peer.
    pub fn roundtrip(
        &mut self,
        message: serde_json::Value,
        permission: PermissionAnswer,
        sink: &mut dyn FnMut(serde_json::Value),
    ) -> Result<serde_json::Value, AiError> {
        let id = message
            .get("id")
            .cloned()
            .ok_or_else(|| AiError::StreamFailed {
                detail: "要求に ID がありません".into(),
            })?;
        self.write(&message)?;
        loop {
            match self.read_next(None) {
                Ok(ConnLine::Value(message)) => match classify_incoming(message)? {
                    AgentIncoming::Response { id: got, body } => {
                        if got == id {
                            if let Some(detail) = rpc_error(&body) {
                                return Err(AiError::StreamFailed {
                                    detail: format!("エージェントがエラーを返しました: {detail}"),
                                });
                            }
                            return Ok(body);
                        }
                        return Err(AiError::StreamFailed {
                            detail: format!("想定外の応答 ID を受けました: {got}"),
                        });
                    }
                    AgentIncoming::Notification(note) => sink(note),
                    AgentIncoming::AgentRequest {
                        id: req_id,
                        method: req_method,
                        params: req_params,
                    } => {
                        self.answer_agent_request(&req_id, &req_method, &req_params, permission)?;
                    }
                },
                Ok(ConnLine::Eof) => {
                    return Err(AiError::StreamFailed {
                        detail: "エージェントが標準出力を閉じました".into(),
                    });
                }
                Err(ReadFail::Timeout) => {
                    return Err(AiError::StreamFailed {
                        detail: "応答待ちがタイムアウトしました".into(),
                    });
                }
                Err(ReadFail::Stream(error)) => return Err(error),
            }
        }
    }
}

fn wait_for_exit(child: &mut Child, grace: Duration) {
    let start = Instant::now();
    loop {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        if start.elapsed() >= grace {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Graceful shutdown: dropping the connection closes stdin (the transport's
/// termination signal), then wait briefly and kill leftovers. Always reaps.
fn shutdown_agent(conn: AgentConn, mut child: Child, grace: Duration) {
    drop(conn);
    wait_for_exit(&mut child, grace);
    let _ = child.kill();
    let _ = child.wait();
}

/// Result of initialize + session/new. No prompt is ever sent by this path.
#[derive(Debug, Clone)]
pub struct HandshakeInfo {
    pub protocol_version: u32,
    pub session_id: String,
    pub agent_name: Option<String>,
    pub notifications: usize,
}

pub fn agent_handshake(
    argv: &AcpArgv,
    staging_dir: &Path,
    timeout: Duration,
) -> Result<HandshakeInfo, AiError> {
    validate_argv(argv)?;
    let mut child = spawn_acp(argv, staging_dir)?;
    let stdin = child.stdin.take().ok_or_else(|| AiError::SpawnFailed {
        detail: "エージェントの標準入力を開けません".into(),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| AiError::SpawnFailed {
        detail: "エージェントの標準出力を開けません".into(),
    })?;
    let stderr_captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let captured = stderr_captured.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            *captured.lock().expect("stderr lock") = buf;
        });
    }
    // Local kill handle for the overall timeout (no run registry here).
    let shared: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));
    {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            if let Some(mut child) = shared.lock().expect("child lock").take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        });
    }
    let mut conn = AgentConn::launch(stdin, stdout);
    let notifications = std::cell::Cell::new(0usize);
    let mut sink = |_: serde_json::Value| {
        notifications.set(notifications.get() + 1);
    };
    let outcome = (|| {
        let init_id = conn.fresh_id();
        let init = conn.roundtrip(acp_initialize(init_id), PermissionAnswer::Deny, &mut sink)?;
        let version = check_protocol_version(&init)?;
        let agent_name = init
            .pointer("/result/agentInfo/name")
            .and_then(|name| name.as_str())
            .map(str::to_owned);
        let new_id = conn.fresh_id();
        let reply = conn.roundtrip(
            acp_session_new(new_id, staging_dir),
            PermissionAnswer::Deny,
            &mut sink,
        )?;
        let session_id = reply
            .pointer("/result/sessionId")
            .and_then(|id| id.as_str())
            .ok_or_else(|| AiError::StreamFailed {
                detail: "session/new が sessionId を返しませんでした".into(),
            })?
            .to_owned();
        Ok(HandshakeInfo {
            protocol_version: version,
            session_id,
            agent_name,
            notifications: notifications.get(),
        })
    })();
    // Reap exactly once: take the child back unless the watchdog already did.
    let child = shared.lock().expect("child lock").take();
    drop(conn);
    if let Some(mut child) = child {
        wait_for_exit(&mut child, SHUTDOWN_GRACE);
        let _ = child.kill();
        let _ = child.wait();
    }
    outcome.map_err(|error| with_stderr(error, &stderr_captured))
}

fn rpc_error(message: &serde_json::Value) -> Option<String> {
    message.get("error").map(|error| {
        error
            .get("message")
            .and_then(|message| message.as_str())
            .unwrap_or("agent error")
            .to_owned()
    })
}

fn stderr_excerpt(captured: &Arc<Mutex<Vec<u8>>>) -> String {
    let bytes = captured.lock().expect("stderr lock").clone();
    String::from_utf8_lossy(&bytes).chars().take(500).collect()
}

fn with_stderr(error: AiError, captured: &Arc<Mutex<Vec<u8>>>) -> AiError {
    let excerpt = stderr_excerpt(captured);
    if excerpt.trim().is_empty() {
        return error;
    }
    let suffix = format!(" [stderr] {excerpt}");
    match error {
        AiError::InvalidConfig { mut detail } => AiError::InvalidConfig {
            detail: {
                detail.push_str(&suffix);
                detail
            },
        },
        AiError::SpawnFailed { mut detail } => AiError::SpawnFailed {
            detail: {
                detail.push_str(&suffix);
                detail
            },
        },
        AiError::ConnectionFailed { mut detail } => AiError::ConnectionFailed {
            detail: {
                detail.push_str(&suffix);
                detail
            },
        },
        AiError::AuthFailed { mut detail } => AiError::AuthFailed {
            detail: {
                detail.push_str(&suffix);
                detail
            },
        },
        AiError::StreamFailed { mut detail } => AiError::StreamFailed {
            detail: {
                detail.push_str(&suffix);
                detail
            },
        },
        other => other,
    }
}

fn cancelled_or_timed_out(
    run_id: &AiRunId,
    registry: &RunRegistry,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) {
    if registry.was_timed_out(run_id) {
        emit(AiStreamEvent::Error(StreamError {
            run_id: Some(run_id.clone()),
            error: AiError::StreamFailed {
                detail: "エージェントが時間内に応答しませんでした".into(),
            },
        }));
    } else {
        emit(AiStreamEvent::Cancelled(StreamCancelled {
            run_id: run_id.clone(),
        }));
    }
}

pub fn run_acp_prompt(
    params: &AcpRunParams,
    request: &AiPromptRequest,
    run_id: &AiRunId,
    registry: &Arc<RunRegistry>,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) -> Result<(), AiError> {
    emit(AiStreamEvent::Started(StreamStarted {
        run_id: run_id.clone(),
    }));
    if cancel.load(Ordering::SeqCst) {
        cancelled_or_timed_out(run_id, registry, emit);
        return Ok(());
    }
    let mut child = spawn_acp(&params.argv, &params.staging_dir)?;
    // Drain stderr on a side thread so a chatty agent can never block us.
    let stderr_captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let captured = stderr_captured.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            *captured.lock().expect("stderr lock") = buf;
        });
    }
    let stdin = child.stdin.take().ok_or_else(|| AiError::SpawnFailed {
        detail: "エージェントの標準入力を開けません".into(),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| AiError::SpawnFailed {
        detail: "エージェントの標準出力を開けません".into(),
    })?;
    let mut conn = AgentConn::launch(stdin, stdout);
    registry.set_child(run_id, child);

    // Overall watchdog: kill through the registry so cancel stays uniform.
    let watchdog_registry = Arc::clone(registry);
    let watchdog_id = run_id.clone();
    let watchdog_timeout = params.timeout;
    std::thread::spawn(move || {
        std::thread::sleep(watchdog_timeout);
        watchdog_registry.timeout_cancel(&watchdog_id);
    });

    let outcome = run_acp_conversation(params, request, run_id, registry, cancel, emit, &mut conn);
    let outcome = outcome.map_err(|error| with_stderr(error, &stderr_captured));
    // Reap exactly once on every path. Graceful turns (Done or a cooperating
    // cancel) shut the agent down by closing stdin; kill paths already reaped
    // through the registry, and error paths kill here.
    match &outcome {
        Ok(()) => {
            if let Some(child) = registry.take_child(run_id) {
                shutdown_agent(conn, child, SHUTDOWN_GRACE);
            }
        }
        Err(_) => {
            registry.cancel(run_id);
        }
    }
    registry.remove(run_id);
    outcome
}

#[allow(clippy::too_many_arguments)]
fn run_acp_conversation(
    params: &AcpRunParams,
    request: &AiPromptRequest,
    run_id: &AiRunId,
    registry: &RunRegistry,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
    conn: &mut AgentConn,
) -> Result<(), AiError> {
    let mut tracker = AcpSessionTracker::new();
    let mut ignore = |_: serde_json::Value| {};

    let init_id = conn.fresh_id();
    let init = conn.roundtrip(acp_initialize(init_id), PermissionAnswer::Deny, &mut ignore)?;
    check_protocol_version(&init)?;
    tracker.initialized();

    let new_id = conn.fresh_id();
    let reply = conn.roundtrip(
        acp_session_new(new_id, &params.staging_dir),
        PermissionAnswer::Deny,
        &mut ignore,
    )?;
    let session_id = reply
        .pointer("/result/sessionId")
        .and_then(|id| id.as_str())
        .ok_or_else(|| AiError::StreamFailed {
            detail: "session/new が sessionId を返しませんでした".into(),
        })?;
    tracker.session_opened(session_id.to_owned());

    // Resume across runs is not implemented in v1: any caller-supplied id is
    // unknown by construction. The tracker reports that explicitly.
    tracker.prompt_started(request.session_id.as_ref().map(|id| id.0.as_str()))?;

    let prompt_id = conn.fresh_id();
    let prompt_message = acp_session_prompt(
        prompt_id,
        session_id,
        request.mode,
        &request.prompt,
        &request.contexts,
    );
    conn.write(&prompt_message)?;

    let mut assembler = ProposalAssembler::new();
    let mut cancel_sent = false;
    loop {
        if cancel.load(Ordering::SeqCst) && !cancel_sent {
            if registry.was_timed_out(run_id) {
                registry.cancel(run_id);
                emit(AiStreamEvent::Error(StreamError {
                    run_id: Some(run_id.clone()),
                    error: AiError::StreamFailed {
                        detail: "エージェントが時間内に応答しませんでした".into(),
                    },
                }));
                tracker.prompt_finished();
                return Ok(());
            }
            // Official cancel is a notification; the agent answers with the
            // `cancelled` stop reason. Kill only on grace expiry below.
            let _ = conn.notify(&acp_session_cancel_notification(session_id));
            cancel_sent = true;
        }
        // Bound every wait so a quiet agent cannot delay cancellation past
        // ACP_POLL_INTERVAL. Grace expiry kills; plain expiry re-polls.
        let wait = if cancel_sent {
            Some(CANCEL_GRACE)
        } else {
            Some(ACP_POLL_INTERVAL)
        };
        let message = match conn.read_next(wait) {
            Ok(ConnLine::Value(message)) => message,
            Ok(ConnLine::Eof) => {
                if cancel_sent || cancel.load(Ordering::SeqCst) {
                    cancelled_or_timed_out(run_id, registry, emit);
                    tracker.prompt_finished();
                    return Ok(());
                }
                return Err(AiError::StreamFailed {
                    detail: "エージェントが標準出力を閉じました".into(),
                });
            }
            Err(ReadFail::Timeout) => {
                if cancel_sent {
                    // Grace expired without the cancelled turn: kill and let
                    // the EOF path below report the cancellation.
                    registry.cancel(run_id);
                }
                continue;
            }
            Err(ReadFail::Stream(_)) if cancel.load(Ordering::SeqCst) => {
                cancelled_or_timed_out(run_id, registry, emit);
                tracker.prompt_finished();
                return Ok(());
            }
            Err(ReadFail::Stream(error)) => return Err(error),
        };
        match classify_incoming(message)? {
            AgentIncoming::Response { id: got, body } => {
                if got != serde_json::json!(prompt_id) {
                    return Err(AiError::StreamFailed {
                        detail: format!("想定外の応答 ID を受けました: {got}"),
                    });
                }
                if let Some(detail) = rpc_error(&body) {
                    return Err(AiError::StreamFailed {
                        detail: format!("prompt に失敗しました: {detail}"),
                    });
                }
                match parse_stop_reason(&body)? {
                    StopReason::Cancelled => {
                        emit(AiStreamEvent::Cancelled(StreamCancelled {
                            run_id: run_id.clone(),
                        }));
                    }
                    _ if cancel_sent => {
                        emit(AiStreamEvent::Cancelled(StreamCancelled {
                            run_id: run_id.clone(),
                        }));
                    }
                    _ => {
                        emit(AiStreamEvent::Done(StreamDone {
                            run_id: run_id.clone(),
                            proposal: assembler.finish(request),
                            sent: summarize_contexts(request),
                        }));
                    }
                }
                tracker.prompt_finished();
                return Ok(());
            }
            AgentIncoming::Notification(note) => {
                if let Some(text) = acp_update_text(&note) {
                    assembler.push(&text);
                    emit(AiStreamEvent::Chunk(StreamChunk {
                        run_id: run_id.clone(),
                        text,
                    }));
                }
                // Other updates (tool calls, file edits inside the staging
                // copy) stay in the isolated copy for #8 to diff; only text
                // is proposed.
            }
            AgentIncoming::AgentRequest {
                id: req_id,
                method: req_method,
                params: req_params,
            } => {
                // No approval UI exists: deny by default. After our own
                // cancel, answer with the spec's `cancelled` outcome.
                let mode = if cancel_sent || cancel.load(Ordering::SeqCst) {
                    PermissionAnswer::Cancelled
                } else {
                    PermissionAnswer::Deny
                };
                conn.answer_agent_request(&req_id, &req_method, &req_params, mode)?;
            }
        }
    }
}

// ---- HTTP SSE drivers (OpenAI-compatible and Anthropic) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

pub fn http_client(timeout: Duration) -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| AiError::ConnectionFailed {
            detail: format!("HTTP クライアントを作れません: {error}"),
        })
}

fn openai_body(request: &AiPromptRequest, model: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "stream": true,
        "messages": [
            { "role": "user", "content": compose_user_message(request.mode, &request.prompt, &request.contexts) }
        ]
    })
}

fn anthropic_body(request: &AiPromptRequest, model: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        "stream": true,
        "system": mode_instruction(request.mode),
        "messages": [
            { "role": "user", "content": compose_user_message(request.mode, &request.prompt, &request.contexts) }
        ]
    })
}

pub async fn run_http_prompt(
    client: &reqwest::Client,
    target: &HttpTarget,
    secret: &str,
    request: &AiPromptRequest,
    run_id: &AiRunId,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) -> Result<(), AiError> {
    emit(AiStreamEvent::Started(StreamStarted {
        run_id: run_id.clone(),
    }));
    if cancel.load(Ordering::SeqCst) {
        emit(AiStreamEvent::Cancelled(StreamCancelled {
            run_id: run_id.clone(),
        }));
        return Ok(());
    }
    let mut builder = client
        .post(&target.url)
        .header("Content-Type", "application/json")
        .json(&match target.backend {
            HttpBackend::OpenAi => openai_body(request, &target.model),
            HttpBackend::Anthropic => anthropic_body(request, &target.model),
        });
    builder = match target.backend {
        HttpBackend::OpenAi => builder.bearer_auth(secret),
        HttpBackend::Anthropic => builder
            .header("x-api-key", secret)
            .header("anthropic-version", "2023-06-01"),
    };
    let response = builder.send().await.map_err(|error| {
        if error.is_timeout() {
            AiError::StreamFailed {
                detail: "時間内に応答がありませんでした".into(),
            }
        } else {
            AiError::ConnectionFailed {
                detail: format!("接続できません: {error}"),
            }
        }
    })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        let error = map_http_status(status, &body).expect("non-2xx maps to error");
        emit(AiStreamEvent::Error(StreamError {
            run_id: Some(run_id.clone()),
            error: error.clone(),
        }));
        return Err(error);
    }
    use futures::StreamExt as _;
    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut assembler = ProposalAssembler::new();
    let mut finished = false;
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            emit(AiStreamEvent::Cancelled(StreamCancelled {
                run_id: run_id.clone(),
            }));
            return Ok(());
        }
        let bytes = chunk.map_err(|error| AiError::StreamFailed {
            detail: format!("受信に失敗しました: {error}"),
        })?;
        for data in decoder.push(&bytes) {
            if finished {
                continue;
            }
            match target.backend {
                HttpBackend::OpenAi => {
                    if is_stream_done(&data) {
                        finished = true;
                        continue;
                    }
                    if let Some(text) = openai_delta_text(&data)? {
                        assembler.push(&text);
                        emit(AiStreamEvent::Chunk(StreamChunk {
                            run_id: run_id.clone(),
                            text,
                        }));
                    }
                }
                HttpBackend::Anthropic => match anthropic_signal(&data)? {
                    AnthropicSignal::Text(text) => {
                        assembler.push(&text);
                        emit(AiStreamEvent::Chunk(StreamChunk {
                            run_id: run_id.clone(),
                            text,
                        }));
                    }
                    AnthropicSignal::End => finished = true,
                    AnthropicSignal::Ignore => {}
                },
            }
        }
    }
    if let Some(data) = decoder.finish() {
        match target.backend {
            HttpBackend::OpenAi => {
                if !is_stream_done(&data) {
                    if let Some(text) = openai_delta_text(&data)? {
                        assembler.push(&text);
                        emit(AiStreamEvent::Chunk(StreamChunk {
                            run_id: run_id.clone(),
                            text,
                        }));
                    }
                }
            }
            HttpBackend::Anthropic => {
                if let AnthropicSignal::Text(text) = anthropic_signal(&data)? {
                    assembler.push(&text);
                    emit(AiStreamEvent::Chunk(StreamChunk {
                        run_id: run_id.clone(),
                        text,
                    }));
                }
            }
        }
    }
    emit(AiStreamEvent::Done(StreamDone {
        run_id: run_id.clone(),
        proposal: assembler.finish(request),
        sent: summarize_contexts(request),
    }));
    Ok(())
}

// ---- Connection tests (dry run first, live only on explicit request) ----

pub fn dry_run_report(
    config: &AiProviderConfig,
    keyring: &dyn AgentKeyring,
) -> Result<AiTestResult, AiError> {
    validate_provider_config(config)?;
    match config.kind {
        AiProviderKind::Acp => {
            let acp = config.acp.as_ref().expect("validated");
            let argv = resolve_acp_argv(acp)?;
            match find_on_path(&argv.command) {
                Some(path) => Ok(AiTestResult {
                    ok: true,
                    detail: format!("{} が見つかりました ({})", argv.command, path.display()),
                }),
                None => Ok(AiTestResult {
                    ok: false,
                    detail: format!(
                        "{} が見つかりません。CLI をインストールして PATH を通してください",
                        argv.command
                    ),
                }),
            }
        }
        kind => {
            if keyring.has(kind)? {
                Ok(AiTestResult {
                    ok: true,
                    detail: "設定と資格情報の存在を確認しました（通信なし）".into(),
                })
            } else {
                Ok(AiTestResult {
                    ok: false,
                    detail: "資格情報が OS ストアにありません".into(),
                })
            }
        }
    }
}

pub async fn test_openai_live(
    client: &reqwest::Client,
    endpoint: &str,
    secret: &str,
) -> Result<AiTestResult, AiError> {
    let base = validate_endpoint(endpoint)?;
    let response = client
        .get(format!("{base}/models"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|error| AiError::ConnectionFailed {
            detail: format!("接続できません: {error}"),
        })?;
    let status = response.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(AiTestResult {
            ok: true,
            detail: "接続テストに成功しました".into(),
        });
    }
    let body = response.text().await.unwrap_or_default();
    Ok(AiTestResult {
        ok: false,
        detail: match map_http_status(status, &body) {
            Some(AiError::AuthFailed { detail }) => format!("認証に失敗しました: {detail}"),
            _ => format!("接続テストに失敗しました (HTTP {status})"),
        },
    })
}

pub async fn test_anthropic_live(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
    secret: &str,
) -> Result<AiTestResult, AiError> {
    // Minimal paid call (max_tokens 1). Only runs on explicit user opt-in.
    let base = validate_endpoint(endpoint)?;
    validate_model(model)?;
    let response = client
        .post(format!("{base}/messages"))
        .header("x-api-key", secret)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "接続テストです。「OK」とだけ返してください。" }]
        }))
        .send()
        .await
        .map_err(|error| AiError::ConnectionFailed {
            detail: format!("接続できません: {error}"),
        })?;
    let status = response.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(AiTestResult {
            ok: true,
            detail: "接続テストに成功しました".into(),
        });
    }
    let body = response.text().await.unwrap_or_default();
    Ok(AiTestResult {
        ok: false,
        detail: match map_http_status(status, &body) {
            Some(AiError::AuthFailed { detail }) => format!("認証に失敗しました: {detail}"),
            _ => format!("接続テストに失敗しました (HTTP {status})"),
        },
    })
}

pub fn handshake_acp(argv: &AcpArgv) -> Result<AiTestResult, AiError> {
    validate_argv(argv)?;
    let staging = std::env::temp_dir();
    match agent_handshake(argv, &staging, HTTP_TEST_TIMEOUT) {
        Ok(info) => Ok(AiTestResult {
            ok: true,
            detail: format!(
                "ACP ハンドシェイクに成功しました (protocol {}, session {}, 通知 {} 件)",
                info.protocol_version, info.session_id, info.notifications
            ),
        }),
        Err(error) => Ok(AiTestResult {
            ok: false,
            detail: format!("ハンドシェイクに失敗しました: {}", error_detail(&error)),
        }),
    }
}

fn error_detail(error: &AiError) -> String {
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

// ---- Tauri commands (desktop only; JavaScript never sees secrets) ----

#[cfg(feature = "desktop")]
static RUNS: LazyLock<std::sync::Arc<RunRegistry>> =
    LazyLock::new(|| std::sync::Arc::new(RunRegistry::new()));

#[cfg(feature = "desktop")]
fn emit_to_frontend(app: &tauri::AppHandle, event: AiStreamEvent) {
    let _ = app.emit("ai-stream", event);
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_credential_state(kind: AiProviderKind) -> Result<CredentialRef, AiError> {
    Ok(CredentialRef {
        provider: kind,
        has_secret: OsKeyring.has(kind)?,
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_set_credential(kind: AiProviderKind, secret: String) -> Result<(), AiError> {
    OsKeyring.set(kind, &secret)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_delete_credential(kind: AiProviderKind) -> Result<(), AiError> {
    OsKeyring.delete(kind)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn ai_test_connection(
    config: AiProviderConfig,
    live: bool,
) -> Result<AiTestResult, AiError> {
    validate_provider_config(&config)?;
    if !live {
        return dry_run_report(&config, &OsKeyring);
    }
    match config.kind {
        AiProviderKind::Acp => {
            let argv = resolve_acp_argv(config.acp.as_ref().expect("validated"))?;
            handshake_acp(&argv)
        }
        AiProviderKind::OpenaiCompatible => {
            let openai = config.openai.as_ref().expect("validated");
            let secret = OsKeyring
                .get(config.kind)?
                .ok_or(AiError::MissingCredentials {
                    provider: config.kind,
                })?;
            test_openai_live(&http_client(HTTP_TEST_TIMEOUT)?, &openai.endpoint, &secret).await
        }
        AiProviderKind::Anthropic => {
            let anthropic = config.anthropic.as_ref().expect("validated");
            let secret = OsKeyring
                .get(config.kind)?
                .ok_or(AiError::MissingCredentials {
                    provider: config.kind,
                })?;
            test_anthropic_live(
                &http_client(HTTP_TEST_TIMEOUT)?,
                &anthropic.endpoint,
                &anthropic.model,
                &secret,
            )
            .await
        }
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn ai_prompt_stream(
    app: tauri::AppHandle,
    request: AiPromptRequest,
) -> Result<AiRunId, AiError> {
    validate_prompt_request(&request)?;
    match request.provider.kind {
        AiProviderKind::Acp => {
            let argv = resolve_acp_argv(request.provider.acp.as_ref().expect("validated"))?;
            // #8 plugs its resolver here; until then every ACP run is refused
            // with staging_unresolved instead of touching live files.
            let staging_dir = RejectingResolver.resolve(&request.staging.copy_id)?;
            let staging_dir = guard_staging_path(RejectingResolver.root(), &staging_dir)?;
            let (run_id, cancel) = RUNS.register();
            let registry = RUNS.clone();
            let owned_run_id = run_id.clone();
            let owned_request = request.clone();
            std::thread::spawn(move || {
                let params = AcpRunParams {
                    argv,
                    staging_dir,
                    timeout: ACP_DEFAULT_TIMEOUT,
                };
                let mut emit = |event: AiStreamEvent| emit_to_frontend(&app, event);
                let outcome = run_acp_prompt(
                    &params,
                    &owned_request,
                    &owned_run_id,
                    &registry,
                    &cancel,
                    &mut emit,
                );
                if let Err(error) = outcome {
                    emit_to_frontend(
                        &app,
                        AiStreamEvent::Error(StreamError {
                            run_id: Some(owned_run_id.clone()),
                            error,
                        }),
                    );
                }
                registry.remove(&owned_run_id);
            });
            Ok(run_id)
        }
        AiProviderKind::OpenaiCompatible | AiProviderKind::Anthropic => {
            let target = http_target(&request.provider)?;
            let secret =
                OsKeyring
                    .get(request.provider.kind)?
                    .ok_or(AiError::MissingCredentials {
                        provider: request.provider.kind,
                    })?;
            let (run_id, cancel) = RUNS.register();
            let registry = RUNS.clone();
            let owned_run_id = run_id.clone();
            let owned_request = request.clone();
            tauri::async_runtime::spawn(async move {
                let outcome = async {
                    let client = http_client(Duration::from_secs(600))?;
                    run_http_prompt(
                        &client,
                        &target,
                        &secret,
                        &owned_request,
                        &owned_run_id,
                        &cancel,
                        &mut |event| {
                            emit_to_frontend(&app, event);
                        },
                    )
                    .await
                }
                .await;
                if let Err(error) = outcome {
                    emit_to_frontend(
                        &app,
                        AiStreamEvent::Error(StreamError {
                            run_id: Some(owned_run_id.clone()),
                            error,
                        }),
                    );
                }
                registry.remove(&owned_run_id);
            });
            Ok(run_id)
        }
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn ai_prompt_cancel(run_id: AiRunId) -> Result<bool, AiError> {
    validate_run_id(&run_id)?;
    Ok(RUNS.cancel(&run_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{DocumentId, Revision, Utf16Offset, Utf16Range};

    fn context() -> PromptContext {
        PromptContext {
            document_id: DocumentId("doc_01".into()),
            revision: Revision(7),
            ranges: vec![Utf16Range {
                start: Utf16Offset(1),
                end: Utf16Offset(3),
            }],
            text: "a😀日本語".into(),
        }
    }

    fn acp_request() -> AiPromptRequest {
        AiPromptRequest {
            provider: AiProviderConfig {
                kind: AiProviderKind::Acp,
                acp: Some(AcpConfig {
                    preset: AcpPreset::Codex,
                    argv: None,
                }),
                openai: None,
                anthropic: None,
            },
            mode: PromptMode::Ask,
            prompt: "これは何ですか".into(),
            contexts: vec![context()],
            staging: StagingTarget {
                copy_id: IsolatedCopyId("copy_01".into()),
            },
            session_id: None,
        }
    }

    #[test]
    fn handles_accept_valid_and_reject_bad() {
        assert!(validate_handle("copy_01", "x").is_ok());
        for bad in ["", "has space", "doc/1", "文書", &"x".repeat(129)] {
            assert!(validate_handle(bad, "x").is_err(), "{bad}");
        }
    }

    #[test]
    fn claude_commands_are_refused() {
        for command in [
            "claude",
            "CLAUDE",
            "claude.exe",
            "claude-code",
            "/usr/local/bin/claude",
            "C:\\tools\\claude.exe",
        ] {
            assert!(is_claude_command(command), "{command}");
            let argv = AcpArgv {
                command: command.into(),
                args: vec![],
            };
            assert!(matches!(
                validate_argv(&argv),
                Err(AiError::ClaudeCodeRefused { .. })
            ));
        }
        for command in ["codex", "opencode", "my-agent", "claudette", "claude-extra"] {
            assert!(!is_claude_command(command), "{command}");
        }
    }

    #[test]
    fn preset_argv_resolution_is_strict() {
        let codex = AcpConfig {
            preset: AcpPreset::Codex,
            argv: None,
        };
        assert_eq!(
            resolve_acp_argv(&codex).unwrap(),
            AcpArgv {
                // Official adapter binary, never `codex acp`.
                command: "codex-acp".into(),
                args: vec![]
            }
        );
        let custom_missing = AcpConfig {
            preset: AcpPreset::Custom,
            argv: None,
        };
        assert!(resolve_acp_argv(&custom_missing).is_err());
        let preset_with_argv = AcpConfig {
            preset: AcpPreset::Opencode,
            argv: Some(AcpArgv {
                command: "x".into(),
                args: vec![],
            }),
        };
        assert!(resolve_acp_argv(&preset_with_argv).is_err());
        let custom = AcpConfig {
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: "my-agent".into(),
                args: vec!["--stdio".into()],
            }),
        };
        assert!(resolve_acp_argv(&custom).is_ok());
        let empty_command = AcpConfig {
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: String::new(),
                args: vec![],
            }),
        };
        assert!(resolve_acp_argv(&empty_command).is_err());
    }

    #[test]
    fn endpoint_validation_rejects_non_http_and_embedded_auth() {
        assert_eq!(
            validate_endpoint("https://api.example.com/v1/").unwrap(),
            "https://api.example.com/v1"
        );
        assert!(validate_endpoint("http://127.0.0.1:11434/v1").is_ok());
        for bad in [
            "ftp://x.test/v1",
            "api.example.com/v1",
            "",
            "https://",
            "https://user:pass@x.test/v1",
            "https://x.test/has space",
        ] {
            assert!(validate_endpoint(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn provider_configs_must_match_kind_and_anthropic_is_opt_in() {
        assert!(validate_provider_config(&acp_request().provider).is_ok());
        let mut openai = AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: "https://api.example.com/v1".into(),
                model: "gpt-x".into(),
            }),
            anthropic: None,
        };
        assert!(validate_provider_config(&openai).is_ok());
        openai.acp = Some(AcpConfig {
            preset: AcpPreset::Codex,
            argv: None,
        });
        assert!(validate_provider_config(&openai).is_err());

        let disabled = AiProviderConfig {
            kind: AiProviderKind::Anthropic,
            acp: None,
            openai: None,
            anthropic: Some(AnthropicConfig {
                enabled: false,
                endpoint: "https://api.anthropic.example".into(),
                model: "claude-x".into(),
            }),
        };
        assert!(matches!(
            validate_provider_config(&disabled),
            Err(AiError::InvalidConfig { .. })
        ));
        let mut enabled = disabled.clone();
        enabled.anthropic.as_mut().expect("set").enabled = true;
        assert!(validate_provider_config(&enabled).is_ok());
    }

    #[test]
    fn prompt_requests_check_ranges_against_excerpt_text() {
        assert!(validate_prompt_request(&acp_request()).is_ok());
        let mut bad = acp_request();
        bad.prompt = "   ".into();
        assert!(validate_prompt_request(&bad).is_err());
        let mut bad = acp_request();
        bad.contexts[0].ranges[0] = Utf16Range {
            start: Utf16Offset(2),
            end: Utf16Offset(3),
        }; // splits the surrogate pair of 😀
        assert!(validate_prompt_request(&bad).is_err());
        let mut bad = acp_request();
        bad.contexts[0].ranges.clear();
        assert!(validate_prompt_request(&bad).is_err());
        let mut bad = acp_request();
        bad.contexts[0].ranges[0] = Utf16Range {
            start: Utf16Offset(4),
            end: Utf16Offset(1),
        };
        assert!(validate_prompt_request(&bad).is_err());
        let mut http = acp_request();
        http.provider = AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: "https://api.example.com/v1".into(),
                model: "m".into(),
            }),
            anthropic: None,
        };
        http.session_id = Some(AcpSessionId("sess_1".into()));
        assert!(validate_prompt_request(&http).is_err());
        // Zero contexts are allowed for general questions.
        let mut bare = acp_request();
        bare.contexts.clear();
        assert!(validate_prompt_request(&bare).is_ok());
    }

    #[test]
    fn composed_message_has_exact_sent_scope() {
        let message = compose_user_message(PromptMode::Ask, "これは何ですか", &[context()]);
        assert_eq!(
            message,
            "文書について質問に回答してください。原文は変更しません。\n\
             --- context document=doc_01 revision=7 ranges=[1, 3) ---\n\
             a😀日本語\n\
             --- prompt ---\n\
             これは何ですか"
        );
    }

    #[test]
    fn sse_decoder_survives_chunk_splits_comments_and_crlf() {
        let mut decoder = SseDecoder::default();
        let mut out = decoder.push(b": ping\r\n\r\ndata: {\"a\": 1}\n\ndata: part");
        assert_eq!(out, vec!["{\"a\": 1}"]);
        out = decoder.push(b"ial\n\n");
        assert_eq!(out, vec!["partial"]);
        assert_eq!(decoder.finish(), None);
        let mut decoder = SseDecoder::default();
        decoder.push(b"data: tail");
        assert_eq!(decoder.finish(), Some("tail".to_owned()));
    }

    #[test]
    fn openai_deltas_and_errors_map_correctly() {
        let delta = r#"{"choices": [{"delta": {"content": "日本語"}, "finish_reason": null}]}"#;
        assert_eq!(openai_delta_text(delta).unwrap(), Some("日本語".to_owned()));
        let role_only = r#"{"choices": [{"delta": {"role": "assistant"}}]}"#;
        assert_eq!(openai_delta_text(role_only).unwrap(), None);
        let auth = r#"{"error": {"message": "invalid_api_key", "code": "invalid_api_key"}}"#;
        assert!(matches!(
            openai_delta_text(auth),
            Err(AiError::AuthFailed { .. })
        ));
        let other = r#"{"error": {"message": "busy", "code": "server_error"}}"#;
        assert!(matches!(
            openai_delta_text(other),
            Err(AiError::StreamFailed { .. })
        ));
        assert!(openai_delta_text("not json").is_err());
    }

    #[test]
    fn anthropic_signals_cover_text_end_error_and_noise() {
        let delta =
            r#"{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "あ"}}"#;
        assert_eq!(
            anthropic_signal(delta).unwrap(),
            AnthropicSignal::Text("あ".into())
        );
        let json_delta =
            r#"{"type": "content_block_delta", "delta": {"type": "input_json_delta"}}"#;
        assert_eq!(
            anthropic_signal(json_delta).unwrap(),
            AnthropicSignal::Ignore
        );
        assert_eq!(
            anthropic_signal(r#"{"type": "message_stop"}"#).unwrap(),
            AnthropicSignal::End
        );
        assert_eq!(
            anthropic_signal(r#"{"type": "message_start"}"#).unwrap(),
            AnthropicSignal::Ignore
        );
        let auth =
            r#"{"type": "error", "error": {"type": "authentication_error", "message": "bad key"}}"#;
        assert!(matches!(
            anthropic_signal(auth),
            Err(AiError::AuthFailed { .. })
        ));
    }

    #[test]
    fn http_status_maps_to_auth_or_connection_errors() {
        assert!(map_http_status(200, "").is_none());
        assert!(matches!(
            map_http_status(401, "nope"),
            Some(AiError::AuthFailed { .. })
        ));
        assert!(matches!(
            map_http_status(500, "boom"),
            Some(AiError::ConnectionFailed { .. })
        ));
    }

    /// BufRead that yields at most `max` bytes per read, forcing the real
    /// NdjsonReader through fragmentation (including mid-UTF-8 splits).
    struct Chunked<'a> {
        data: &'a [u8],
        max: usize,
    }

    impl std::io::Read for Chunked<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.data.is_empty() {
                return Ok(0);
            }
            let take = self.data.len().min(buf.len()).min(self.max);
            buf[..take].copy_from_slice(&self.data[..take]);
            self.data = &self.data[take..];
            Ok(take)
        }
    }

    impl std::io::BufRead for Chunked<'_> {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            Ok(self.data)
        }

        fn consume(&mut self, amount: usize) {
            self.data = &self.data[amount.min(self.data.len())..];
        }
    }

    #[test]
    fn ndjson_survives_fragmentation_coalescing_and_utf8_splits() {
        let first = serde_json::json!({"jsonrpc": "2.0", "id": 1});
        let second = serde_json::json!({"jsonrpc": "2.0", "method": "n", "params": {"text": "こんにちは世界"}});
        let mut bytes = encode_acp_message(&first);
        bytes.extend_from_slice(&encode_acp_message(&second));
        // Compact encoding: exactly one trailing newline per message, none inside.
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 2);
        assert!(bytes.ends_with(b"\n"));

        // Fragmented reads down to one byte per read: splits fall inside
        // multibyte UTF-8 sequences and still decode.
        for max in [1usize, 2, 3, 7] {
            let mut reader = NdjsonReader::new(Chunked { data: &bytes, max });
            assert_eq!(reader.next_value().unwrap(), Some(first.clone()));
            assert_eq!(reader.next_value().unwrap(), Some(second.clone()));
            assert_eq!(reader.next_value().unwrap(), None);
        }

        // Coalesced read: the whole stream at once also works.
        let mut reader = NdjsonReader::new(&bytes[..]);
        assert_eq!(reader.next_value().unwrap(), Some(first));
        assert_eq!(reader.next_value().unwrap(), Some(second));
        assert_eq!(reader.next_value().unwrap(), None);
    }

    #[test]
    fn ndjson_rejects_bad_lines_and_limits_size() {
        // Invalid UTF-8.
        let mut reader = NdjsonReader::new(&b"\xff\xfe\n"[..]);
        assert!(matches!(
            reader.next_value(),
            Err(AiError::StreamFailed { .. })
        ));
        // Invalid JSON.
        let mut reader = NdjsonReader::new(&b"{oops}\n"[..]);
        assert!(reader.next_value().is_err());
        // Clean EOF.
        let mut reader = NdjsonReader::new(&[][..]);
        assert_eq!(reader.next_value().unwrap(), None);
        // Truncated line at EOF.
        let mut reader = NdjsonReader::new(&b"{\"a\": 1"[..]);
        assert!(reader.next_value().is_err());
        // Oversized line.
        let mut big = vec![b' '; MAX_ACP_LINE_BYTES + 16];
        big.push(b'\n');
        let mut reader = NdjsonReader::new(&big[..]);
        assert!(reader.next_value().is_err());
        // Empty lines are skipped, CRLF is tolerated.
        let mut reader = NdjsonReader::new(&b"\n{\"a\": 1}\r\n\n"[..]);
        assert_eq!(
            reader.next_value().unwrap(),
            Some(serde_json::json!({"a": 1}))
        );
        assert_eq!(reader.next_value().unwrap(), None);
    }

    #[test]
    fn incoming_messages_classify_by_id_and_method() {
        let response = serde_json::json!({"jsonrpc": "2.0", "id": 3, "result": {}});
        assert!(matches!(
            classify_incoming(response),
            Ok(AgentIncoming::Response { .. })
        ));
        let notification = serde_json::json!({"jsonrpc": "2.0", "method": "session/update"});
        assert!(matches!(
            classify_incoming(notification),
            Ok(AgentIncoming::Notification(_))
        ));
        let agent_request = serde_json::json!({
            "jsonrpc": "2.0", "id": 9, "method": "session/request_permission", "params": {}
        });
        match classify_incoming(agent_request).unwrap() {
            AgentIncoming::AgentRequest { id, method, .. } => {
                assert_eq!(id, serde_json::json!(9));
                assert_eq!(method, "session/request_permission");
            }
            other => panic!("expected agent request, got {other:?}"),
        }
        let malformed = serde_json::json!({"jsonrpc": "2.0"});
        assert!(classify_incoming(malformed).is_err());
    }

    #[test]
    fn protocol_version_negotiation_is_explicit() {
        let ok = serde_json::json!({"result": {"protocolVersion": 1}});
        assert_eq!(check_protocol_version(&ok).unwrap(), 1);
        let newer = serde_json::json!({"result": {"protocolVersion": 2}});
        assert!(matches!(
            check_protocol_version(&newer),
            Err(AiError::UnsupportedProtocol { version: 2 })
        ));
        let missing = serde_json::json!({"result": {}});
        assert!(check_protocol_version(&missing).is_err());
        let roundtrip: AiError = serde_json::from_value(
            serde_json::to_value(AiError::UnsupportedProtocol { version: 2 }).unwrap(),
        )
        .unwrap();
        assert_eq!(roundtrip, AiError::UnsupportedProtocol { version: 2 });
    }

    #[test]
    fn permission_answers_deny_by_default_with_exact_shapes() {
        let params = serde_json::json!({
            "options": [
                { "optionId": "allow", "name": "許可", "kind": "allow_once" },
                { "optionId": "deny", "name": "拒否", "kind": "reject_once" }
            ]
        });
        assert_eq!(
            answer_permission(&params, PermissionAnswer::Deny),
            serde_json::json!({
                "outcome": { "outcome": "selected", "optionId": "deny" }
            })
        );
        assert_eq!(
            answer_permission(&params, PermissionAnswer::Cancelled),
            serde_json::json!({ "outcome": { "outcome": "cancelled" } })
        );
        let without_reject = serde_json::json!({
            "options": [{ "optionId": "allow", "name": "許可", "kind": "allow_always" }]
        });
        assert_eq!(
            answer_permission(&without_reject, PermissionAnswer::Deny),
            serde_json::json!({ "outcome": { "outcome": "cancelled" } })
        );
        let unknown = method_not_found(&serde_json::json!(7), "fs/read_text_file");
        assert_eq!(unknown["error"]["code"], -32601);
        assert_eq!(unknown["id"], 7);
    }

    #[test]
    fn stop_reasons_route_cancellation() {
        for (raw, expected) in [
            ("end_turn", StopReason::EndTurn),
            ("max_tokens", StopReason::MaxTokens),
            ("max_turn_requests", StopReason::MaxTurnRequests),
            ("refusal", StopReason::Refusal),
            ("cancelled", StopReason::Cancelled),
        ] {
            let body = serde_json::json!({"result": {"stopReason": raw}});
            assert_eq!(parse_stop_reason(&body).unwrap(), expected);
        }
        assert!(parse_stop_reason(&serde_json::json!({"result": {}})).is_err());
    }

    #[test]
    fn acp_builders_and_update_parsing_keep_protocol_shape() {
        let init = acp_initialize(1);
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["protocolVersion"], 1);
        assert_eq!(init["params"]["clientInfo"]["name"], "marxen");
        let dir = Path::new("/tmp/staging-copy");
        let new = acp_session_new(2, dir);
        assert_eq!(new["params"]["cwd"], "/tmp/staging-copy");
        assert_eq!(new["params"]["mcpServers"], serde_json::json!([]));
        let prompt = acp_session_prompt(3, "sess_1", PromptMode::Ask, "p", &[context()]);
        assert_eq!(prompt["params"]["sessionId"], "sess_1");
        assert!(prompt["params"]["prompt"][0]["text"]
            .as_str()
            .expect("text")
            .contains("doc_01"));
        // session/cancel is a notification: no id.
        let cancel = acp_session_cancel_notification("sess_1");
        assert_eq!(cancel["method"], "session/cancel");
        assert!(cancel.get("id").is_none());

        let update = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "sess_1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "あい" }
                }
            }
        });
        assert_eq!(acp_update_text(&update), Some("あい".to_owned()));
        let tool_call = serde_json::json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "tool_call" } }
        });
        assert_eq!(acp_update_text(&tool_call), None);
    }

    #[test]
    fn tracker_enforces_lifecycle() {
        let mut tracker = AcpSessionTracker::new();
        assert_eq!(tracker.prompt_started(None), Err(AiError::SessionRequired));
        tracker.initialized();
        assert_eq!(tracker.prompt_started(None), Err(AiError::SessionRequired));
        tracker.session_opened("sess_1".into());
        assert_eq!(tracker.session(), Some("sess_1"));
        assert!(tracker.prompt_started(None).is_ok());
        assert_eq!(tracker.prompt_started(None), Err(AiError::SessionBusy));
        tracker.prompt_finished();
        assert_eq!(
            tracker.prompt_started(Some("other")),
            Err(AiError::UnknownSession)
        );
        assert!(tracker.prompt_started(Some("sess_1")).is_ok());
    }

    #[test]
    fn memory_keyring_holds_separate_slots() {
        let keyring = MemoryKeyring::default();
        assert!(!keyring.has(AiProviderKind::OpenaiCompatible).unwrap());
        keyring
            .set(AiProviderKind::OpenaiCompatible, "s3cret")
            .unwrap();
        assert!(keyring.has(AiProviderKind::OpenaiCompatible).unwrap());
        assert!(!keyring.has(AiProviderKind::Anthropic).unwrap());
        assert_ne!(
            credential_account(AiProviderKind::OpenaiCompatible),
            credential_account(AiProviderKind::Anthropic)
        );
        keyring.delete(AiProviderKind::OpenaiCompatible).unwrap();
        assert!(!keyring.has(AiProviderKind::OpenaiCompatible).unwrap());
        assert!(validate_secret("").is_err());
    }

    #[test]
    fn staging_guard_rejects_escapes() {
        let root = Path::new("/staging");
        assert!(guard_staging_path(root, Path::new("copy_01/notes.md")).is_ok());
        assert!(matches!(
            guard_staging_path(root, Path::new("../live/doc.md")),
            Err(AiError::LiveTargetRejected { .. })
        ));
        assert!(matches!(
            guard_staging_path(root, Path::new("/etc/passwd")),
            Err(AiError::LiveTargetRejected { .. })
        ));
        assert!(guard_staging_path(Path::new(""), Path::new("copy")).is_err());
    }

    #[test]
    fn mock_script_emits_started_chunks_done_with_sent_echo() {
        let request = acp_request();
        let run_id = AiRunId("run_1".into());
        let script = MockScript {
            chunks: vec!["こんにちは".into(), "世界".into()],
            fail: None,
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let composed = run_mock_script(&request, &run_id, &script, &cancel, &mut |event| {
            events.push(event);
        });
        assert!(composed.contains("doc_01"));
        assert!(matches!(events[0], AiStreamEvent::Started(_)));
        assert!(matches!(events[1], AiStreamEvent::Chunk(_)));
        match events.last().expect("done") {
            AiStreamEvent::Done(done) => {
                assert_eq!(done.proposal.text, "こんにちは世界");
                assert_eq!(done.proposal.base_contexts.len(), 1);
                assert_eq!(done.proposal.base_contexts[0].revision, Revision(7));
                assert_eq!(done.sent.len(), 1);
                assert_eq!(done.sent[0].chars, "a😀日本語".chars().count() as u32);
            }
            other => panic!("expected done, got {other:?}"),
        }
    }

    #[test]
    fn mock_script_honors_cancel_and_failure() {
        let request = acp_request();
        let run_id = AiRunId("run_2".into());
        let script = MockScript {
            chunks: vec!["x".into()],
            fail: None,
        };
        let cancel = AtomicBool::new(true);
        let mut events = Vec::new();
        run_mock_script(&request, &run_id, &script, &cancel, &mut |event| {
            events.push(event);
        });
        assert!(matches!(events[1], AiStreamEvent::Cancelled(_)));

        let script = MockScript {
            chunks: vec![],
            fail: Some(AiError::AuthFailed {
                detail: "bad key".into(),
            }),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        run_mock_script(&request, &run_id, &script, &cancel, &mut |event| {
            events.push(event);
        });
        assert!(matches!(events[1], AiStreamEvent::Error(_)));
    }

    #[test]
    fn missing_binaries_report_without_spawning_agents() {
        let argv = AcpArgv {
            command: "marxen-definitely-missing-binary".into(),
            args: vec![],
        };
        assert!(matches!(
            spawn_acp(&argv, Path::new("/tmp")),
            Err(AiError::MissingBinary { .. })
        ));
    }

    #[test]
    fn wire_rejects_claude_presets_and_tags_cancellation() {
        let rejected: Result<AcpPreset, _> = serde_json::from_str("\"claude_code\"");
        assert!(rejected.is_err());
        let value = serde_json::to_value(AiError::RequestCancelled).unwrap();
        assert_eq!(value, serde_json::json!({"code": "request_cancelled"}));
        let roundtrip: AiError = serde_json::from_value(value).unwrap();
        assert_eq!(roundtrip, AiError::RequestCancelled);
    }
}
