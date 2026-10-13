//! ACP subprocess lifecycle and bounded stdio framing.
use crate::application::ai::runs::*;
use crate::application::ai::transport::ResolvedAcpLaunch;
use crate::contracts::ai::*;
use crate::domain::ai::*;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
/// Return Unix milliseconds for usage receipt stamps.
/// Clock failures fall back to zero rather than failing the owning run.
fn usage_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Emit one validated `usage_update` notification as a nonterminal usage event.
/// Foreign sessions and malformed reports yield no event; text and terminal
/// handling stay unchanged.
fn emit_usage_notification(
    note: &serde_json::Value,
    session_id: &str,
    request: &AiPromptRequest,
    run_id: &AiRunId,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) {
    let usage = parse_usage_update_notification(
        note,
        session_id,
        request.provider.kind,
        acp_preset_of(&request.provider),
        run_id,
        usage_now_ms(),
    );
    if let Some(usage) = usage {
        emit(AiStreamEvent::Usage(StreamUsage {
            run_id: run_id.clone(),
            usage,
        }));
    }
}

/// Emit validated unstable `PromptResponse.usage` as a nonterminal usage event.
/// Absent usage yields no event; malformed usage is dropped without affecting
/// the terminal settlement that follows.
fn emit_prompt_response_usage(
    body: &serde_json::Value,
    session_id: &str,
    request: &AiPromptRequest,
    run_id: &AiRunId,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) {
    let usage = parse_prompt_response_usage(
        body,
        request.provider.kind,
        acp_preset_of(&request.provider),
        run_id,
        session_id,
        usage_now_ms(),
    );
    if let Some(usage) = usage {
        emit(AiStreamEvent::Usage(StreamUsage {
            run_id: run_id.clone(),
            usage,
        }));
    }
}

/// Emit validated tool-call, update, and plan notifications as nonterminal chat events.
///
/// Foreign sessions and malformed payloads yield no event; text and terminal
/// handling stay unchanged. Tool content never fabricates a timeline: only
/// wire-reported calls surface, and terminal executions never open a window.
fn emit_agentic_notification(
    note: &serde_json::Value,
    session_id: &str,
    staging_dir: &Path,
    run_id: &AiRunId,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) {
    if let Some(tool_call) = parse_tool_call_notification(note, session_id, staging_dir) {
        emit(AiStreamEvent::ToolCall(StreamToolCall {
            run_id: run_id.clone(),
            tool_call,
        }));
        return;
    }
    if let Some(update) = parse_tool_call_update_notification(note, session_id, staging_dir) {
        emit(AiStreamEvent::ToolCallUpdate(StreamToolCallUpdate {
            run_id: run_id.clone(),
            update,
        }));
        return;
    }
    if let Some(entries) = parse_plan_notification(note, session_id) {
        emit(AiStreamEvent::Plan(StreamPlan {
            run_id: run_id.clone(),
            entries,
        }));
    }
}

/// Check whether an absolute wire path stays inside the authorized staging directory.
///
/// Traversal (`..`) is never authorized even when it resolves inside: it is
/// rejected before any other check, matching the method docs and the domain
/// containment contract. Every other absolute path resolves through one
/// common gate: the entry itself counts when present (`symlink_metadata`
/// detects dangling links as entries so they fail closed instead of being
/// skipped toward a benign parent), otherwise the nearest existing ancestor
/// does, authorizing absent destinations reached through valid canonical
/// aliases (macOS `/var` versus `/private/var`, Windows UNC `\\?\` versus
/// the drive-letter form, owned-root symlinks). The ancestor must resolve
/// inside the canonical staging root, and the destination itself must sit
/// strictly below it (a proper lexical prefix guarantees a non-empty
/// `..`-free remainder); outside paths, the root itself, relative paths,
/// and any canonicalization failure yield false.
pub(crate) fn staging_path_allowed(staging_dir: &Path, abs_path: &str) -> bool {
    use std::path::Component;
    let candidate = Path::new(abs_path);
    if !candidate.is_absolute() {
        return false;
    }
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    let anchor: PathBuf = if std::fs::symlink_metadata(candidate).is_ok() {
        candidate.to_path_buf()
    } else {
        match nearest_existing_ancestor(candidate) {
            Some(ancestor) => ancestor,
            None => return false,
        }
    };
    let (root, base) = match (staging_dir.canonicalize(), anchor.canonicalize()) {
        (Ok(root), Ok(base)) => (root, base),
        _ => return false,
    };
    if !base.starts_with(&root) {
        return false;
    }
    if anchor == candidate {
        // An existing entry must sit strictly below the root itself.
        return base != root;
    }
    // A proper lexical prefix leaves a non-empty remainder without `..`, so
    // the absent destination always lands strictly below its resolved ancestor.
    true
}

/// Find the nearest existing ancestor of a not-yet-created path.
///
/// Walks up from the candidate until an entry is found. Uses
/// `symlink_metadata` so dangling links count as entries instead of being
/// skipped toward a benign parent; callers canonicalize the result, which
/// fails closed for dangling links. Yields `None` only when no ancestor
/// exists. Callers use the result to detect symlinked parents resolving
/// outside the owned staging root before creating any directory or file.
fn nearest_existing_ancestor(candidate: &Path) -> Option<PathBuf> {
    let mut current = candidate;
    loop {
        if std::fs::symlink_metadata(current).is_ok() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}

/// Build a JSON-RPC error envelope for rejected agent file/permission requests.
/// Wrong sessions and outside paths are rejected without touching the filesystem.
fn agent_request_error(id: &Value, code: i64, message: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

/// Bound one permission wait to the remaining overall prompt budget.
///
/// Returns the earlier of the run deadline (`run_started + timeout`) and a
/// 120-second interactive cap from `now`, so a permission choice never
/// restarts the full run deadline while still bounding a dead UI.
pub fn permission_wait_until(run_started: Instant, timeout: Duration, now: Instant) -> Instant {
    std::cmp::min(
        run_started.checked_add(timeout).unwrap_or(now),
        now.checked_add(Duration::from_secs(120)).unwrap_or(now),
    )
}

/// Answer one `session/request_permission` with the chat user's explicit choice.
///
/// Registers the pending request, surfaces it as a chat event, then waits
/// with bounded polling for `ai_permission_reply`, local cancellation, or the
/// run deadline. Delivers the chosen option ID exactly once, the spec
/// `cancelled` outcome after cancellation, or a bounded denial with actual
/// reject IDs on deadline expiry. Read-only `ask` turns never wait: they
/// surface and deny immediately. Always drops the pending slot afterwards.
#[allow(clippy::too_many_arguments)]
fn answer_permission_interactive(
    conn: &mut AgentConn,
    run_id: &AiRunId,
    registry: &RunRegistry,
    cancel: &AtomicBool,
    cancel_sent: bool,
    run_started: Instant,
    timeout: Duration,
    session_id: &str,
    req_id: &Value,
    req_params: &Value,
    is_ask: bool,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) -> Result<(), AiError> {
    let cancelled = cancel_sent || cancel.load(Ordering::SeqCst);
    let parsed = match parse_permission_request(req_id, req_params) {
        None => {
            let reply = agent_request_error(req_id, -32602, "invalid permission request");
            return conn.write(&reply);
        }
        Some(parsed) if parsed.session_id != session_id => {
            let reply = agent_request_error(req_id, -32602, "unknown session for permission");
            return conn.write(&reply);
        }
        Some(parsed) => parsed,
    };
    let request_id = stringify_request_id(req_id).unwrap_or_else(|| parsed.request_id.clone());
    let options: Vec<PermissionOption> = parsed
        .options
        .iter()
        .map(|option| PermissionOption {
            option_id: option.option_id.clone(),
            name: option.name.clone(),
            kind: option.kind,
        })
        .collect();
    // Read-only turns surface the request but never wait for a choice.
    if is_ask || cancelled {
        emit(AiStreamEvent::Permission(StreamPermission {
            run_id: run_id.clone(),
            request_id: request_id.clone(),
            session_id: AcpSessionId(parsed.session_id.clone()),
            tool_call_id: parsed.tool_call_id.clone(),
            title: parsed.title.clone(),
            options: options.clone(),
        }));
        let mode = if cancelled {
            PermissionAnswer::Cancelled
        } else {
            PermissionAnswer::Deny
        };
        return conn.answer_agent_request(req_id, "session/request_permission", req_params, mode);
    }
    if registry
        .register_permission(run_id, &request_id, &parsed.session_id, options.clone())
        .is_err()
    {
        let reply = agent_request_error(req_id, -32602, "unknown session for permission");
        return conn.write(&reply);
    }
    emit(AiStreamEvent::Permission(StreamPermission {
        run_id: run_id.clone(),
        request_id: request_id.clone(),
        session_id: AcpSessionId(parsed.session_id.clone()),
        tool_call_id: parsed.tool_call_id.clone(),
        title: parsed.title.clone(),
        options,
    }));
    let wait_until = permission_wait_until(run_started, timeout, Instant::now());
    loop {
        if cancel.load(Ordering::SeqCst) {
            // Settle cancellation through the EOF path exactly once: the
            // killed child closes stdout and `cancelled_or_timed_out` emits
            // the single terminal. Writing an answer here could race the
            // child's death and turn a clean cancel into a stream error.
            registry.drop_permission(run_id, &request_id);
            return Ok(());
        }
        if let Some(option_id) = registry.take_permission_reply(run_id, &request_id) {
            registry.drop_permission(run_id, &request_id);
            let reply = serde_json::json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": answer_permission_by_id(&option_id, false),
            });
            return conn.write(&reply);
        }
        if Instant::now() >= wait_until {
            registry.drop_permission(run_id, &request_id);
            return conn.answer_agent_request(
                req_id,
                "session/request_permission",
                req_params,
                PermissionAnswer::Deny,
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Serve `fs/read_text_file` from the authorized staging directory.
///
/// Validates the claimed session, requires an absolute contained path, and
/// rejects symlinks escaping the root. Wrong sessions and outside paths yield
/// a JSON-RPC error; successes return `{ content }`.
pub(crate) fn serve_fs_read(
    staging_dir: &Path,
    expected_session: &str,
    params: &Value,
) -> Result<Value, Value> {
    let session = params
        .get("sessionId")
        .and_then(|id| id.as_str())
        .unwrap_or("");
    if session != expected_session {
        return Err(agent_request_error(
            &Value::Null,
            -32602,
            "unknown session for fs/read_text_file",
        ));
    }
    let path = params
        .get("path")
        .and_then(|path| path.as_str())
        .unwrap_or("");
    if !staging_path_allowed(staging_dir, path) {
        return Err(agent_request_error(
            &Value::Null,
            -32602,
            "path is outside the authorized staging copy",
        ));
    }
    let bytes = std::fs::read(Path::new(path))
        .map_err(|_| agent_request_error(&Value::Null, -32602, "staging file cannot be read"))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| agent_request_error(&Value::Null, -32602, "staging file is not UTF-8"))?;
    if content.len() > MAX_EXCERPT_BYTES {
        return Err(agent_request_error(
            &Value::Null,
            -32602,
            "staging file is too large",
        ));
    }
    Ok(serde_json::json!({ "content": content }))
}

/// Serve `fs/write_text_file` into the authorized staging directory.
///
/// Validates the claimed session and containment through the single staging
/// gate (which resolves the nearest existing ancestor, so absent destinations
/// below outside-pointing symlinked parents fail before anything is created),
/// then creates parent directories and writes UTF-8 text. `Ask` mode is
/// read-only and rejects writes. Markdown-only enforcement happens at review
/// time; the transport contains the write but never applies it to live
/// buffers. Wrong sessions, outside paths, symlinked parents resolving
/// outside the owned root, and unresolvable ancestors yield a JSON-RPC error
/// before any directory or file is created.
pub(crate) fn serve_fs_write(
    staging_dir: &Path,
    expected_session: &str,
    params: &Value,
    mode: PromptMode,
) -> Result<Value, Value> {
    use crate::contracts::ai::PromptMode as Mode;
    if mode == Mode::Ask {
        return Err(agent_request_error(
            &Value::Null,
            -32602,
            "ask mode is read-only",
        ));
    }
    let session = params
        .get("sessionId")
        .and_then(|id| id.as_str())
        .unwrap_or("");
    if session != expected_session {
        return Err(agent_request_error(
            &Value::Null,
            -32602,
            "unknown session for fs/write_text_file",
        ));
    }
    let path = params
        .get("path")
        .and_then(|path| path.as_str())
        .unwrap_or("");
    if !staging_path_allowed(staging_dir, path) {
        return Err(agent_request_error(
            &Value::Null,
            -32602,
            "path is outside the authorized staging copy",
        ));
    }
    let content = params
        .get("content")
        .and_then(|content| content.as_str())
        .ok_or_else(|| {
            agent_request_error(&Value::Null, -32602, "fs/write_text_file requires content")
        })?;
    if content.len() > MAX_EXCERPT_BYTES {
        return Err(agent_request_error(
            &Value::Null,
            -32602,
            "staging content is too large",
        ));
    }
    let target = Path::new(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|_| {
            agent_request_error(&Value::Null, -32602, "staging parent cannot be created")
        })?;
    }
    std::fs::write(target, content.as_bytes())
        .map_err(|_| agent_request_error(&Value::Null, -32602, "staging file cannot be written"))?;
    Ok(serde_json::json!({}))
}

/// Read `PATHEXT` order for executable probing, falling back to the bundled
/// Windows default when the variable is absent or unparsable.
/// Appends `ps1` after `PATHEXT` when missing so official npm shims resolve
/// even on hosts whose `PATHEXT` omits PowerShell scripts.
pub fn pathext_order() -> Vec<String> {
    if cfg!(windows) {
        if let Some(raw) = std::env::var_os("PATHEXT") {
            if let Some(text) = raw.to_str() {
                let mut parsed = parse_windows_pathext(text);
                if !parsed.is_empty() {
                    if !parsed.iter().any(|ext| ext == "ps1") {
                        parsed.push("ps1".to_owned());
                    }
                    return parsed;
                }
            }
        }
    }
    default_windows_pathext()
}

/// Find an executable on PATH with native platform extensions without starting it.
/// On Windows this honors `PATHEXT` order (plus `.ps1` npm shims) and returns the
/// first filesystem match, including shim scripts; use `resolve_acp_launch` when a
/// directly spawnable program is required.
pub fn find_on_path(command: &str) -> Option<PathBuf> {
    if command.contains('/') || command.contains('\\') || command.contains(':') {
        let path = Path::new(command);
        if path.is_file() {
            return Some(path.to_path_buf());
        }
        // Explicit paths try the literal file plus PATHEXT siblings on Windows.
        if cfg!(windows) {
            for ext in pathext_order() {
                let sibling = PathBuf::from(format!("{command}.{ext}"));
                if sibling.is_file() {
                    return Some(sibling);
                }
            }
        }
        return None;
    }
    let path_var = std::env::var_os("PATH")?;
    if cfg!(windows) {
        let order = pathext_order();
        // Prefer directly runnable entries first, then shim scripts, then the
        // raw extensionless npm wrapper, all in PATH directory order.
        for dir in std::env::split_paths(&path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            // Exact filename when the caller already includes an extension.
            if Path::new(command).extension().is_some() {
                let candidate = dir.join(command);
                if candidate.is_file() {
                    return Some(candidate);
                }
                continue;
            }
            for ext in &order {
                let candidate = dir.join(format!("{command}.{ext}"));
                if candidate.is_file() {
                    // Return the first PATHEXT match; direct executables sort
                    // before shims because `pathext_order` preserves PATHEXT.
                    // `.ps1` is appended after PATHEXT, so `.exe`/`.com` win.
                    return Some(candidate);
                }
            }
            let raw = dir.join(command);
            if raw.is_file() {
                return Some(raw);
            }
        }
        None
    } else {
        std::env::split_paths(&path_var).find_map(|dir| {
            let candidate = dir.join(command);
            candidate.is_file().then_some(candidate)
        })
    }
}

/// Resolve an existing candidate and freeze its location before the agent changes cwd.
/// Windows accepts direct executables and supported official npm shims only.
fn resolve_launch_candidate(path: &Path, args: &[String]) -> Option<ResolvedAcpLaunch> {
    if !path.is_file() {
        return None;
    }
    let path = std::path::absolute(path).ok()?;
    if cfg!(not(windows)) || is_direct_windows_executable(&path) {
        return Some(ResolvedAcpLaunch {
            program: path,
            args: args.to_vec(),
        });
    }
    let ext = path.extension()?.to_str()?;
    is_windows_script_extension(ext)
        .then(|| resolve_npm_shim_target(&path, args))
        .flatten()
}

/// Resolve an explicit path or its Windows extension siblings without using a shell.
fn resolve_explicit_launch(path: &Path, args: &[String]) -> Result<ResolvedAcpLaunch, AiError> {
    if let Some(launch) = resolve_launch_candidate(path, args) {
        return Ok(launch);
    }
    if !path.is_file() && cfg!(windows) {
        for ext in pathext_order() {
            let sibling = PathBuf::from(format!("{}.{ext}", path.display()));
            if let Some(launch) = resolve_launch_candidate(&sibling, args) {
                return Ok(launch);
            }
        }
    }
    Err(AiError::MissingBinary {
        command: path.to_string_lossy().into_owned(),
    })
}

/// Find the Node.js executable backing an official codex-acp npm shim.
/// Prefers a `node.exe` sibling of the npm root, then PATH lookup.
fn find_node_program(npm_root: &Path) -> Option<PathBuf> {
    let sibling = npm_root.join("node.exe");
    if sibling.is_file() {
        return Some(sibling);
    }
    find_on_path("node")
        .filter(|candidate| is_direct_windows_executable(candidate))
        .and_then(|candidate| std::path::absolute(candidate).ok())
}

/// Resolve a known official npm shim to its bundled target without a shell.
/// `opencode` maps to `node_modules/@opencode/cli/bin/opencode.exe`;
/// `codex-acp` maps to `node <npm>/node_modules/@agentclientprotocol/codex-acp/dist/index.js`.
/// `codex` maps directly to the published native executable, avoiding a Node parent process.
/// All other shims return `None` so callers keep searching or report missing.
fn resolve_npm_shim_target(shim: &Path, original_args: &[String]) -> Option<ResolvedAcpLaunch> {
    let stem = shim
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_ascii_lowercase)?;
    let npm_root = shim.parent()?;
    match stem.as_str() {
        "opencode" | "opencode2" => {
            let target = npm_root
                .join("node_modules")
                .join("@opencode")
                .join("cli")
                .join("bin")
                .join("opencode.exe");
            target.is_file().then(|| ResolvedAcpLaunch {
                program: target,
                args: original_args.to_vec(),
            })
        }
        "codex" => codex_npm_program(npm_root).map(|program| ResolvedAcpLaunch {
            program,
            args: original_args.to_vec(),
        }),
        "codex-acp" => {
            let script = npm_root
                .join("node_modules")
                .join("@agentclientprotocol")
                .join("codex-acp")
                .join("dist")
                .join("index.js");
            if !script.is_file() {
                return None;
            }
            let node = find_node_program(npm_root)?;
            let mut args = Vec::with_capacity(1 + original_args.len());
            args.push(script.to_string_lossy().into_owned());
            args.extend_from_slice(original_args);
            Some(ResolvedAcpLaunch {
                program: node,
                args,
            })
        }
        _ => None,
    }
}

/// Resolve the published Codex platform package or its bundled vendor fallback.
/// Native launches own one process rather than a Node launcher plus a native child.
pub(super) fn codex_npm_program(npm_root: &Path) -> Option<PathBuf> {
    let (package, target, executable) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => ("codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"),
        ("windows", "aarch64") => ("codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"),
        ("macos", "x86_64") => ("codex-darwin-x64", "x86_64-apple-darwin", "codex"),
        ("macos", "aarch64") => ("codex-darwin-arm64", "aarch64-apple-darwin", "codex"),
        ("linux", "x86_64") => ("codex-linux-x64", "x86_64-unknown-linux-musl", "codex"),
        ("linux", "aarch64") => ("codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"),
        _ => return None,
    };
    let openai = npm_root.join("node_modules").join("@openai");
    [openai.join(package), openai.join("codex")]
        .into_iter()
        .find_map(|root| {
            let candidate = root
                .join("vendor")
                .join(target)
                .join("bin")
                .join(executable);
            candidate
                .is_file()
                .then(|| std::path::absolute(candidate).ok())
                .flatten()
        })
}

/// Resolve bare PATH commands to directly spawnable launches in directory order.
/// Each directory prefers PATHEXT-ordered direct executables, then resolvable
/// official npm shims; unresolvable scripts never satisfy the lookup.
fn resolve_bare_launch(command: &str, args: &[String]) -> Result<ResolvedAcpLaunch, AiError> {
    let path_var = std::env::var_os("PATH").ok_or_else(|| AiError::MissingBinary {
        command: command.to_owned(),
    })?;
    let order = pathext_order();
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if cfg!(not(windows)) || Path::new(command).extension().is_some() {
            if let Some(launch) = resolve_launch_candidate(&dir.join(command), args) {
                return Ok(launch);
            }
            continue;
        }
        // First pass: directly runnable `.com`/`.exe` in PATHEXT order.
        for ext in &order {
            if !matches!(ext.as_str(), "com" | "exe") {
                continue;
            }
            let candidate = dir.join(format!("{command}.{ext}"));
            if let Some(launch) = resolve_launch_candidate(&candidate, args) {
                return Ok(launch);
            }
        }
        // Second pass: resolvable official shims (`.cmd`/`.bat`/`.ps1`).
        for ext in &order {
            if !is_windows_script_extension(ext) {
                continue;
            }
            let candidate = dir.join(format!("{command}.{ext}"));
            if let Some(launch) = resolve_launch_candidate(&candidate, args) {
                return Ok(launch);
            }
        }
    }
    Err(AiError::MissingBinary {
        command: command.to_owned(),
    })
}

/// Resolve configured ACP argv to a directly spawnable program and final args.
/// Validates argv first; explicit paths resolve via siblings, bare commands via
/// PATH directory order with PATHEXT preference for direct executables.
/// Npm shims for official adapters resolve to bundled targets; no shell is used
/// and arguments are never interpolated into a command string.
pub fn resolve_acp_launch(argv: &AcpArgv) -> Result<ResolvedAcpLaunch, AiError> {
    validate_argv(argv)?;
    if argv.command.contains('/') || argv.command.contains('\\') || argv.command.contains(':') {
        return resolve_explicit_launch(Path::new(&argv.command), &argv.args);
    }
    resolve_bare_launch(&argv.command, &argv.args)
}

pub const MAX_ACP_LINE_BYTES: usize = 8_388_608;
/// Grace period for an agent to answer `session/prompt` after `session/cancel`.
pub const CANCEL_GRACE: Duration = Duration::from_secs(5);
/// Maximum silence between prompt-loop iterations before re-checking the
/// cancel flag. Agents that go quiet (for example while waiting for our
/// next message) must not delay cancellation past this bound.
pub const ACP_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Grace period for an agent to exit after we close its stdin.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Bounded newline-delimited JSON reader for native ACP stdout.
pub struct NdjsonReader<R: BufRead> {
    inner: R,
    buf: Vec<u8>,
}

impl<R: BufRead> NdjsonReader<R> {
    /// Start an empty bounded newline-delimited JSON decoder over the supplied reader.
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
pub use crate::application::ai::transport::AcpRunParams;

/// Spawn the configured ACP argv directly with piped stdio and an isolated working directory.
pub(super) fn spawn_acp(argv: &AcpArgv, staging_dir: &Path) -> Result<Child, AiError> {
    // Resolve npm shims to bundled targets first. The resolved program goes
    // directly to the OS with an argv array. No shell, no interpolation.
    let launch = resolve_acp_launch(argv)?;
    let mut command = Command::new(&launch.program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW; protocol uses pipes.
    }
    command
        .args(&launch.args)
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
    /// Create the process connection with independent bounded stdout and stderr readers.
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

    /// Allocate the next client JSON-RPC request identifier.
    pub fn fresh_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Serialize and flush one JSON-RPC message to the child stdin.
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

    /// Send a JSON-RPC notification without allocating a response identifier.
    pub fn notify(&mut self, message: &serde_json::Value) -> Result<(), AiError> {
        self.write(message)
    }

    /// Wait for the next framed message up to the caller's bounded polling interval.
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

    /// Answer handshake agent requests by default denial and reject unsupported methods.
    ///
    /// Handshake phases never surface permission UI; prompt turns use the
    /// conversation handler with visible permission events instead.
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
        let method = message
            .get("method")
            .and_then(|method| method.as_str())
            .unwrap_or("agent")
            .to_owned();
        self.write(&message)?;
        loop {
            match self.read_next(None) {
                Ok(ConnLine::Value(message)) => match classify_incoming(message)? {
                    AgentIncoming::Response { id: got, body } => {
                        if got == id {
                            if let Some(error) =
                                rpc_error(&format!("{method} が失敗しました"), &body)
                            {
                                return Err(error);
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

/// Wait for graceful process exit within the supplied deadline.
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

/// Result of initialize + session/new. No prompt is ever sent by this path.
#[derive(Debug, Clone)]
pub struct HandshakeInfo {
    pub protocol_version: u32,
    pub session_id: String,
    pub agent_name: Option<String>,
    pub notifications: usize,
    pub config_options: Vec<AcpConfigOption>,
}

/// Negotiate ACP initialization and session creation before accepting prompts.
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
            config_options: super::config_options::read_options(&reply)?,
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

/// Extract a structured ACP response error with a bounded human-readable detail.
fn rpc_error(context: &str, message: &serde_json::Value) -> Option<AiError> {
    message.get("error").map(|error| {
        let detail = error
            .get("message")
            .and_then(|message| message.as_str())
            .unwrap_or("agent error");
        map_acp_rpc_error(context, error.get("code").and_then(Value::as_i64), detail)
    })
}

/// Read a bounded tail of captured child stderr for failure diagnostics.
fn stderr_excerpt(captured: &Arc<Mutex<Vec<u8>>>) -> String {
    let bytes = captured.lock().expect("stderr lock").clone();
    String::from_utf8_lossy(&bytes).chars().take(500).collect()
}

/// Attach bounded stderr diagnostics without changing the structured error category.
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

/// Distinguish explicit cancellation from a registry-recorded timeout.
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

/// Write one agent-request reply, settling explicit cancellation when the agent is already gone.
///
/// Killing a cancelled child closes its stdio pipes, so the next reply write
/// fails on strict platforms while lenient ones still accept it. An
/// explicitly cancelled run must settle as cancelled either way, never as a
/// stream error. Non-cancel write failures keep their error. Returns true
/// when the run settled as cancelled and the caller must stop the loop.
#[allow(clippy::too_many_arguments)]
fn write_agent_reply_or_settle_cancelled(
    conn: &mut AgentConn,
    reply: &Value,
    run_id: &AiRunId,
    registry: &RunRegistry,
    cancel: &AtomicBool,
    cancel_sent: bool,
    tracker: &mut AcpSessionTracker,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) -> Result<bool, AiError> {
    match conn.write(reply) {
        Ok(()) => Ok(false),
        Err(_error) if cancel.load(Ordering::SeqCst) || cancel_sent => {
            cancelled_or_timed_out(run_id, registry, emit);
            tracker.prompt_finished();
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

/// Run an authorized scoped ACP prompt with cancellation, child ownership and streamed events.
pub fn run_acp_prompt(
    params: &AcpRunParams,
    request: &AiPromptRequest,
    run_id: &AiRunId,
    registry: &Arc<RunRegistry>,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) -> Result<(), AiError> {
    // The overall prompt budget starts here: permission waits below use the
    // remainder of this same deadline instead of restarting it per request.
    let run_started = Instant::now();
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
    registry.set_child(run_id, Box::new(NativeProcess(child)));

    // Overall watchdog: kill through the registry so cancel stays uniform.
    let watchdog_registry = Arc::clone(registry);
    let watchdog_id = run_id.clone();
    let watchdog_timeout = params.timeout;
    std::thread::spawn(move || {
        std::thread::sleep(watchdog_timeout);
        watchdog_registry.timeout_cancel(&watchdog_id);
    });

    let outcome = run_acp_conversation(
        params,
        request,
        run_id,
        registry,
        cancel,
        run_started,
        emit,
        &mut conn,
    );
    let outcome = outcome.map_err(|error| with_stderr(error, &stderr_captured));
    // Reap exactly once on every path. Graceful turns (Done or a cooperating
    // cancel) shut the agent down by closing stdin; kill paths already reaped
    // through the registry, and error paths kill here.
    match &outcome {
        Ok(()) => {
            if let Some(child) = registry.take_child(run_id) {
                drop(conn);
                let mut child = child;
                child.finish(SHUTDOWN_GRACE);
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
/// Drive one ACP conversation with visible tool/plan/permission events and
/// authorized staging file access. Permissions are surfaced as chat events and
/// answered by actual option IDs (deny by default, cancelled after cancel);
/// fs reads/writes are contained to the staging directory with session and
/// path rejection; terminals are never created in an external window.
fn run_acp_conversation(
    params: &AcpRunParams,
    request: &AiPromptRequest,
    run_id: &AiRunId,
    registry: &RunRegistry,
    cancel: &AtomicBool,
    run_started: Instant,
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
    super::config_options::apply_selections(
        conn,
        session_id,
        &reply,
        request
            .provider
            .acp
            .as_ref()
            .and_then(|config| config.selections.as_deref())
            .unwrap_or(&[]),
    )?;

    // Resume across runs is not implemented in v1: any caller-supplied id is
    // unknown by construction. The tracker reports that explicitly.
    tracker.prompt_started(request.session_id.as_ref().map(|id| id.0.as_str()))?;

    let prompt_id = conn.fresh_id();
    let prompt_message = acp_session_prompt_with_history(
        prompt_id,
        session_id,
        request.mode,
        &request.prompt,
        &request.contexts,
        &request.history,
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
                if let Some(error) = rpc_error("prompt に失敗しました", &body) {
                    return Err(error);
                }
                emit_prompt_response_usage(&body, session_id, request, run_id, emit);
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
                emit_usage_notification(&note, session_id, request, run_id, emit);
                emit_agentic_notification(&note, session_id, &params.staging_dir, run_id, emit);
            }
            AgentIncoming::AgentRequest {
                id: req_id,
                method: req_method,
                params: req_params,
            } => {
                if req_method == "fs/read_text_file" {
                    let reply = match serve_fs_read(&params.staging_dir, session_id, &req_params) {
                        Ok(result) => serde_json::json!({
                            "jsonrpc": "2.0", "id": req_id, "result": result
                        }),
                        Err(error) => {
                            let mut envelope = error;
                            envelope["id"] = req_id.clone();
                            envelope
                        }
                    };
                    if write_agent_reply_or_settle_cancelled(
                        conn,
                        &reply,
                        run_id,
                        registry,
                        cancel,
                        cancel_sent,
                        &mut tracker,
                        emit,
                    )? {
                        return Ok(());
                    }
                } else if req_method == "fs/write_text_file" {
                    let reply = match serve_fs_write(
                        &params.staging_dir,
                        session_id,
                        &req_params,
                        request.mode,
                    ) {
                        Ok(result) => serde_json::json!({
                            "jsonrpc": "2.0", "id": req_id, "result": result
                        }),
                        Err(error) => {
                            let mut envelope = error;
                            envelope["id"] = req_id.clone();
                            envelope
                        }
                    };
                    if write_agent_reply_or_settle_cancelled(
                        conn,
                        &reply,
                        run_id,
                        registry,
                        cancel,
                        cancel_sent,
                        &mut tracker,
                        emit,
                    )? {
                        return Ok(());
                    }
                } else if req_method == "session/request_permission" {
                    match answer_permission_interactive(
                        conn,
                        run_id,
                        registry,
                        cancel,
                        cancel_sent,
                        run_started,
                        params.timeout,
                        session_id,
                        &req_id,
                        &req_params,
                        request.mode == PromptMode::Ask,
                        emit,
                    ) {
                        Ok(()) => {}
                        Err(_error) if cancel.load(Ordering::SeqCst) || cancel_sent => {
                            cancelled_or_timed_out(run_id, registry, emit);
                            tracker.prompt_finished();
                            return Ok(());
                        }
                        Err(error) => return Err(error),
                    }
                } else {
                    // Terminals, elicitation, and unknown methods stay
                    // unimplemented: no external window is ever created.
                    let mode = if cancel_sent || cancel.load(Ordering::SeqCst) {
                        PermissionAnswer::Cancelled
                    } else {
                        PermissionAnswer::Deny
                    };
                    match conn.answer_agent_request(&req_id, &req_method, &req_params, mode) {
                        Ok(()) => {}
                        Err(_error) if cancel.load(Ordering::SeqCst) || cancel_sent => {
                            cancelled_or_timed_out(run_id, registry, emit);
                            tracker.prompt_finished();
                            return Ok(());
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
        }
    }
}

// ---- HTTP SSE drivers (OpenAI-compatible and Anthropic) ----

/// Probe ACP initialization in a temporary directory and always reap the probe child.
pub fn handshake_acp(argv: &AcpArgv) -> Result<AiTestResult, AiError> {
    validate_argv(argv)?;
    let staging = tempfile::Builder::new()
        .prefix("marxen-acp-probe-")
        .tempdir()
        .map_err(|error| AiError::ConnectionFailed {
            detail: format!("接続確認用フォルダーを作れません: {error}"),
        })?;
    match agent_handshake(argv, staging.path(), HTTP_TEST_TIMEOUT) {
        Ok(info) => Ok(AiTestResult {
            config_options: Some(info.config_options),
            ok: true,
            detail: format!(
                "ACP ハンドシェイクに成功しました (protocol {}, session {}, 通知 {} 件)",
                info.protocol_version, info.session_id, info.notifications
            ),
        }),
        Err(error) => Ok(AiTestResult {
            config_options: None,
            ok: false,
            detail: format!("ハンドシェイクに失敗しました: {}", error_detail(&error)),
        }),
    }
}

/// Native process ownership implementing application cancellation and settlement.
pub struct NativeProcess(pub Child);
impl ManagedProcess for NativeProcess {
    /// Kill and synchronously reap the child on cancellation or driver failure.
    fn terminate(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
    /// Give a completed ACP agent a bounded EOF grace before killing and reaping it.
    fn finish(&mut self, grace: Duration) {
        wait_for_exit(&mut self.0, grace);
    }
}
