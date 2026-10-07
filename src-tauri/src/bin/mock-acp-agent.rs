//! Mock ACP agent for integration tests. Speaks the same Content-Length
//! JSON-RPC framing as the real driver, with scripted replies. Never used in
//! production. Flags: --respond-after-ms N, --no-chunks, --exit-early.
use marxen_lib::ai::{encode_message, read_framed_message};
use marxen_lib::ai_contracts::AcpSessionId;
use std::io::{BufReader, Write};
use std::time::Duration;

fn respond(id: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn notify_update(session_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text }
            }
        }
    })
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

fn main() {
    if has_flag("--exit-early") {
        std::process::exit(1);
    }
    let delay_ms: u64 = flag_value("--respond-after-ms")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let no_chunks = has_flag("--no-chunks");

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = std::io::stdout().lock();
    let mut write = |value: &serde_json::Value| {
        stdout
            .write_all(&encode_message(value))
            .expect("write message");
        stdout.flush().expect("flush message");
    };

    loop {
        let message = match read_framed_message(&mut reader) {
            Ok(message) => message,
            Err(_) => return, // stdin closed: exit quietly
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
            "initialize" => write(&respond(&id, serde_json::json!({ "protocolVersion": 1 }))),
            "session/new" => write(&respond(
                &id,
                serde_json::json!({ "sessionId": AcpSessionId("mock-sess-1".into()).0 }),
            )),
            "session/prompt" => {
                let session_id = message
                    .pointer("/params/sessionId")
                    .and_then(|id| id.as_str())
                    .unwrap_or("mock-sess-1");
                if delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }
                if !no_chunks {
                    write(&notify_update(session_id, "こんにちは"));
                    std::thread::sleep(Duration::from_millis(50));
                    write(&notify_update(session_id, "世界"));
                }
                write(&respond(
                    &id,
                    serde_json::json!({ "stopReason": "end_turn" }),
                ));
            }
            "session/cancel" => write(&respond(&id, serde_json::json!({ "cancelled": true }))),
            _ => write(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "unknown method" }
            })),
        }
    }
}
