//! Mock ACP agent for integration tests. Speaks official newline-delimited
//! compact UTF-8 JSON-RPC with an INDEPENDENT minimal implementation: this
//! file must not import framing helpers from marxen_lib (only serde_json),
//! so the tests genuinely verify interop rather than shared code.
//!
//! Flags: --respond-after-ms N, --no-chunks, --no-early-notify,
//! --no-permission, --fragment, --coalesce, --huge-line,
//! --cancel-graceful, --exit-early, --flag-dir PATH,
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

fn encode(value: &serde_json::Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(value).expect("mock message serializes");
    line.push(b'\n');
    line
}

impl Agent {
    fn send(&mut self, value: &serde_json::Value) {
        let line = encode(value);
        if self.coalesce {
            self.pending.extend_from_slice(&line);
            return;
        }
        self.write_line(&line);
    }

    fn flush(&mut self) {
        if self.coalesce && !self.pending.is_empty() {
            let bytes: Vec<u8> = std::mem::take(&mut self.pending);
            let _ = self.out.write_all(&bytes);
            let _ = self.out.flush();
        }
    }

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

    fn respond(&mut self, id: &serde_json::Value, result: serde_json::Value) {
        let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
        self.send(&reply);
    }

    fn respond_error(&mut self, id: &serde_json::Value, message: &str) {
        let reply = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32000, "message": message }
        });
        self.send(&reply);
    }

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

fn has_flag(name: &str) -> bool {
    std::env::args().skip(1).any(|arg| arg == name)
}

fn flag_dir() -> Option<std::path::PathBuf> {
    flag_value("--flag-dir").map(std::path::PathBuf::from)
}

/// Independent staging guard: the mock only writes contained relative paths
/// inside its cwd, mirroring the production containment rule.
fn guarded_staging_target(
    root: &std::path::Path,
    candidate: &str,
) -> Result<std::path::PathBuf, String> {
    use std::path::Component;
    if candidate.is_empty() {
        return Err("empty file".into());
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

fn main() {
    if has_flag("--exit-early") {
        std::process::exit(1);
    }
    let delay_ms: u64 = flag_value("--respond-after-ms")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let no_chunks = has_flag("--no-chunks");
    let no_early_notify = has_flag("--no-early-notify");
    let no_permission = has_flag("--no-permission");
    let huge_line = has_flag("--huge-line");
    let cancel_graceful = has_flag("--cancel-graceful");

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
                agent.respond(&id, serde_json::json!({ "sessionId": "mock-sess-1" }));
            }
            "session/prompt" => {
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
