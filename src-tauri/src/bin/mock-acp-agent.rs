//! Mock ACP agent for integration tests. Speaks official newline-delimited
//! compact UTF-8 JSON-RPC with an INDEPENDENT minimal implementation: this
//! file must not import framing helpers from marxen_lib (only serde_json),
//! so the tests genuinely verify interop rather than shared code.
//!
//! Flags: --respond-after-ms N, --no-chunks, --no-early-notify,
//! --no-permission, --fragment, --coalesce, --huge-line,
//! --cancel-graceful, --exit-early, --flag-dir PATH,
//! --codex-account-usage serves a read-only App Server fixture and refuses inference.
//! --write-staging REL --write-text TEXT (fake CLI edit of the staging cwd).
//! --write-after-response-ms N delays that edit until after the prompt
//! terminal, while the child is still being reaped.
//! flag-dir receives permission.json / clean_exit markers (per-test dirs,
//! safe under parallel test threads).
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

struct Agent {
    out: std::io::StdoutLock<'static>,
    fragment: bool,
    coalesce: bool,
    pending: Vec<u8>,
}

/// Serialize one compact JSON value and append LF using independent mock framing.
/// Panic only if serialization fails; no library protocol helper is reused.
fn encode(value: &serde_json::Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(value).expect("mock message serializes");
    line.push(b'\n');
    line
}

impl Agent {
    /// Encode an envelope and buffer it in coalescing mode, otherwise write it now.
    fn send(&mut self, value: &serde_json::Value) {
        let line = encode(value);
        if self.coalesce {
            self.pending.extend_from_slice(&line);
            return;
        }
        self.write_line(&line);
    }

    /// Write and clear the entire coalesced buffer in one batch, ignoring output errors.
    /// Do nothing outside coalescing mode or when there are no pending bytes.
    fn flush(&mut self) {
        if self.coalesce && !self.pending.is_empty() {
            let bytes: Vec<u8> = std::mem::take(&mut self.pending);
            let _ = self.out.write_all(&bytes);
            let _ = self.out.flush();
        }
    }

    /// Write a framed line immediately, optionally in three-byte pieces with
    /// 1 ms delays to split JSON and UTF-8 boundaries; output failures are ignored.
    fn write_line(&mut self, line: &[u8]) {
        if self.fragment {
            // Split mid-line and mid-UTF-8 on purpose.
            for piece in line.chunks(3) {
                let _ = self.out.write_all(piece);
                let _ = self.out.flush();
                std::thread::sleep(Duration::from_millis(1));
            }
            return;
        }
        let _ = self.out.write_all(line);
        let _ = self.out.flush();
    }

    /// Send or queue a JSON-RPC success result echoing the supplied request ID.
    fn respond(&mut self, id: &serde_json::Value, result: serde_json::Value) {
        let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
        self.send(&reply);
    }

    /// Send or queue a JSON-RPC error with mock code -32000 and the request ID.
    fn respond_error(&mut self, id: &serde_json::Value, message: &str) {
        let reply = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32000, "message": message }
        });
        self.send(&reply);
    }

    /// Emit a `session/update` text-chunk notification for the specified session.
    fn notify_update(&mut self, session_id: &str, text: &str) {
        let note = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text }
                }
            }
        });
        self.send(&note);
    }
}

/// Read the first matching `--flag value` or `--flag=value` argument.
/// A separate flag with no following value, or an absent flag, yields `None`.
fn flag_value(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
        if let Some(rest) = arg.strip_prefix(&format!("{name}=")) {
            return Some(rest.to_owned());
        }
    }
    None
}

/// Check for an exact standalone flag after `argv[0]`, without interpreting `=value`.
fn has_flag(name: &str) -> bool {
    std::env::args().skip(1).any(|arg| arg == name)
}

/// Resolve the optional marker-output directory from `--flag-dir` without validating it.
fn flag_dir() -> Option<std::path::PathBuf> {
    flag_value("--flag-dir").map(std::path::PathBuf::from)
}

/// Independent staging guard: the mock only writes contained relative paths
/// inside its cwd, mirroring the production containment rule.
/// Normalize `.`/`..` lexically and reject empty or absolute paths and traversal
/// beyond the root; this helper does not resolve or check symlinks.
fn guarded_staging_target(
    root: &std::path::Path,
    candidate: &str,
) -> Result<std::path::PathBuf, String> {
    use std::path::Component;
    if candidate.is_empty() {
        return Err("empty file".into());
    }
    let bytes = candidate.as_bytes();
    if candidate.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err("absolute path rejected".into());
    }
    let mut normalized = std::path::PathBuf::new();
    for component in std::path::Path::new(candidate).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("traversal outside staging".into());
                }
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute path rejected".into());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("empty file".into());
    }
    let joined = root.join(&normalized);
    if !joined.starts_with(root) {
        return Err("outside staging".into());
    }
    Ok(joined)
}

/// Read JSON lines from stdin, tolerating CRLF and skipping empty/malformed JSON lines.
/// Log malformed JSON, and return `None` on EOF, read failure, or invalid UTF-8.
fn read_message(reader: &mut BufReader<std::io::StdinLock<'_>>) -> Option<serde_json::Value> {
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => return None,
            Ok(_) => {}
            Err(_) => return None,
        };
        let mut text = line.as_slice();
        if text.ends_with(b"\n") {
            text = &text[..text.len() - 1];
        }
        if text.ends_with(b"\r") {
            text = &text[..text.len() - 1];
        }
        if text.is_empty() {
            continue;
        }
        let text = std::str::from_utf8(text).ok()?;
        if let Ok(value) = serde_json::from_str(text) {
            return Some(value);
        }
        // Malformed line from the client: stop loudly, the test will fail.
        eprintln!("mock-acp-agent: ignoring malformed line");
    }
}

/// Build mock permission request ID 900 with one allow-once and one reject-once option.
fn permission_request(session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 900,
        "method": "session/request_permission",
        "params": {
            "sessionId": session_id,
            "toolCall": {
                "toolCallId": "call_mock",
                "title": "mock tool",
                "kind": "other",
                "status": "pending"
            },
            "options": [
                { "optionId": "mock_allow", "name": "許可", "kind": "allow_once" },
                { "optionId": "mock_reject", "name": "拒否", "kind": "reject_once" }
            ]
        }
    })
}

/// Recognize only a selected `mock_reject` permission outcome, not cancellation or approval.
fn permission_denied(answer: &serde_json::Value) -> bool {
    answer
        .pointer("/result/outcome/outcome")
        .and_then(|outcome| outcome.as_str())
        == Some("selected")
        && answer
            .pointer("/result/outcome/optionId")
            .and_then(|id| id.as_str())
            == Some("mock_reject")
}

/// Publish independent fixture model and reasoning controls; production parsers are never reused.
fn model_options(model: &str, effort: &str) -> serde_json::Value {
    serde_json::json!([
        {"id":"model","name":"Model","category":"model","type":"select","currentValue":model,
         "options":[{"value":"fixture-a","name":"Fixture A"},{"value":"fixture-b","name":"Fixture B"}]},
        {"id":"reasoning","name":"Reasoning","category":"thought_level","type":"select","currentValue":effort,
         "options":[{"value":"high","name":"High"},{"value":"xhigh","name":"Xhigh"}]}
    ])
}

/// Serve the independent Codex account fixture, recording methods and refusing model turns.
fn serve_account_usage() {
    let mut methods = Vec::new();
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let message: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        assert!(
            message.get("jsonrpc").is_none(),
            "App Server omits the JSON-RPC header"
        );
        let method = message["method"].as_str().unwrap();
        methods.push(method.to_owned());
        let body = match method {
            "initialize" => {
                serde_json::json!({"id": message["id"], "result": {"userAgent": "fixture"}})
            }
            "initialized" => continue,
            "account/rateLimits/read" => {
                if let Some(folder) = flag_dir() {
                    std::fs::write(
                        folder.join("account-methods.json"),
                        serde_json::to_vec(&methods).unwrap(),
                    )
                    .unwrap();
                }
                if has_flag("--account-private-error") {
                    serde_json::json!({"id": message["id"], "error": {"code": -32000, "message": "private-provider-body-do-not-expose"}})
                } else {
                    serde_json::json!({"id": message["id"], "result": {"rateLimitsByLimitId": {"codex": {
                        "primary": {"usedPercent": 25, "windowDurationMins": 300, "resetsAt": 1800000000},
                        "credits": {"hasCredits": false, "unlimited": false, "balance": "0"}
                    }}}})
                }
            }
            _ => panic!("account reader requested a forbidden operation: {method}"),
        };
        let delay = flag_value("--respond-after-ms")
            .and_then(|text| text.parse::<u64>().ok())
            .unwrap_or(0);
        std::thread::sleep(Duration::from_millis(delay));
        out.write_all(&encode(&body)).unwrap();
        out.flush().unwrap();
    }
}

/// Serve independent ACP initialize/session/prompt fixtures over stdio until EOF.
/// Flags inject interleaving, fragmentation/coalescing, delays, huge lines,
/// permission denial, graceful cancellation, and staging writes before/after completion.
/// `--exit-early` exits with status 1; unsupported request methods receive mock errors.
fn main() {
    if has_flag("--exit-early") {
        std::process::exit(1);
    }
    if has_flag("--codex-account-usage") {
        serve_account_usage();
        return;
    }
    let delay_ms: u64 = flag_value("--respond-after-ms")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let no_chunks = has_flag("--no-chunks");
    let no_early_notify = has_flag("--no-early-notify");
    let no_permission = has_flag("--no-permission");
    let huge_line = has_flag("--huge-line");
    let cancel_graceful = has_flag("--cancel-graceful");

    let mut selected_model = String::from("fixture-a");
    let mut selected_effort = String::from("high");
    #[cfg(windows)]
    if let Some(dir) = flag_dir() {
        #[link(name = "kernel32")]
        extern "system" {
            /// Return the native console attached to this fixture process, if any.
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        let _ = std::fs::write(
            dir.join("console.txt"),
            (unsafe { GetConsoleWindow() } as usize).to_string(),
        );
    }
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut agent = Agent {
        out: std::io::stdout().lock(),
        fragment: has_flag("--fragment"),
        coalesce: has_flag("--coalesce"),
        pending: Vec::new(),
    };

    loop {
        let message = match read_message(&mut reader) {
            Some(message) => message,
            None => return,
        };
        let id = message
            .get("id")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let method = message
            .get("method")
            .and_then(|method| method.as_str())
            .unwrap_or("");
        match method {
            "initialize" => agent.respond(
                &id,
                serde_json::json!({
                    "protocolVersion": 1,
                    "agentCapabilities": { "loadSession": false },
                    "agentInfo": { "name": "marxen-mock-acp", "version": "0.1.0" },
                    "authMethods": []
                }),
            ),
            "session/new" => {
                if !no_early_notify {
                    // Interleaved notification BEFORE the response: the client
                    // must route by id instead of assuming order.
                    agent.send(&serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": "mock-sess-1",
                            "update": {
                                "sessionUpdate": "available_commands_update",
                                "availableCommands": []
                            }
                        }
                    }));
                }
                let mut result = serde_json::json!({ "sessionId": "mock-sess-1" });
                if has_flag("--models") {
                    result["configOptions"] = model_options(&selected_model, &selected_effort);
                }
                agent.respond(&id, result);
            }
            "session/set_config_option" => {
                let key = message
                    .pointer("/params/configId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let value = message
                    .pointer("/params/value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !has_flag("--ignore-model") {
                    if key == "model" {
                        selected_model = value.to_owned();
                    }
                    if key == "reasoning" {
                        selected_effort = value.to_owned();
                    }
                }
                agent.respond(&id, serde_json::json!({ "configOptions": model_options(&selected_model, &selected_effort) }));
            }
            "session/prompt" => {
                if has_flag("--models") {
                    if let Some(dir) = flag_dir() {
                        let _ = std::fs::write(
                            dir.join("prompt-model.json"),
                            serde_json::json!({"model":selected_model,"effort":selected_effort})
                                .to_string(),
                        );
                    }
                }
                let session_id = message
                    .pointer("/params/sessionId")
                    .and_then(|id| id.as_str())
                    .unwrap_or("mock-sess-1")
                    .to_owned();
                if cancel_graceful {
                    agent.notify_update(&session_id, "こんにちは");
                    agent.flush();
                    // Wait for the session/cancel NOTIFICATION (no id).
                    loop {
                        match read_message(&mut reader) {
                            Some(note)
                                if note.get("method").and_then(|method| method.as_str())
                                    == Some("session/cancel") =>
                            {
                                if note.get("id").is_some() {
                                    agent.respond_error(
                                        &id,
                                        "session/cancel must be a notification",
                                    );
                                } else {
                                    agent.respond(
                                        &id,
                                        serde_json::json!({ "stopReason": "cancelled" }),
                                    );
                                }
                                agent.flush();
                                break;
                            }
                            Some(_) => continue,
                            None => return,
                        }
                    }
                    // Clean shutdown marker: wait for stdin EOF, then flag it.
                    loop {
                        if read_message(&mut reader).is_none() {
                            break;
                        }
                    }
                    if let Some(dir) = flag_dir() {
                        let _ = std::fs::write(dir.join("clean_exit"), "ok");
                    }
                    return;
                }
                if delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }
                if huge_line {
                    agent.notify_update(&session_id, &"x".repeat(9_000_000));
                    agent.flush();
                    agent.respond(&id, serde_json::json!({ "stopReason": "end_turn" }));
                    agent.flush();
                    continue;
                }
                if !no_chunks {
                    agent.notify_update(&session_id, "こんにちは");
                    agent.flush();
                }
                if !no_permission {
                    agent.send(&permission_request(&session_id));
                    agent.flush();
                    let denied = match read_message(&mut reader) {
                        Some(answer) => {
                            if let Some(dir) = flag_dir() {
                                let _ = std::fs::write(
                                    dir.join("permission.json"),
                                    serde_json::to_vec(&answer).unwrap_or_default(),
                                );
                            }
                            permission_denied(&answer)
                        }
                        None => return,
                    };
                    if !denied {
                        agent.respond_error(&id, "permission outcome was not denied");
                        agent.flush();
                        continue;
                    }
                }
                if !no_chunks {
                    std::thread::sleep(Duration::from_millis(50));
                    agent.notify_update(&session_id, "世界");
                    agent.flush();
                }
                // A fake CLI edit of the scoped staging copy: the agent's cwd
                // is the staging dir, and it may only write contained paths.
                // With --write-after-response-ms, the write lands AFTER the
                // prompt terminal, while the child is still being reaped.
                let write_after_ms: u64 = flag_value("--write-after-response-ms")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                let staged_write = |agent: &mut Agent| {
                    if let (Some(rel), Some(text)) =
                        (flag_value("--write-staging"), flag_value("--write-text"))
                    {
                        let cwd = std::env::current_dir().unwrap_or_default();
                        match guarded_staging_target(&cwd, &rel) {
                            Ok(target) => {
                                if let Some(parent) = target.parent() {
                                    let _ = std::fs::create_dir_all(parent);
                                }
                                if std::fs::write(&target, text.as_bytes()).is_err() {
                                    agent.respond_error(&id, "staging write failed");
                                    agent.flush();
                                    return false;
                                }
                            }
                            Err(detail) => {
                                agent.respond_error(&id, &format!("staging rejected: {detail}"));
                                agent.flush();
                                return false;
                            }
                        }
                    }
                    true
                };
                if write_after_ms == 0 && !staged_write(&mut agent) {
                    continue;
                }
                agent.respond(&id, serde_json::json!({ "stopReason": "end_turn" }));
                agent.flush();
                if write_after_ms > 0 {
                    std::thread::sleep(Duration::from_millis(write_after_ms));
                    if !staged_write(&mut agent) {
                        continue;
                    }
                    agent.flush();
                }
            }
            "session/cancel" => {
                // Notification: no response is ever sent.
            }
            "$/cancel_request" => {
                // Notification: no response is ever sent.
            }
            _ => {
                if !id.is_null() {
                    agent.respond_error(&id, "unknown method");
                    agent.flush();
                }
            }
        }
        agent.flush();
    }
}
