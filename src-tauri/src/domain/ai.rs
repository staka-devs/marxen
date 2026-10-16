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

/// Return true for Windows script extensions that `CreateProcess` cannot
/// execute directly and that must never be spawned without resolution.
pub fn is_windows_script_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "cmd" | "bat" | "ps1"
    )
}

/// Return true only for directly spawnable Windows executables (`.exe`/`.com`,
/// case-insensitive). Extensionless npm wrappers and `.cmd`/`.bat`/`.ps1`
/// shims return false; they require `resolve_acp_launch` handling.
pub fn is_direct_windows_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "exe" | "com"))
}

/// Split a `PATHEXT`-style `;.EXE;...` list into ordered bare extensions
/// without a leading dot, lowercased for case-insensitive comparison.
/// Empty, duplicate, and invalid entries are dropped; first-seen order is preserved.
pub fn parse_windows_pathext(pathext: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in pathext.split(';') {
        let ext = raw.trim().trim_start_matches('.').to_ascii_lowercase();
        if ext.is_empty() || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
            continue;
        }
        if seen.insert(ext.clone()) {
            out.push(ext);
        }
    }
    out
}

/// Return the fallback Windows executable order used when `PATHEXT` is absent.
/// Covers directly runnable `.com`/`.exe` plus official npm shims
/// (`.bat`/`.cmd`/`.ps1`); other script types are intentionally omitted.
pub fn default_windows_pathext() -> Vec<String> {
    ["com", "exe", "bat", "cmd", "ps1"]
        .iter()
        .map(|ext| (*ext).to_owned())
        .collect()
}

/// Detect authentication markers in an ACP JSON-RPC error message.
/// Matches `auth_required`, authentication/unauthorized phrases, invalid-key
/// markers, and bare 401/403 codes case-insensitively; pure string check.
pub fn is_auth_required_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "auth_required",
        "auth required",
        "authentication required",
        "authentication failed",
        "unauthorized",
        "invalid_api_key",
        "invalid api key",
        "login required",
        "needs authentication",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower.contains(" 401")
        || lower.contains(" 403")
        || lower.contains("(401")
        || lower.contains("(403")
}

/// Map an ACP JSON-RPC error detail to a bounded actionable failure.
/// Authentication markers become `AuthFailed` with terminal-login
/// guidance; all other errors become `StreamFailed` prefixed by the caller
/// context. Details are truncated to 500 Unicode scalars.
pub fn map_acp_rpc_error(context: &str, code: Option<i64>, detail: &str) -> AiError {
    let excerpt: String = detail.chars().take(500).collect();
    if code == Some(-32000) || is_auth_required_message(&excerpt) {
        return AiError::AuthFailed {
            detail: format!(
                "{context}: 認証を確認してください。利用する CLI でログインし、接続を再試行してください ({excerpt})"
            ),
        };
    }
    AiError::StreamFailed {
        detail: format!("{context}: {excerpt}"),
    }
}

/// Return an actionable Japanese install hint for a missing ACP executable.
/// Names only official packages; never downloads or modifies global state.
pub fn missing_binary_hint(command: &str) -> String {
    let lower = command.to_ascii_lowercase();
    let base = basename_of(&lower);
    if base.contains("codex-acp") {
        "npm install -g @agentclientprotocol/codex-acp で導入し PATH を通してください".into()
    } else if base.contains("opencode") {
        "opencode v2 を導入し PATH を通してください（例: npm の @opencode/cli、https://opencode.ai）".into()
    } else if base.contains("claude-agent-acp") {
        "npm install -g @agentclientprotocol/claude-agent-acp で導入し、利用するホストで Claude Code にログインしてください".into()
    } else if base == "devin" || base == "devin.exe" {
        "Devin CLI を導入し、devin auth login でログインしてください（https://docs.devin.ai/cli）"
            .into()
    } else if base.contains("copilot") {
        "GitHub Copilot CLI を導入し PATH を通してください".into()
    } else if base.contains("node") {
        "Node.js を導入し PATH を通してください".into()
    } else {
        "CLI をインストールして PATH を通してください".into()
    }
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
        AcpPreset::ClaudeCode => AcpArgv {
            command: "claude-agent-acp".into(),
            args: vec![],
        },
        AcpPreset::Devin => AcpArgv {
            command: "devin".into(),
            args: vec!["acp".into()],
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
/// A named-connection reference never accompanies ACP: agents resolve presets,
/// never per-connection credential slots.
pub fn validate_provider_config(config: &AiProviderConfig) -> Result<(), AiError> {
    if config.connection_id.is_some() && config.kind == AiProviderKind::Acp {
        return Err(invalid("ACP に接続先 ID は付けません"));
    }
    if let Some(id) = config.connection_id.as_ref() {
        validate_connection_id(id)?;
    }
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
        AiProviderKind::OpenaiChatCompletions | AiProviderKind::OpenaiResponses => {
            if config.acp.is_some() || config.anthropic.is_some() {
                return Err(invalid("OpenAIには他の backend 設定を付けません"));
            }
            let openai = config
                .openai
                .as_ref()
                .ok_or_else(|| invalid("OpenAIの設定が必要です"))?;
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

// ---- Server-sent events (shared by OpenAI Chat Completions and Anthropic) ----

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

/// Recognize the OpenAI Chat Completions `[DONE]` sentinel with surrounding whitespace allowed.
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

/// Extract streamed text from an OpenAI Chat Completions chat chunk.
/// Missing content is ignored; malformed JSON or provider errors fail the stream,
/// with recognized unauthorized/API-key messages classified as authentication failures.
pub fn openai_delta_text(data: &str) -> Result<Option<String>, AiError> {
    let value: serde_json::Value =
        serde_json::from_str(data).map_err(|_| AiError::StreamFailed {
            detail: "OpenAI Chat Completionsの応答を解釈できません".into(),
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

/// Build an ACP v1 initialize request with staged file capabilities.
///
/// Advertises `fs.readTextFile`/`fs.writeTextFile` so agents use the
/// authorized staging directory through the client instead of escaping it.
/// Terminals, elicitation, and session notices/compaction stay unadvertised:
/// no external terminal window is ever created.
pub fn acp_initialize(id: u64) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } },
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

/// Map an official wire tool kind to the contract, defaulting unknown values to `Other`.
/// Omission and null both mean `Other` so display never fails on new agent kinds.
pub fn parse_tool_kind(value: Option<&Value>) -> AcpToolKind {
    match value.and_then(|kind| kind.as_str()) {
        Some("read") => AcpToolKind::Read,
        Some("edit") => AcpToolKind::Edit,
        Some("delete") => AcpToolKind::Delete,
        Some("move") => AcpToolKind::Move,
        Some("search") => AcpToolKind::Search,
        Some("execute") => AcpToolKind::Execute,
        Some("think") => AcpToolKind::Think,
        Some("fetch") => AcpToolKind::Fetch,
        Some("switch_mode") => AcpToolKind::SwitchMode,
        _ => AcpToolKind::Other,
    }
}

/// Map an official wire tool status to the contract.
/// Unknown or absent statuses yield `None` so callers drop the malformed update
/// instead of recording a dishonest lifecycle step.
pub fn parse_tool_status(value: Option<&Value>) -> Option<AcpToolStatus> {
    match value.and_then(|status| status.as_str()) {
        Some("pending") => Some(AcpToolStatus::Pending),
        Some("in_progress") => Some(AcpToolStatus::InProgress),
        Some("completed") => Some(AcpToolStatus::Completed),
        Some("failed") => Some(AcpToolStatus::Failed),
        _ => None,
    }
}

/// Validate one tool-call handle as a 1–128-byte ASCII alphanumeric/hyphen/underscore/dot token.
/// Dots are accepted for agent-generated call IDs such as `call_001`.
/// Invalid handles yield `None` so callers drop the update.
pub fn validate_tool_call_id(id: &str) -> Option<String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    {
        return None;
    }
    Some(id.to_owned())
}

/// Parse one `ToolCallContent` item from a tool-call content array.
/// Text blocks surface their text; diff blocks surface validated paths with
/// old/new text; terminal blocks are ignored (no external terminal window)
/// and unknown shapes yield `None`.
fn parse_tool_content_item(item: &Value) -> Option<ToolCallContent> {
    match item.get("type").and_then(|kind| kind.as_str()) {
        Some("content") => {
            let text = item
                .pointer("/content/text")
                .and_then(|text| text.as_str())?;
            if text.chars().count() > MAX_PROMPT_CHARS {
                return None;
            }
            Some(ToolCallContent::Content {
                text: text.to_owned(),
            })
        }
        Some("diff") => {
            let path = item.get("path").and_then(|path| path.as_str())?;
            if path.is_empty() || path.len() > 1024 {
                return None;
            }
            let old_text = item
                .get("oldText")
                .and_then(|text| text.as_str())
                .map(str::to_owned);
            let new_text = item
                .get("newText")
                .and_then(|text| text.as_str())?
                .to_owned();
            if new_text.chars().count() > MAX_EXCERPT_BYTES {
                return None;
            }
            Some(ToolCallContent::Diff {
                path: path.to_owned(),
                old_text,
                new_text,
            })
        }
        _ => None,
    }
}

/// Parse an optional content array, dropping terminal/unknown items.
/// Returns `None` when the field is absent; an empty vector when present but
/// every item was terminal/unknown so callers still record the lifecycle step.
fn parse_tool_content_list(update: &Value) -> Option<Vec<ToolCallContent>> {
    let items = update.get("content")?.as_array()?;
    if items.len() > 32 {
        return None;
    }
    let mut out = Vec::new();
    for item in items {
        if let Some(content) = parse_tool_content_item(item) {
            out.push(content);
        }
    }
    Some(out)
}

/// Parse optional follow-along locations, keeping at most 16 entries.
/// Paths must be non-empty absolute display strings; line numbers must fit u32.
/// Malformed lists yield `None` so callers drop the update.
fn parse_tool_locations(update: &Value) -> Option<Vec<ToolCallLocation>> {
    let items = update.get("locations")?.as_array()?;
    if items.len() > 16 {
        return None;
    }
    let mut out = Vec::new();
    for item in items {
        let path = item.get("path").and_then(|path| path.as_str())?;
        if path.is_empty() || path.len() > 1024 {
            return None;
        }
        let line = match item.get("line") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64().and_then(|n| u32::try_from(n).ok())?),
        };
        out.push(ToolCallLocation {
            path: path.to_owned(),
            line,
        });
    }
    Some(out)
}

/// Shorten an absolute wire path to a staging-relative display name.
/// Returns the file name when the path sits inside `staging_dir`; otherwise
/// returns the full path truncated to 128 chars so outside paths stay visible
/// but never expose live directory structure beyond the file name when contained.
pub fn display_path_for_staging(abs_path: &str, staging_dir: &Path) -> String {
    let candidate = Path::new(abs_path);
    if let Ok(rel) = candidate.strip_prefix(staging_dir) {
        let display = rel.to_string_lossy().replace('\\', "/");
        if !display.is_empty() {
            return display;
        }
    }
    if let Some(name) = candidate.file_name().and_then(|name| name.to_str()) {
        if candidate.starts_with(staging_dir) {
            return name.to_owned();
        }
    }
    abs_path.chars().take(128).collect()
}

/// Rewrite absolute wire locations into staging-relative display names.
/// Leaves the update unchanged when no locations are present.
pub fn relativize_tool_locations(
    locations: Vec<ToolCallLocation>,
    staging_dir: &Path,
) -> Vec<ToolCallLocation> {
    locations
        .into_iter()
        .map(|location| ToolCallLocation {
            path: display_path_for_staging(&location.path, staging_dir),
            line: location.line,
        })
        .collect()
}

/// Parse one official `session/update` with `sessionUpdate == "tool_call"`.
/// The wire `sessionId` must equal `expected_session`; foreign sessions yield
/// `None`. Requires a valid `toolCallId` and non-empty title; kind defaults to
/// `Other` and status defaults to `Pending`. At most 32 content items and 16
/// locations are kept; malformed lists reject the update.
pub fn parse_tool_call_notification(
    note: &Value,
    expected_session: &str,
    staging_dir: &Path,
) -> Option<AcpToolCall> {
    if note.get("method")?.as_str()? != "session/update" {
        return None;
    }
    let params = note.get("params")?;
    if params.get("sessionId")?.as_str()? != expected_session {
        return None;
    }
    let update = params.get("update")?;
    if update.get("sessionUpdate")?.as_str()? != "tool_call" {
        return None;
    }
    let tool_call_id = validate_tool_call_id(update.get("toolCallId")?.as_str()?)?;
    let title = update.get("title").and_then(|title| title.as_str())?;
    if title.is_empty() || title.chars().count() > 512 {
        return None;
    }
    let kind = parse_tool_kind(update.get("kind"));
    let status = parse_tool_status(update.get("status")).unwrap_or(AcpToolStatus::Pending);
    let content = match update.get("content") {
        None | Some(Value::Null) => None,
        Some(_) => Some(parse_tool_content_list(update)?),
    };
    let locations = match update.get("locations") {
        None | Some(Value::Null) => None,
        Some(_) => Some(relativize_tool_locations(
            parse_tool_locations(update)?,
            staging_dir,
        )),
    };
    Some(AcpToolCall {
        tool_call_id,
        title: title.to_owned(),
        kind,
        status,
        content,
        locations,
    })
}

/// Parse one official `session/update` with `sessionUpdate == "tool_call_update"`.
/// Foreign sessions yield `None`. Requires a valid `toolCallId`; all other
/// fields are optional patches. Malformed present lists reject the update.
pub fn parse_tool_call_update_notification(
    note: &Value,
    expected_session: &str,
    staging_dir: &Path,
) -> Option<AcpToolCallUpdate> {
    if note.get("method")?.as_str()? != "session/update" {
        return None;
    }
    let params = note.get("params")?;
    if params.get("sessionId")?.as_str()? != expected_session {
        return None;
    }
    let update = params.get("update")?;
    if update.get("sessionUpdate")?.as_str()? != "tool_call_update" {
        return None;
    }
    let tool_call_id = validate_tool_call_id(update.get("toolCallId")?.as_str()?)?;
    let title = match update.get("title") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let text = value.as_str()?;
            if text.is_empty() || text.chars().count() > 512 {
                return None;
            }
            Some(text.to_owned())
        }
    };
    let kind = match update.get("kind") {
        None | Some(Value::Null) => None,
        Some(_) => Some(parse_tool_kind(update.get("kind"))),
    };
    let status = match update.get("status") {
        None | Some(Value::Null) => None,
        Some(_) => Some(parse_tool_status(update.get("status"))?),
    };
    let content = match update.get("content") {
        None | Some(Value::Null) => None,
        Some(_) => Some(parse_tool_content_list(update)?),
    };
    let locations = match update.get("locations") {
        None | Some(Value::Null) => None,
        Some(_) => Some(relativize_tool_locations(
            parse_tool_locations(update)?,
            staging_dir,
        )),
    };
    Some(AcpToolCallUpdate {
        tool_call_id,
        title,
        kind,
        status,
        content,
        locations,
    })
}

/// Parse one official `session/update` with `sessionUpdate == "plan"`.
/// Foreign sessions yield `None`. Requires 1–16 entries with non-empty content
/// (at most 512 chars) and valid priority/status; the payload always carries
/// the complete list for replacement.
pub fn parse_plan_notification(note: &Value, expected_session: &str) -> Option<Vec<PlanEntry>> {
    if note.get("method")?.as_str()? != "session/update" {
        return None;
    }
    let params = note.get("params")?;
    if params.get("sessionId")?.as_str()? != expected_session {
        return None;
    }
    let update = params.get("update")?;
    if update.get("sessionUpdate")?.as_str()? != "plan" {
        return None;
    }
    let entries = update.get("entries")?.as_array()?;
    if entries.is_empty() || entries.len() > 16 {
        return None;
    }
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let content = entry.get("content").and_then(|content| content.as_str())?;
        if content.is_empty() || content.chars().count() > 512 {
            return None;
        }
        let priority = match entry.get("priority").and_then(|priority| priority.as_str()) {
            Some("high") => PlanEntryPriority::High,
            Some("medium") => PlanEntryPriority::Medium,
            Some("low") => PlanEntryPriority::Low,
            _ => return None,
        };
        let status = match entry.get("status").and_then(|status| status.as_str()) {
            Some("pending") => PlanEntryStatus::Pending,
            Some("in_progress") => PlanEntryStatus::InProgress,
            Some("completed") => PlanEntryStatus::Completed,
            _ => return None,
        };
        out.push(PlanEntry {
            content: content.to_owned(),
            priority,
            status,
        });
    }
    Some(out)
}

/// Parsed `session/request_permission` awaiting a user choice in chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPermission {
    /// Stringified JSON-RPC request ID for the reply envelope.
    pub request_id: String,
    /// Session the request claims; callers verify it equals the active session.
    pub session_id: String,
    /// Tool call the request refers to, when supplied.
    pub tool_call_id: Option<String>,
    /// Human-readable tool title for the permission card.
    pub title: String,
    /// User-choosable options in wire order.
    pub options: Vec<PermissionOption>,
}

/// Stringify a JSON-RPC request ID (number or string) for permission bookkeeping.
/// Other shapes yield `None` so callers answer with a protocol error.
pub fn stringify_request_id(id: &Value) -> Option<String> {
    match id {
        Value::String(text) if !text.is_empty() && text.len() <= 128 => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Parse one official `session/request_permission` agent request.
/// Requires a usable request ID, a session ID, and 1–8 options with valid
/// IDs/names/kinds. Wrong shapes yield `None` so callers answer with a
/// protocol error instead of recording a dishonest choice.
pub fn parse_permission_request(id: &Value, params: &Value) -> Option<ParsedPermission> {
    let request_id = stringify_request_id(id)?;
    let session_id = params
        .get("sessionId")
        .and_then(|id| id.as_str())?
        .to_owned();
    if session_id.is_empty() || session_id.len() > 256 {
        return None;
    }
    let options = params.get("options")?.as_array()?;
    if options.is_empty() || options.len() > 8 {
        return None;
    }
    let mut parsed = Vec::with_capacity(options.len());
    for option in options {
        let option_id = option.get("optionId").and_then(|id| id.as_str())?;
        let name = option.get("name").and_then(|name| name.as_str())?;
        let kind = match option.get("kind").and_then(|kind| kind.as_str()) {
            Some("allow_once") => PermissionOptionKind::AllowOnce,
            Some("allow_always") => PermissionOptionKind::AllowAlways,
            Some("reject_once") => PermissionOptionKind::RejectOnce,
            Some("reject_always") => PermissionOptionKind::RejectAlways,
            _ => return None,
        };
        if option_id.is_empty()
            || option_id.len() > 128
            || name.is_empty()
            || name.chars().count() > 128
        {
            return None;
        }
        parsed.push(PermissionOption {
            option_id: option_id.to_owned(),
            name: name.to_owned(),
            kind,
        });
    }
    let tool_call = params.get("toolCall");
    let tool_call_id = tool_call
        .and_then(|call| call.get("toolCallId"))
        .and_then(|id| id.as_str())
        .and_then(validate_tool_call_id);
    let title = tool_call
        .and_then(|call| call.get("title"))
        .and_then(|title| title.as_str())
        .unwrap_or("ツール実行の許可")
        .chars()
        .take(512)
        .collect();
    Some(ParsedPermission {
        request_id,
        session_id,
        tool_call_id,
        title,
        options: parsed,
    })
}

/// Build the `result` payload answering `session/request_permission` with an explicit user choice.
/// The `option_id` must be one of the offered options; callers validate before
/// invoking. Cancellation uses the spec's `cancelled` outcome.
pub fn answer_permission_by_id(option_id: &str, cancelled: bool) -> Value {
    if cancelled {
        return serde_json::json!({ "outcome": { "outcome": "cancelled" } });
    }
    serde_json::json!({
        "outcome": { "outcome": "selected", "optionId": option_id }
    })
}

/// Check whether an absolute wire path is lexically contained in the staging directory.
///
/// Pure path rules with no filesystem access: the candidate must be absolute,
/// strip to a non-empty relative path under the staging root. Existence,
/// canonicalization, and symlink escapes are checked by the infrastructure
/// file handlers, never here.
pub fn staging_path_is_contained(staging_dir: &Path, abs_path: &str) -> bool {
    let candidate = Path::new(abs_path);
    if !candidate.is_absolute() {
        return false;
    }
    match candidate.strip_prefix(staging_dir) {
        Ok(rel) => rel.components().count() != 0,
        Err(_) => false,
    }
}

// ---- ACP usage reporting (Issue #59, official schema only) ----

/// Largest integer exactly representable in a JavaScript number.
/// Wire counters above this bound are rejected instead of being silently rounded.
pub const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

/// Validate one official token counter as an exact integer within the
/// JavaScript-safe range. Negative, fractional, and out-of-range values yield
/// `None` so callers drop the report instead of recording dishonest data.
pub fn validate_token_counter(value: &Value) -> Option<u64> {
    let counter = value.as_u64()?;
    (counter <= JS_SAFE_INTEGER_MAX).then_some(counter)
}

/// Validate one official cost amount as a finite non-negative JSON number
/// within the JavaScript-safe range and render it as decimal text.
/// Non-numbers, negative, non-finite, and out-of-range amounts yield `None`.
/// The text form keeps the `Eq` contract without binary float rounding.
pub fn validate_cost_amount(value: &Value) -> Option<String> {
    if let Some(number) = value.as_u64() {
        return (number <= JS_SAFE_INTEGER_MAX).then(|| number.to_string());
    }
    let amount = value.as_f64()?;
    if !amount.is_finite() || amount < 0.0 || amount > JS_SAFE_INTEGER_MAX as f64 {
        return None;
    }
    Some(format!("{amount}"))
}

/// Validate an ISO 4217 currency code as three ASCII letters and normalize it
/// to uppercase. Any other shape yields `None` so malformed costs are dropped.
pub fn validate_currency_code(code: &str) -> Option<String> {
    if code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        Some(code.to_ascii_uppercase())
    } else {
        None
    }
}

/// Return the ACP preset carried by the request provider, if any.
/// This labels reports for the popup; it never reads wire `_meta`.
pub fn acp_preset_of(provider: &AiProviderConfig) -> Option<AcpPreset> {
    match provider.kind {
        AiProviderKind::Acp => provider.acp.as_ref().map(|config| config.preset),
        AiProviderKind::OpenaiChatCompletions
        | AiProviderKind::OpenaiResponses
        | AiProviderKind::Anthropic => None,
    }
}

/// Map a wire source to its honestly reported scope. `usage_update` is
/// session-scoped; unstable `PromptResponse.usage` keeps the undefined scope
/// label because turn-versus-session meaning differs across implementations.
pub fn usage_scope_for_source(source: AcpUsageSource) -> AcpUsageScope {
    match source {
        AcpUsageSource::UsageUpdate => AcpUsageScope::Session,
        AcpUsageSource::PromptResponse => AcpUsageScope::PromptResponseUndefined,
    }
}

/// Validate one official `Cost` object into IPC form. Malformed amounts or
/// currency codes yield `None`; callers keep the surrounding context counters
/// while dropping only the dishonest cost.
fn validate_usage_cost(cost: &Value) -> Option<UsageCost> {
    if cost.is_null() {
        return None;
    }
    let amount = validate_cost_amount(cost.get("amount")?)?;
    let currency = validate_currency_code(cost.get("currency")?.as_str()?)?;
    Some(UsageCost { amount, currency })
}

/// Parse one official `session/update` with `sessionUpdate == "usage_update"`.
/// The wire `sessionId` must equal `expected_session`; foreign sessions yield
/// `None` so notifications never mix costs across sessions. `used`/`size` are
/// current context occupancy (not a plan quota) and are required; a malformed
/// cost is dropped while valid context counters are still reported. Arbitrary
/// `_meta` names are never read.
pub fn parse_usage_update_notification(
    note: &Value,
    expected_session: &str,
    provider: AiProviderKind,
    preset: Option<AcpPreset>,
    run_id: &AiRunId,
    received_ms: u64,
) -> Option<ReportedUsage> {
    if note.get("method")?.as_str()? != "session/update" {
        return None;
    }
    let params = note.get("params")?;
    if params.get("sessionId")?.as_str()? != expected_session {
        return None;
    }
    let update = params.get("update")?;
    if update.get("sessionUpdate")?.as_str()? != "usage_update" {
        return None;
    }
    let used = validate_token_counter(update.get("used")?)?;
    let size = validate_token_counter(update.get("size")?)?;
    let cost = update.get("cost").and_then(validate_usage_cost);
    Some(ReportedUsage {
        provider,
        preset,
        run_id: run_id.clone(),
        session_id: AcpSessionId(expected_session.to_owned()),
        source: AcpUsageSource::UsageUpdate,
        scope: usage_scope_for_source(AcpUsageSource::UsageUpdate),
        used: Some(used),
        size: Some(size),
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        cached_read_tokens: None,
        cached_write_tokens: None,
        reasoning_tokens: None,
        cost,
        received_ms,
    })
}

/// Read one optional token counter from unstable `PromptResponse.usage`.
/// Absent or null fields stay absent; a present field that fails validation
/// rejects the whole report with `None`.
fn optional_usage_counter(usage: &Value, name: &str) -> Option<Option<u64>> {
    match usage.get(name) {
        None | Some(Value::Null) => Some(None),
        Some(value) => validate_token_counter(value).map(Some),
    }
}

/// Parse unstable `result.usage` from a `session/prompt` response body.
/// Absent or null usage yields `None` (no report, not an error). Present
/// usage requires integer `inputTokens`/`outputTokens`/`totalTokens` within
/// the JavaScript-safe range; any malformed present field rejects the whole
/// report. The returned scope stays `PromptResponseUndefined` and callers must
/// never sum such reports. Arbitrary `_meta` names are never read.
pub fn parse_prompt_response_usage(
    body: &Value,
    provider: AiProviderKind,
    preset: Option<AcpPreset>,
    run_id: &AiRunId,
    session_id: &str,
    received_ms: u64,
) -> Option<ReportedUsage> {
    let usage = body.pointer("/result/usage")?;
    if usage.is_null() {
        return None;
    }
    if !usage.is_object() {
        return None;
    }
    let input_tokens = validate_token_counter(usage.get("inputTokens")?)?;
    let output_tokens = validate_token_counter(usage.get("outputTokens")?)?;
    let total_tokens = validate_token_counter(usage.get("totalTokens")?)?;
    let reasoning_tokens = optional_usage_counter(usage, "thoughtTokens")?;
    let cached_read_tokens = optional_usage_counter(usage, "cachedReadTokens")?;
    let cached_write_tokens = optional_usage_counter(usage, "cachedWriteTokens")?;
    Some(ReportedUsage {
        provider,
        preset,
        run_id: run_id.clone(),
        session_id: AcpSessionId(session_id.to_owned()),
        source: AcpUsageSource::PromptResponse,
        scope: usage_scope_for_source(AcpUsageSource::PromptResponse),
        used: None,
        size: None,
        input_tokens: Some(input_tokens),
        output_tokens: Some(output_tokens),
        total_tokens: Some(total_tokens),
        cached_read_tokens,
        cached_write_tokens,
        reasoning_tokens,
        cost: None,
        received_ms,
    })
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
        AiProviderKind::OpenaiChatCompletions => "ai/openai-chat-completions",
        AiProviderKind::OpenaiResponses => "ai/openai-responses",
        AiProviderKind::Anthropic => "ai/anthropic",
    }
}

/// Choose the stable credential-store account key for one named API connection.
/// The ID was validated at registration; the account carries the address only,
/// never the secret itself.
pub fn connection_account(id: &ApiConnectionId) -> String {
    format!("ai/api/{}", id.0)
}

/// Require a 1–128-byte ASCII alphanumeric/hyphen/underscore connection ID.
/// IDs are minted once at registration and never change afterwards.
pub fn validate_connection_id(id: &ApiConnectionId) -> Result<(), AiError> {
    validate_handle(&id.0, "接続先 ID")
}

/// Require a 1–64-scalar display name without NUL or line breaks.
/// Names are labels only; identity always comes from the connection ID.
pub fn validate_connection_name(name: &str) -> Result<(), AiError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 64
        || name.bytes().any(|b| b == 0 || b == b'\n' || b == b'\r')
    {
        return Err(invalid("接続先名は 1〜64 文字で指定します"));
    }
    Ok(())
}

/// Validate one named API connection's non-secret fields.
/// An empty model is allowed at rest and rejected when connecting, matching
/// the legacy single-profile behavior.
pub fn validate_api_connection(connection: &ApiConnection) -> Result<(), AiError> {
    validate_connection_id(&connection.id)?;
    validate_connection_name(&connection.name)?;
    validate_endpoint(&connection.endpoint)?;
    if !connection.model.trim().is_empty() {
        validate_model(connection.model.trim())?;
    }
    Ok(())
}

/// Build the wire provider config for one named API connection.
/// Anthropic connections always carry the opt-in flag; no session state changes.
pub fn provider_config_for_connection(
    connection: &ApiConnection,
) -> Result<AiProviderConfig, AiError> {
    validate_connection_id(&connection.id)?;
    validate_connection_name(&connection.name)?;
    let endpoint = validate_endpoint(connection.endpoint.trim())?;
    let model = connection.model.trim();
    validate_model(model)?;
    match connection.protocol {
        ApiProtocol::OpenaiChatCompletions | ApiProtocol::OpenaiResponses => Ok(AiProviderConfig {
            kind: if connection.protocol == ApiProtocol::OpenaiResponses {
                AiProviderKind::OpenaiResponses
            } else {
                AiProviderKind::OpenaiChatCompletions
            },
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint,
                model: model.to_owned(),
            }),
            anthropic: None,
            connection_id: Some(connection.id.clone()),
        }),
        ApiProtocol::Anthropic => Ok(AiProviderConfig {
            kind: AiProviderKind::Anthropic,
            acp: None,
            openai: None,
            anthropic: Some(AnthropicConfig {
                enabled: true,
                endpoint,
                model: model.to_owned(),
            }),
            connection_id: Some(connection.id.clone()),
        }),
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
    OpenAiResponses,
    Anthropic,
}

pub struct HttpTarget {
    /// Validated API root shared by provider-specific connection probes.
    pub base: String,
    pub url: String,
    pub model: String,
    pub backend: HttpBackend,
}

/// Build a protocol URL while preserving query parameters on both the API base and target.
pub fn http_endpoints(endpoint: &str, suffix: &str) -> (String, String) {
    let (path, query) = endpoint.split_at(endpoint.find('?').unwrap_or(endpoint.len()));
    let path = path.trim_end_matches('/');
    let base = path.strip_suffix(suffix).unwrap_or(path);
    (format!("{base}{query}"), format!("{base}{suffix}{query}"))
}

/// Validate the selected HTTP backend's endpoint/model and append `/chat/completions`
/// or `/messages`; reject ACP and Anthropic without opt-in as invalid configuration.
pub fn http_target(config: &AiProviderConfig) -> Result<HttpTarget, AiError> {
    match config.kind {
        AiProviderKind::OpenaiChatCompletions | AiProviderKind::OpenaiResponses => {
            let openai = config
                .openai
                .as_ref()
                .ok_or_else(|| invalid("OpenAIの設定が必要です"))?;
            let endpoint = validate_endpoint(&openai.endpoint)?;
            let suffix = if config.kind == AiProviderKind::OpenaiResponses {
                "/responses"
            } else {
                "/chat/completions"
            };
            let (base, url) = http_endpoints(&endpoint, suffix);
            validate_model(&openai.model)?;
            Ok(HttpTarget {
                url,
                base,
                model: openai.model.clone(),
                backend: if config.kind == AiProviderKind::OpenaiResponses {
                    HttpBackend::OpenAiResponses
                } else {
                    HttpBackend::OpenAi
                },
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
            let endpoint = validate_endpoint(&anthropic.endpoint)?;
            let (base, url) = http_endpoints(&endpoint, "/messages");
            validate_model(&anthropic.model)?;
            Ok(HttpTarget {
                url,
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

/// Build a stateless Responses request using the same authorized history and context.
pub(crate) fn responses_body(request: &AiPromptRequest, model: &str) -> serde_json::Value {
    let mut body = openai_body(request, model);
    let messages = body
        .as_object_mut()
        .expect("body object")
        .remove("messages")
        .expect("messages");
    body["input"] = messages;
    body["store"] = serde_json::json!(false);
    body
}

/// Decode typed Responses events, requiring explicit completion and rejecting failed or truncated output.
pub fn responses_signal(data: &str) -> Result<AnthropicSignal, AiError> {
    let event: Value = serde_json::from_str(data).map_err(|_| AiError::StreamFailed {
        detail: "Responses の応答を解析できません".into(),
    })?;
    match event.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta" | "response.refusal.delta") => event
            .get("delta")
            .and_then(Value::as_str)
            .map(|text| AnthropicSignal::Text(text.to_owned()))
            .ok_or_else(|| AiError::StreamFailed {
                detail: "Responses のテキストが不正です".into(),
            }),
        Some("response.completed") => Ok(AnthropicSignal::End),
        Some("error" | "response.failed" | "response.incomplete") => Err(AiError::StreamFailed {
            detail:
                "Responses の生成が完了しませんでした。接続先のエラーと利用上限を確認してください"
                    .into(),
        }),
        _ => Ok(AnthropicSignal::Ignore),
    }
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
        AiError::MissingBinary { command } => {
            format!(
                "{command} が見つかりません。{}",
                missing_binary_hint(command)
            )
        }
        AiError::MissingCredentials { .. } => "資格情報がありません".into(),
        AiError::RequestCancelled => "取り消しました".into(),
        AiError::SessionRequired => "セッションが必要です".into(),
        AiError::SessionBusy => "実行中です".into(),
        AiError::UnknownSession => "不明なセッションです".into(),
        AiError::StagingUnresolved { .. } => "作業コピーを解決できません".into(),
        AiError::LiveTargetRejected { detail } => detail.clone(),
        AiError::UnsupportedProtocol { version } => {
            format!(
                "protocol version {version} には未対応です。ACP v1 のアダプターを使ってください"
            )
        }
        AiError::ClaudeCodeRefused { command } => format!("{command} は起動しません"),
        AiError::CredentialStoreFailed { detail } => detail.clone(),
    }
}
