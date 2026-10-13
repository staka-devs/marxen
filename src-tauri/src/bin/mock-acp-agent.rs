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

/// Send a `session/update` tool-call announcement for the agentic demo.
/// `status` uses official values; titles and kinds mirror real agents.
fn agentic_tool_call(
    agent: &mut Agent,
    session_id: &str,
    tool_call_id: &str,
    title: &str,
    kind: &str,
    status: &str,
) {
    agent.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": tool_call_id,
                "title": title,
                "kind": kind,
                "status": status
            }
        }
    }));
}

/// Send a `session/update` tool-call progress update for the agentic demo.
/// Only the supplied patch fields are included, per the official schema.
fn agentic_tool_update(
    agent: &mut Agent,
    session_id: &str,
    tool_call_id: &str,
    status: &str,
    content: Option<serde_json::Value>,
) {
    let mut update = serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": tool_call_id,
        "status": status
    });
    if let Some(content) = content {
        update["content"] = content;
    }
    agent.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": { "sessionId": session_id, "update": update }
    }));
}

/// Send a complete `session/update` plan snapshot for the agentic demo.
/// Each payload carries all entries; clients replace the plan.
fn agentic_plan(agent: &mut Agent, session_id: &str, entries: &serde_json::Value) {
    agent.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": { "sessionUpdate": "plan", "entries": entries }
        }
    }));
}

/// Find the first regular file in the staging cwd for the agentic demo.
/// Returns its absolute path and UTF-8 content, or `None` when empty.
fn agentic_first_staged_file() -> Option<(std::path::PathBuf, String)> {
    let cwd = std::env::current_dir().ok()?;
    let mut candidates = Vec::new();
    let mut stack = vec![cwd.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).ok()?.flatten() {
            let path = entry.path();
            if entry.file_type().ok()?.is_dir() {
                stack.push(path);
                continue;
            }
            if entry.file_type().ok()?.is_symlink() {
                continue;
            }
            candidates.push(path);
        }
    }
    candidates.sort();
    for path in candidates {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(text) = String::from_utf8(bytes) {
                return Some((path, text));
            }
        }
    }
    None
}

/// Run the reproducible agentic demo: real multi-step read/edit/create with
/// visible tool/plan events and a permission choice.
///
/// Steps: plan (3 pending) → read tool (direct FS read) → fs/read_text_file
/// via client → edit tool (fs/write_text_file via client with diff) → create
/// tool (direct FS new `.md` with diff) → permission (denied skips privileged
/// write) → plan completed → text chunks → `end_turn`. All writes stay inside
/// the staging cwd; wrong paths are never attempted. Returns `false` when the
/// client disconnects mid-demo.
fn run_agentic_demo(
    agent: &mut Agent,
    reader: &mut BufReader<std::io::StdinLock<'_>>,
    id: &serde_json::Value,
    session_id: &str,
) -> bool {
    // 1. Plan with three pending steps.
    agentic_plan(
        agent,
        session_id,
        &serde_json::json!([
            {"content": "Read the staged document", "priority": "high", "status": "pending"},
            {"content": "Edit the staged document", "priority": "high", "status": "pending"},
            {"content": "Create a new note", "priority": "medium", "status": "pending"}
        ]),
    );
    agent.flush();

    // 2. Read tool via direct filesystem.
    agentic_tool_call(agent, session_id, "call_read_1", "Reading staged document", "read", "pending");
    agent.flush();
    let Some((first_path, first_text)) = agentic_first_staged_file() else {
        agent.respond_error(id, "agentic demo found no staged file");
        agent.flush();
        return true;
    };
    let first_abs = first_path.to_string_lossy().replace('\\', "/");
    agentic_tool_update(
        agent,
        session_id,
        "call_read_1",
        "in_progress",
        Some(serde_json::json!([
            {"type": "content", "content": {"type": "text", "text": "Reading staged file..."}}
        ])),
    );
    agent.flush();
    // Real read already happened above; report completion with a location.
    agent.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call_read_1",
                "status": "completed",
                "locations": [{"path": first_abs}]
            }
        }
    }));
    agent.flush();
    agentic_plan(
        agent,
        session_id,
        &serde_json::json!([
            {"content": "Read the staged document", "priority": "high", "status": "completed"},
            {"content": "Edit the staged document", "priority": "high", "status": "in_progress"},
            {"content": "Create a new note", "priority": "medium", "status": "pending"}
        ]),
    );
    agent.flush();

    // 3. Authorized read via client fs/read_text_file (proves IPC path).
    let fs_read_id = 1001;
    agent.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": fs_read_id,
        "method": "fs/read_text_file",
        "params": {"sessionId": session_id, "path": first_path.to_string_lossy()}
    }));
    agent.flush();
    let fs_content = match read_message(reader) {
        Some(reply) => reply
            .pointer("/result/content")
            .and_then(|content| content.as_str())
            .unwrap_or("")
            .to_owned(),
        None => return false,
    };
    if fs_content != first_text {
        agent.respond_error(id, "fs/read_text_file content mismatch");
        agent.flush();
        return true;
    }

    // 4. Edit tool via client fs/write_text_file with a real diff.
    agentic_tool_call(agent, session_id, "call_edit_1", "Editing staged document", "edit", "pending");
    agent.flush();
    agentic_tool_update(agent, session_id, "call_edit_1", "in_progress", None);
    agent.flush();
    let edited = format!("{first_text}\n\nAgentic edit.\n");
    agent.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1002,
        "method": "fs/write_text_file",
        "params": {
            "sessionId": session_id,
            "path": first_path.to_string_lossy(),
            "content": edited
        }
    }));
    agent.flush();
    match read_message(reader) {
        Some(reply) if reply.get("result").is_some() => {}
        _ => {
            agent.respond_error(id, "fs/write_text_file was rejected");
            agent.flush();
            return true;
        }
    }
    agentic_tool_update(
        agent,
        session_id,
        "call_edit_1",
        "completed",
        Some(serde_json::json!([
            {"type": "diff", "path": first_path.to_string_lossy(), "oldText": first_text, "newText": edited}
        ])),
    );
    agent.flush();
    agentic_plan(
        agent,
        session_id,
        &serde_json::json!([
            {"content": "Read the staged document", "priority": "high", "status": "completed"},
            {"content": "Edit the staged document", "priority": "high", "status": "completed"},
            {"content": "Create a new note", "priority": "medium", "status": "in_progress"}
        ]),
    );
    agent.flush();

    // 5. Create tool via direct filesystem with a real new Markdown file.
    agentic_tool_call(agent, session_id, "call_create_1", "Creating agentic note", "edit", "pending");
    agent.flush();
    agentic_tool_update(agent, session_id, "call_create_1", "in_progress", None);
    agent.flush();
    let cwd = std::env::current_dir().unwrap_or_default();
    let new_rel = "agentic-note.md";
    let new_target = match guarded_staging_target(&cwd, new_rel) {
        Ok(target) => target,
        Err(detail) => {
            agent.respond_error(id, &format!("staging rejected: {detail}"));
            agent.flush();
            return true;
        }
    };
    let new_text = "# Agentic note\n\nCreated by the reproducible mock agent.\n";
    if std::fs::write(&new_target, new_text.as_bytes()).is_err() {
        agent.respond_error(id, "staging write failed");
        agent.flush();
        return true;
    }
    agentic_tool_update(
        agent,
        session_id,
        "call_create_1",
        "completed",
        Some(serde_json::json!([
            {"type": "diff", "path": new_target.to_string_lossy(), "oldText": null, "newText": new_text}
        ])),
    );
    agent.flush();

    // 6. Permission choice: the test's reply decides the privileged write.
    // With `--agentic-allow` an allow answer writes the privileged file;
    // otherwise only a deny answer continues and the write is skipped.
    // Either way the choice has a real filesystem effect.
    agent.send(&permission_request(session_id));
    agent.flush();
    let answer = match read_message(reader) {
        Some(answer) => {
            if let Some(dir) = flag_dir() {
                let _ = std::fs::write(
                    dir.join("permission.json"),
                    serde_json::to_vec(&answer).unwrap_or_default(),
                );
            }
            answer
        }
        None => return false,
    };
    if has_flag("--agentic-allow") {
        if !permission_allowed(&answer) {
            agent.respond_error(id, "permission outcome was not allowed");
            agent.flush();
            return true;
        }
        let cwd = std::env::current_dir().unwrap_or_default();
        match guarded_staging_target(&cwd, "agentic-privileged.md") {
            Ok(target) => {
                if std::fs::write(&target, "# Privileged\n\nWritten after allow.\n").is_err() {
                    agent.respond_error(id, "staging write failed");
                    agent.flush();
                    return true;
                }
            }
            Err(detail) => {
                agent.respond_error(id, &format!("staging rejected: {detail}"));
                agent.flush();
                return true;
            }
        }
    } else {
        if !permission_denied(&answer) {
            agent.respond_error(id, "permission outcome was not denied");
            agent.flush();
            return true;
        }
    }

    // 7. Final plan, text, and terminal.
    agentic_plan(
        agent,
        session_id,
        &serde_json::json!([
            {"content": "Read the staged document", "priority": "high", "status": "completed"},
            {"content": "Edit the staged document", "priority": "high", "status": "completed"},
            {"content": "Create a new note", "priority": "medium", "status": "completed"}
        ]),
    );
    agent.flush();
    agent.notify_update(session_id, "Agentic work complete.");
    agent.flush();
    agent.respond(id, serde_json::json!({ "stopReason": "end_turn" }));
    agent.flush();
    true
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

/// Recognize only a selected `mock_allow` permission outcome for the allow-path demo.
fn permission_allowed(answer: &serde_json::Value) -> bool {
    answer
        .pointer("/result/outcome/outcome")
        .and_then(|outcome| outcome.as_str())
        == Some("selected")
        && answer
            .pointer("/result/outcome/optionId")
            .and_then(|id| id.as_str())
            == Some("mock_allow")
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
                if has_flag("--agentic-demo") {
                    if !run_agentic_demo(&mut agent, &mut reader, &id, &session_id) {
                        return;
                    }
                    continue;
                }
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
