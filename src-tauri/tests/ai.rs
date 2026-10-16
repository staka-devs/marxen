//! Issue #7 integration tests. HTTP backends run against a loopback mock
//! server; ACP runs against the mock-acp-agent subprocess. No real
//! credentials, no network beyond 127.0.0.1, no Claude Code anywhere.
use marxen_lib::application::ai::{credentials::*, runs::*};
use marxen_lib::contracts::ai::*;
use marxen_lib::contracts::{DocumentId, Revision, Utf16Offset, Utf16Range};
use marxen_lib::domain::ai::*;
use marxen_lib::infrastructure::ai::{acp::*, credentials::*, discovery::*, http::*};
use marxen_lib::infrastructure::staging::guard_staging_path as guard_isolation_path;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[test]
/// Read official account metadata while proving no conversation, inference or reset is requested.
fn codex_account_reader_only_requests_read_only_methods() {
    let markers = tempfile::tempdir().unwrap();
    let argv = AcpArgv {
        command: env!("CARGO_BIN_EXE_mock-acp-agent").into(),
        args: vec![
            "--codex-account-usage".into(),
            "--flag-dir".into(),
            markers.path().to_string_lossy().into_owned(),
        ],
    };
    let reports = marxen_lib::infrastructure::ai::account_usage::read_codex_with_argv(
        &argv,
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].primary.as_ref().unwrap().used_percent, 25.0);
    assert_eq!(
        reports[0].credits.as_ref().unwrap().balance.as_deref(),
        Some("0")
    );
    let methods: Vec<String> = serde_json::from_slice(
        &std::fs::read(markers.path().join("account-methods.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        methods,
        ["initialize", "initialized", "account/rateLimits/read"]
    );
}

#[test]
/// Time out silent readers and suppress private provider error bodies.
fn codex_account_reader_bounds_waiting_and_never_returns_private_error_bodies() {
    for args in [
        vec!["--codex-account-usage", "--respond-after-ms", "200"],
        vec!["--codex-account-usage", "--account-private-error"],
    ] {
        let timeout = if args.contains(&"200") {
            Duration::from_millis(25)
        } else {
            Duration::from_secs(5)
        };
        let argv = AcpArgv {
            command: env!("CARGO_BIN_EXE_mock-acp-agent").into(),
            args: args.into_iter().map(str::to_owned).collect(),
        };
        let error =
            marxen_lib::infrastructure::ai::account_usage::read_codex_with_argv(&argv, timeout)
                .unwrap_err();
        assert!(matches!(error, AiError::ConnectionFailed { .. }));
        assert!(!format!("{error:?}").contains("private-provider-body"));
    }
}

/// Build a fixed revision context containing emoji and Japanese text for wire and streaming checks.
fn context() -> PromptContext {
    PromptContext {
        location: None,
        document_id: DocumentId("doc_07".into()),
        revision: Revision(3),
        ranges: vec![Utf16Range {
            start: Utf16Offset(0),
            end: Utf16Offset(5),
        }],
        text: "a😀日本語".into(),
    }
}

/// Build a rewrite request pointed at the supplied loopback OpenAI Chat Completions endpoint.
fn openai_request(base: &str) -> AiPromptRequest {
    AiPromptRequest {
        conversation_id: None,
        provider: AiProviderConfig {
            kind: AiProviderKind::OpenaiChatCompletions,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: base.into(),
                model: "mock-model".into(),
            }),
            anthropic: None,
            connection_id: None,
        },
        mode: PromptMode::Rewrite,
        prompt: "書き換えてください".into(),
        contexts: vec![context()],
        staging: StagingTarget {
            copy_id: IsolatedCopyId("copy_07".into()),
        },
        session_id: None,
        history: vec![],
    }
}

/// Reuse the rewrite fixture with an explicitly enabled Anthropic Messages endpoint.
fn anthropic_request(base: &str) -> AiPromptRequest {
    let mut request = openai_request(base);
    request.provider = AiProviderConfig {
        kind: AiProviderKind::Anthropic,
        acp: None,
        openai: None,
        anthropic: Some(AnthropicConfig {
            enabled: true,
            endpoint: base.into(),
            model: "mock-model".into(),
        }),
        connection_id: None,
    };
    request
}

struct MockHttp {
    base: String,
    seen: std::sync::mpsc::Receiver<String>,
    done: Option<std::thread::JoinHandle<()>>,
}

/// Read bounded HTTP headers and drain the declared body before the mock server replies.
fn read_http_head(stream: &mut std::net::TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read_exact(&mut byte).is_err() || head.len() > 65536 {
            break;
        }
        head.extend_from_slice(&byte);
    }
    let head_text = String::from_utf8_lossy(&head).into_owned();
    // Swallow the body so pipelined writes never interleave with the reply.
    // Header names are matched case-insensitively (hyper sends lowercase).
    let length = head_text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    });
    if let Some(length) = length {
        let mut body = vec![0u8; length.min(1_048_576)];
        let _ = stream.read_exact(&mut body);
        return format!("{head_text}{}", String::from_utf8_lossy(&body));
    }
    head_text
}

/// Accept one connection with a real deadline: a client that never connects
/// (for example a run cancelled before its first byte) must not hang the
/// server thread's join forever.
fn accept_bounded(listener: &TcpListener) -> Option<std::net::TcpStream> {
    listener.set_nonblocking(true).expect("nonblocking");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = listener.set_nonblocking(false);
                // The accepted socket inherits nonblocking mode: restore
                // blocking I/O before the bounded read/write helpers use it.
                let _ = stream.set_nonblocking(false);
                return Some(stream);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("accept: {error}"),
        }
    }
}

/// Serve staged replies on one connection: each stage is (delay_ms, bytes).
fn serve(stages: Vec<(u64, Vec<u8>)>) -> MockHttp {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let base = format!(
        "http://127.0.0.1:{}",
        listener.local_addr().expect("port").port()
    );
    let (seen_tx, seen_rx) = std::sync::mpsc::channel();
    let done = std::thread::spawn(move || {
        let Some(mut stream) = accept_bounded(&listener) else {
            return;
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        let head = read_http_head(&mut stream);
        let _ = seen_tx.send(head);
        for (delay_ms, bytes) in stages {
            if delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
            if stream.write_all(&bytes).is_err() {
                return;
            }
        }
    });
    MockHttp {
        base,
        seen: seen_rx,
        done: Some(done),
    }
}

/// Encode a complete HTTP event-stream response using the UTF-8 byte length of its body.
fn sse_reply(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

/// Encode the supplied HTTP status and JSON body for transport error mapping tests.
fn status_reply(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

/// Combine streamed chunks and report whether done or cancellation terminal events arrived.
fn events_of(events: &[AiStreamEvent]) -> (String, bool, bool) {
    let mut text = String::new();
    let mut done = false;
    let mut cancelled = false;
    for event in events {
        match event {
            AiStreamEvent::Chunk(chunk) => text.push_str(&chunk.text),
            AiStreamEvent::Done(_) => done = true,
            AiStreamEvent::Cancelled(_) => cancelled = true,
            _ => {}
        }
    }
    (text, done, cancelled)
}

#[tokio::test]
/// Check streamed Unicode output and sent-context metadata against a loopback Chat Completions server.
async fn openai_streams_mock_sse_with_sent_echo() {
    let body = include_str!("../../tests/fixtures/ai_sse_openai.txt").replace("\r\n", "\n");
    let mut server = serve(vec![(0, sse_reply(&body))]);
    let request = openai_request(&server.base);
    let run_id = AiRunId("run_openai".into());
    let cancel = AtomicBool::new(false);
    let mut events = Vec::new();
    let client = http_client(Duration::from_secs(20)).unwrap();
    let target = http_target(&request.provider).unwrap();
    run_http_prompt(
        &client,
        &target,
        "mock-secret",
        &request,
        &run_id,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    )
    .await
    .unwrap();
    let (text, done, cancelled) = events_of(&events);
    assert_eq!(text, "Hello, 世界！");
    assert!(done && !cancelled);
    match events.last().expect("done") {
        AiStreamEvent::Done(done) => {
            assert_eq!(done.proposal.text, "Hello, 世界！");
            assert_eq!(done.proposal.base_contexts.len(), 1);
            assert_eq!(done.proposal.base_contexts[0].revision, Revision(3));
            assert_eq!(done.sent.len(), 1);
            assert_eq!(done.sent[0].ranges.len(), 1);
            assert_eq!(done.sent[0].chars, "a😀日本語".chars().count() as u32);
        }
        other => panic!("expected done, got {other:?}"),
    }
    let head = server.seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(head.starts_with("POST /chat/completions"));
    assert!(head
        .to_ascii_lowercase()
        .contains("authorization: bearer mock-secret"));
    server.done.take().expect("join").join().expect("server");
}

#[tokio::test]
/// Check Messages streaming output and the required API version header without external credentials.
async fn anthropic_streams_mock_sse_with_version_header() {
    let body = include_str!("../../tests/fixtures/ai_sse_anthropic.txt").replace("\r\n", "\n");
    let mut server = serve(vec![(0, sse_reply(&body))]);
    let request = anthropic_request(&server.base);
    let run_id = AiRunId("run_anthropic".into());
    let cancel = AtomicBool::new(false);
    let mut events = Vec::new();
    let client = http_client(Duration::from_secs(20)).unwrap();
    let target = http_target(&request.provider).unwrap();
    run_http_prompt(
        &client,
        &target,
        "mock-secret",
        &request,
        &run_id,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    )
    .await
    .unwrap();
    let (text, done, cancelled) = events_of(&events);
    assert_eq!(text, "Hello, 世界！");
    assert!(done && !cancelled);
    let head = server.seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(head.starts_with("POST /messages"));
    assert!(head.to_ascii_lowercase().contains("x-api-key: mock-secret"));
    assert!(head
        .to_ascii_lowercase()
        .contains("anthropic-version: 2023-06-01"));
    server.done.take().expect("join").join().expect("server");
}

#[tokio::test]
/// Distinguish rejected credentials from HTTP connection failures using controlled server responses.
async fn http_errors_map_to_auth_and_connection_failures() {
    let mut server = serve(vec![(
        0,
        status_reply("401 Unauthorized", r#"{"error": "invalid key"}"#),
    )]);
    let request = openai_request(&server.base);
    let run_id = AiRunId("run_401".into());
    let cancel = AtomicBool::new(false);
    let mut events = Vec::new();
    let client = http_client(Duration::from_secs(20)).unwrap();
    let target = http_target(&request.provider).unwrap();
    let outcome = run_http_prompt(
        &client,
        &target,
        "bad-secret",
        &request,
        &run_id,
        &cancel,
        &mut |event| events.push(event),
    )
    .await;
    assert!(matches!(outcome, Err(AiError::AuthFailed { .. })));
    assert!(matches!(events.last(), Some(AiStreamEvent::Error(_))));
    server.done.take().expect("join").join().expect("server");

    let mut server = serve(vec![(0, status_reply("500 Internal Server Error", "boom"))]);
    let request = anthropic_request(&server.base);
    let run_id = AiRunId("run_500".into());
    let mut events = Vec::new();
    let target = http_target(&request.provider).unwrap();
    let outcome = run_http_prompt(
        &client,
        &target,
        "mock-secret",
        &request,
        &run_id,
        &cancel,
        &mut |event| events.push(event),
    )
    .await;
    assert!(matches!(outcome, Err(AiError::ConnectionFailed { .. })));
    server.done.take().expect("join").join().expect("server");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
/// Require cancellation after a chunk to suppress successful completion and further streamed output.
async fn http_cancel_midstream_stops_without_done() {
    let body = include_str!("../../tests/fixtures/ai_sse_openai.txt").replace("\r\n", "\n");
    // Deliver through the first content chunk ("Hello, "), then stall so the
    // client must cancel mid-stream. The fixture opens with a ping comment
    // and a role-only delta, neither of which emits a Chunk, so the split
    // must fall after real content.
    let mut ends = body.match_indices("\n\n").map(|(index, _)| index + 2);
    let (_ping, _role, hello) = (
        ends.next().expect("ping"),
        ends.next().expect("role"),
        ends.next().expect("hello"),
    );
    let (first, rest) = body.split_at(hello);
    assert!(first.contains("Hello, "));
    let mut server = serve(vec![
        (0, sse_reply_chunked(first)),
        (3_000, rest.as_bytes().to_vec()),
    ]);
    let request = openai_request(&server.base);
    let run_id = AiRunId("run_cancel".into());
    let cancel = Arc::new(AtomicBool::new(false));
    let events: Arc<Mutex<Vec<AiStreamEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let client = http_client(Duration::from_secs(30)).unwrap();
    let target = http_target(&request.provider).unwrap();
    let driver_events = events.clone();
    let driver_cancel = cancel.clone();
    let driver = tokio::spawn(async move {
        let mut emit = |event: AiStreamEvent| {
            driver_events.lock().expect("events lock").push(event);
        };
        run_http_prompt(
            &client,
            &target,
            "mock-secret",
            &request,
            &run_id,
            &driver_cancel,
            &mut emit,
        )
        .await
    });
    // Wait for the first chunk with a real deadline, then cancel: a blind
    // yield loop would let a missing chunk slip through and weaken the proof.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let has_chunk = events
                .lock()
                .expect("events lock")
                .iter()
                .any(|event| matches!(event, AiStreamEvent::Chunk(_)));
            if has_chunk {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first streamed chunk");
    cancel.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(15), driver)
        .await
        .expect("driver settles after cancel")
        .expect("driver")
        .unwrap();
    let events = events.lock().expect("events lock").clone();
    let (_, done, cancelled) = events_of(&events);
    assert!(cancelled && !done);
    server.done.take().expect("join").join().expect("server");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
/// Require cancellation to finish promptly even when the peer keeps an event stream silent.
async fn http_cancel_while_silent_server_holds_stream() {
    // The server accepts and reads the request, then stays silent: without
    // stall-aware reads the run would hang until the client timeout.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let base = format!(
        "http://127.0.0.1:{}",
        listener.local_addr().expect("port").port()
    );
    let (seen_tx, seen_rx) = std::sync::mpsc::channel::<()>();
    // Detached on purpose: the sleeper must not gate the test's join. The
    // cancellation proof is the driver's prompt settlement, not thread exit.
    std::thread::spawn(move || {
        let Some(mut stream) = accept_bounded(&listener) else {
            return;
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        read_http_head(&mut stream);
        let _ = seen_tx.send(());
        // Silence past any test patience: cancellation must win first.
        std::thread::sleep(Duration::from_secs(30));
    });
    let request = openai_request(&base);
    let run_id = AiRunId("run_silent_cancel".into());
    let cancel = Arc::new(AtomicBool::new(false));
    let events: Arc<Mutex<Vec<AiStreamEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let client = http_client(Duration::from_secs(60)).unwrap();
    let target = http_target(&request.provider).unwrap();
    let driver_events = events.clone();
    let driver_cancel = cancel.clone();
    let driver = tokio::spawn(async move {
        let mut emit = |event: AiStreamEvent| {
            driver_events.lock().expect("events lock").push(event);
        };
        run_http_prompt(
            &client,
            &target,
            "mock-secret",
            &request,
            &run_id,
            &driver_cancel,
            &mut emit,
        )
        .await
    });
    // The request reached the silent server; now cancel and prove the driver
    // settles promptly instead of waiting out the 60s client timeout.
    seen_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("request seen");
    cancel.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(10), driver)
        .await
        .expect("cancel wins over the silent server")
        .expect("driver")
        .unwrap();
    let events = events.lock().expect("events lock").clone();
    let (_, done, cancelled) = events_of(&events);
    assert!(cancelled && !done, "{events:?}");
}

/// Start a chunked HTTP event stream that can remain open without declaring a final body length.
fn sse_reply_chunked(first: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
        first
    )
    .into_bytes()
}

#[tokio::test]
/// Exercise the live connection-test path exclusively against disposable loopback servers.
async fn live_tests_use_mock_server_without_real_credentials() {
    let mut server = serve(vec![(0, status_reply("200 OK", r#"{"data": []}"#))]);
    let client = http_client(Duration::from_secs(20)).unwrap();
    let result = test_openai_live(&client, &server.base, "mock-secret")
        .await
        .unwrap();
    assert!(result.ok);
    server.done.take().expect("join").join().expect("server");

    let mut server = serve(vec![(0, status_reply("401 Unauthorized", "bad"))]);
    let result = test_openai_live(&client, &server.base, "bad-secret")
        .await
        .unwrap();
    assert!(!result.ok);
    server.done.take().expect("join").join().expect("server");

    let mut server = serve(vec![(0, status_reply("200 OK", r#"{"type": "message"}"#))]);
    let result = test_anthropic_live(&client, &server.base, "mock-model", "mock-secret")
        .await
        .unwrap();
    assert!(result.ok);
    server.done.take().expect("join").join().expect("server");
}

/// Build a custom ACP rewrite request with a fixed scope and no resumable session.
fn acp_request(argv: AcpArgv) -> AiPromptRequest {
    AiPromptRequest {
        conversation_id: None,
        provider: AiProviderConfig {
            kind: AiProviderKind::Acp,
            acp: Some(AcpConfig {
                selections: None,
                preset: AcpPreset::Custom,
                argv: Some(argv),
            }),
            openai: None,
            anthropic: None,
            connection_id: None,
        },
        mode: PromptMode::Workspace,
        prompt: "修正案をください".into(),
        contexts: vec![context()],
        staging: StagingTarget {
            copy_id: IsolatedCopyId("copy_07".into()),
        },
        session_id: None,
        history: vec![],
    }
}

/// Select the Cargo-built mock ACP executable and preserve each additional argument separately.
fn mock_agent_argv(extra: &[&str]) -> AcpArgv {
    let exe = env!("CARGO_BIN_EXE_mock-acp-agent");
    AcpArgv {
        command: exe.into(),
        args: extra.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

/// Configure the mock ACP executable to record process-lifecycle flags in the supplied fixture directory.
fn mock_agent_argv_with_flag_dir(extra: &[&str], flag_dir: &Path) -> AcpArgv {
    let exe = env!("CARGO_BIN_EXE_mock-acp-agent");
    let mut args: Vec<String> = extra.iter().map(|arg| (*arg).to_owned()).collect();
    args.push("--flag-dir".to_owned());
    args.push(flag_dir.to_string_lossy().into_owned());
    AcpArgv {
        command: exe.into(),
        args,
    }
}

/// Create a process- and time-specific temporary directory for a subprocess fixture.
fn fresh_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test dir");
    dir
}

/// Bind a mock ACP command to its staging directory and bounded run timeout.
fn acp_params(argv: AcpArgv, dir: &Path, timeout: Duration) -> AcpRunParams {
    AcpRunParams {
        argv,
        staging_dir: dir.to_owned(),
        timeout,
    }
}

#[test]
/// Require ACP output and sent metadata to use the isolated working directory through terminal settlement.
fn acp_full_run_streams_chunks_inside_staging_copy() {
    let staging = std::env::temp_dir().join("marxen-ai-test-staging");
    std::fs::create_dir_all(&staging).expect("staging dir");
    std::fs::create_dir_all(staging.join("copy_07")).expect("copy dir");
    let flags = fresh_dir("marxen-ai-test-flags-full");
    let request = acp_request(mock_agent_argv_with_flag_dir(&[], &flags));
    let staging_dir =
        guard_isolation_path(&staging, Path::new(&request.staging.copy_id.0)).unwrap();
    assert!(staging_dir.starts_with(&staging));
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = acp_params(
        request
            .provider
            .acp
            .as_ref()
            .expect("acp")
            .argv
            .clone()
            .expect("argv"),
        &staging_dir,
        Duration::from_secs(30),
    );
    let mut events = Vec::new();
    let replies = registry.clone();
    run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            // Answer the surfaced permission request exactly as the chat UI
            // does, so the run settles on a real user choice without waiting
            // for the run deadline.
            if let AiStreamEvent::Permission(permission) = &event {
                replies
                    .reply_permission(&permission.run_id, &permission.request_id, "mock_reject")
                    .expect("pending permission reply");
            }
            events.push(event);
        },
    )
    .unwrap();
    let (text, done, cancelled) = events_of(&events);
    assert_eq!(text, "こんにちは世界");
    assert!(done && !cancelled);
    // The permission request surfaces as a chat event before the terminal,
    // carrying the agent's own request id for the reply envelope.
    let permission_index = events
        .iter()
        .position(|event| matches!(event, AiStreamEvent::Permission(_)))
        .expect("permission surfaces before settlement");
    let done_index = events
        .iter()
        .position(|event| matches!(event, AiStreamEvent::Done(_)))
        .expect("terminal done");
    assert!(permission_index < done_index);
    if let AiStreamEvent::Permission(permission) = &events[permission_index] {
        assert_eq!(permission.request_id, "900");
        assert_eq!(permission.run_id, run_id);
        assert!(permission
            .options
            .iter()
            .any(|option| option.option_id == "mock_reject"));
    } else {
        unreachable!("permission event");
    }
    // The mock's permission request must have been answered by selecting
    // the reject option, bearing the agent's own request id (900).
    let logged = std::fs::read(flags.join("permission.json")).expect("permission log");
    let answer: serde_json::Value = serde_json::from_slice(&logged).expect("permission json");
    assert_eq!(answer.get("id"), Some(&serde_json::json!(900)));
    assert_eq!(
        answer
            .pointer("/result/outcome/outcome")
            .and_then(|outcome| outcome.as_str()),
        Some("selected")
    );
    assert_eq!(
        answer
            .pointer("/result/outcome/optionId")
            .and_then(|id| id.as_str()),
        Some("mock_reject")
    );
}

/// Seed one Markdown file inside a fresh staging copy for the agentic demo.
///
/// Returns the staging root and the agent working directory holding the seed.
/// The mock discovers, reads, edits, and extends exactly these bytes.
fn seed_agentic_staging(name: &str, seed: &str) -> (PathBuf, PathBuf) {
    let staging = fresh_dir(&format!("marxen-ai-test-staging-{name}"));
    let staging_dir = staging.join("copy_07");
    std::fs::create_dir_all(&staging_dir).expect("copy dir");
    std::fs::write(staging_dir.join("seed.md"), seed).expect("seed file");
    (staging, staging_dir)
}

/// Run the reproducible agentic demo, answering its permission request.
///
/// Replies with `choice` as the chat UI does and collects every event.
/// Returns the events, the flag directory with `permission.json`, and the
/// agent working directory holding edited and created files.
fn run_agentic_demo(
    name: &str,
    extra: &[&str],
    choice: &str,
    timeout: Duration,
) -> (Vec<AiStreamEvent>, PathBuf, PathBuf) {
    let flags = fresh_dir(&format!("marxen-ai-test-flags-{name}"));
    let mut args: Vec<String> = extra.iter().map(|arg| (*arg).to_owned()).collect();
    args.push("--agentic-demo".into());
    let argv =
        mock_agent_argv_with_flag_dir(&args.iter().map(String::as_str).collect::<Vec<_>>(), &flags);
    let request = acp_request(argv.clone());
    let (_, staging_dir) = seed_agentic_staging(name, "# Seed\n");
    let params = acp_params(argv, &staging_dir, timeout);
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let mut events = Vec::new();
    let replies = registry.clone();
    run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            if let AiStreamEvent::Permission(permission) = &event {
                replies
                    .reply_permission(&permission.run_id, &permission.request_id, choice)
                    .expect("pending permission reply");
            }
            events.push(event);
        },
    )
    .unwrap();
    (events, flags, staging_dir)
}

/// Order one event variant before another inside a collected run.
fn event_index(events: &[AiStreamEvent], what: &str) -> usize {
    events
        .iter()
        .position(|event| {
            matches!(
                (what, event),
                ("plan", AiStreamEvent::Plan(_))
                    | ("tool_call", AiStreamEvent::ToolCall(_))
                    | ("tool_call_update", AiStreamEvent::ToolCallUpdate(_))
                    | ("permission", AiStreamEvent::Permission(_))
                    | ("done", AiStreamEvent::Done(_))
                    | ("cancelled", AiStreamEvent::Cancelled(_))
            )
        })
        .unwrap_or_else(|| panic!("missing {what} in {events:?}"))
}

#[test]
/// Prove multi-step read/edit/create with a denied permission choice.
///
/// The mock reads the seed, edits it through `fs/write_text_file`, creates a
/// new note, then honors the deny answer by skipping its privileged write.
/// Plan, tool, permission, and done events arrive once and in lifecycle
/// order with a single terminal and no foreign run IDs.
fn agentic_demo_multistep_deny_records_order_and_contents() {
    let (events, flags, staging_dir) =
        run_agentic_demo("deny", &[], "mock_reject", Duration::from_secs(30));
    let plan = event_index(&events, "plan");
    let call = event_index(&events, "tool_call");
    let permission = event_index(&events, "permission");
    let done = event_index(&events, "done");
    assert!(plan < call && call < permission && permission < done);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                AiStreamEvent::Done(_) | AiStreamEvent::Cancelled(_) | AiStreamEvent::Error(_)
            ))
            .count(),
        1,
        "settles exactly once, got {events:?}"
    );
    let calls: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            AiStreamEvent::ToolCall(call) => Some(call.tool_call.tool_call_id.as_str()),
            _ => None,
        })
        .collect();
    assert!(calls.contains(&"call_read_1"), "read step, got {calls:?}");
    assert!(calls.contains(&"call_edit_1"), "edit step, got {calls:?}");
    assert!(
        calls.contains(&"call_create_1"),
        "create step, got {calls:?}"
    );
    for event in &events {
        let event_run = match event {
            AiStreamEvent::Started(started) => &started.run_id,
            AiStreamEvent::Chunk(chunk) => &chunk.run_id,
            AiStreamEvent::Usage(usage) => &usage.run_id,
            AiStreamEvent::ToolCall(call) => &call.run_id,
            AiStreamEvent::ToolCallUpdate(update) => &update.run_id,
            AiStreamEvent::Plan(plan) => &plan.run_id,
            AiStreamEvent::Permission(permission) => &permission.run_id,
            AiStreamEvent::Done(done) => &done.run_id,
            AiStreamEvent::Error(error) => error.run_id.as_ref().expect("error run"),
            AiStreamEvent::Cancelled(cancelled) => &cancelled.run_id,
        };
        assert!(event_run.0.starts_with("run_"));
    }
    // Every event belongs to the single owning run: no foreign session leaks.
    let mut owners: Vec<&str> = events
        .iter()
        .map(|event| match event {
            AiStreamEvent::Started(started) => started.run_id.0.as_str(),
            AiStreamEvent::Chunk(chunk) => chunk.run_id.0.as_str(),
            AiStreamEvent::Usage(usage) => usage.run_id.0.as_str(),
            AiStreamEvent::ToolCall(call) => call.run_id.0.as_str(),
            AiStreamEvent::ToolCallUpdate(update) => update.run_id.0.as_str(),
            AiStreamEvent::Plan(plan) => plan.run_id.0.as_str(),
            AiStreamEvent::Permission(permission) => permission.run_id.0.as_str(),
            AiStreamEvent::Done(done) => done.run_id.0.as_str(),
            AiStreamEvent::Error(error) => error.run_id.as_ref().expect("error run").0.as_str(),
            AiStreamEvent::Cancelled(cancelled) => cancelled.run_id.0.as_str(),
        })
        .collect();
    owners.sort_unstable();
    owners.dedup();
    assert_eq!(owners.len(), 1, "single owning run, got {owners:?}");
    // Real filesystem effects: the seed carries the agent edit and the new
    // note exists verbatim, while the denied privileged write never lands.
    let edited = std::fs::read_to_string(staging_dir.join("seed.md")).expect("edited seed");
    assert!(edited.contains("Agentic edit."), "{edited}");
    let created = std::fs::read_to_string(staging_dir.join("agentic-note.md")).expect("new note");
    assert!(
        created.contains("Created by the reproducible mock agent."),
        "{created}"
    );
    assert!(!staging_dir.join("agentic-privileged.md").exists());
    let answer: serde_json::Value = serde_json::from_slice(
        &std::fs::read(flags.join("permission.json")).expect("permission log"),
    )
    .expect("permission json");
    assert_eq!(
        answer
            .pointer("/result/outcome/optionId")
            .and_then(|id| id.as_str()),
        Some("mock_reject")
    );
}

#[test]
/// Prove an allowed permission choice enables the privileged write.
///
/// Answering with the allow option completes the same multi-step run and the
/// mock writes its privileged file, so the choice provably changes the
/// filesystem instead of merely relabeling the denial.
fn agentic_demo_allow_enables_privileged_write() {
    let (events, flags, staging_dir) = run_agentic_demo(
        "allow",
        &["--agentic-allow"],
        "mock_allow",
        Duration::from_secs(30),
    );
    assert!(event_index(&events, "permission") < event_index(&events, "done"));
    let privileged = std::fs::read_to_string(staging_dir.join("agentic-privileged.md"))
        .expect("privileged file");
    assert!(privileged.contains("Written after allow."), "{privileged}");
    let answer: serde_json::Value = serde_json::from_slice(
        &std::fs::read(flags.join("permission.json")).expect("permission log"),
    )
    .expect("permission json");
    assert_eq!(
        answer
            .pointer("/result/outcome/optionId")
            .and_then(|id| id.as_str()),
        Some("mock_allow")
    );
}

#[test]
/// Settle an agentic run exactly once when cancellation wins the permission wait.
///
/// Cancelling on the first visible plan settles the run as cancelled with no
/// late done or error terminal following it.
fn agentic_demo_cancel_during_permission_wait_settles_once() {
    let flags = fresh_dir("marxen-ai-test-flags-agentic-cancel");
    let argv = mock_agent_argv_with_flag_dir(&["--agentic-demo"], &flags);
    let request = acp_request(argv.clone());
    let (_, staging_dir) = seed_agentic_staging("cancel", "# Seed\n");
    let params = acp_params(argv, &staging_dir, Duration::from_secs(30));
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let mut events = Vec::new();
    let mut cancelled_on_plan = false;
    let mut emit = |event: AiStreamEvent| {
        // Cancel synchronously at the first visible plan: no observer thread
        // may race a completed demo after a scheduler delay.
        if !cancelled_on_plan && matches!(&event, AiStreamEvent::Plan(_)) {
            cancelled_on_plan = registry.cancel(&run_id);
        }
        events.push(event);
    };
    run_acp_prompt(&params, &request, &run_id, &registry, &cancel, &mut emit).unwrap();
    assert!(cancelled_on_plan, "the demo must reach its first plan");
    let (_, done, cancelled) = events_of(&events);
    assert!(
        cancelled && !done,
        "cancellation settles once, got {events:?}"
    );
}

#[test]
/// Reject an unowned resume identifier rather than reusing another agent session.
fn acp_resume_ids_are_unknown_by_construction() {
    let staging = std::env::temp_dir().join("marxen-ai-test-resume");
    std::fs::create_dir_all(&staging).expect("staging dir");
    let mut request = acp_request(mock_agent_argv(&[]));
    request.session_id = Some(AcpSessionId("stale_session".into()));
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = acp_params(mock_agent_argv(&[]), &staging, Duration::from_secs(30));
    let mut events = Vec::new();
    let outcome = run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    );
    assert!(matches!(outcome, Err(AiError::UnknownSession)));
}

#[test]
/// Expose executable discovery failure and premature child exit as distinct observable ACP failures.
fn acp_missing_binary_and_early_exit_are_explicit_errors() {
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let request = acp_request(AcpArgv {
        command: "marxen-definitely-missing-binary".into(),
        args: vec![],
    });
    let params = acp_params(
        request
            .provider
            .acp
            .as_ref()
            .expect("acp")
            .argv
            .clone()
            .expect("argv"),
        &std::env::temp_dir(),
        Duration::from_secs(30),
    );
    let mut events = Vec::new();
    let outcome = run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    );
    assert!(matches!(outcome, Err(AiError::MissingBinary { .. })));

    let staging = std::env::temp_dir().join("marxen-ai-test-exit");
    std::fs::create_dir_all(&staging).expect("staging dir");
    let request = acp_request(mock_agent_argv(&["--exit-early"]));
    let (run_id, cancel) = registry.register();
    let params = acp_params(
        mock_agent_argv(&["--exit-early"]),
        &staging,
        Duration::from_secs(30),
    );
    let mut events = Vec::new();
    let outcome = run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    );
    assert!(outcome.is_err());
}

#[test]
/// Require a timed-out ACP run to terminate its child and emit a timeout result.
fn acp_timeout_kills_slow_agents() {
    let staging = std::env::temp_dir().join("marxen-ai-test-timeout");
    std::fs::create_dir_all(&staging).expect("staging dir");
    let request = acp_request(mock_agent_argv(&["--respond-after-ms=3000"]));
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = acp_params(
        mock_agent_argv(&["--respond-after-ms=3000"]),
        &staging,
        Duration::from_secs(1),
    );
    let mut events = Vec::new();
    run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    )
    .unwrap();
    assert!(
        events.iter().any(|event| matches!(
            event,
            AiStreamEvent::Error(StreamError {
                error: AiError::StreamFailed { .. },
                ..
            })
        )),
        "timeout must surface as a stream error, got {events:?}"
    );
}

#[test]
/// Require explicit run cancellation to stop the ACP child without emitting successful completion.
fn acp_cancel_midrun_kills_the_agent() {
    let staging = std::env::temp_dir().join("marxen-ai-test-cancel");
    std::fs::create_dir_all(&staging).expect("staging dir");
    let argv = mock_agent_argv(&["--no-early-notify", "--no-permission"]);
    let request = acp_request(argv.clone());
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = acp_params(argv, &staging, Duration::from_secs(30));
    let mut events = Vec::new();
    let mut cancelled_on_chunk = false;
    let mut emit = |event: AiStreamEvent| {
        // Cancel synchronously at the first prompt chunk: an observer thread
        // must never race a completed prompt after a scheduler delay.
        if !cancelled_on_chunk && matches!(&event, AiStreamEvent::Chunk(_)) {
            cancelled_on_chunk = registry.cancel(&run_id);
        }
        events.push(event);
    };
    run_acp_prompt(&params, &request, &run_id, &registry, &cancel, &mut emit).unwrap();
    assert!(
        cancelled_on_chunk,
        "the real prompt must reach its first chunk"
    );
    let (_, done, cancelled) = events_of(&events);
    assert!(cancelled && !done);
}

#[test]
/// Exercise configuration and protocol readiness using fixtures without reading user credentials.
fn dry_runs_and_handshakes_use_no_real_credentials() {
    let keyring = MemoryKeyring::default();
    let config = AiProviderConfig {
        kind: AiProviderKind::Acp,
        acp: Some(AcpConfig {
            selections: None,
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: "marxen-definitely-missing-binary".into(),
                args: vec![],
            }),
        }),
        openai: None,
        anthropic: None,
        connection_id: None,
    };
    let report = dry_run_report(&config, &keyring).unwrap();
    assert!(!report.ok);
    assert!(report.detail.contains("marxen-definitely-missing-binary"));

    let mut openai = openai_request("http://127.0.0.1:9");
    let report = dry_run_report(&openai.provider, &keyring).unwrap();
    assert!(!report.ok);
    keyring
        .set(AiProviderKind::OpenaiChatCompletions, "mock")
        .unwrap();
    let report = dry_run_report(&openai.provider, &keyring).unwrap();
    assert!(report.ok);
    openai.provider.kind = AiProviderKind::Anthropic;
    openai.provider.openai = None;
    openai.provider.anthropic = Some(AnthropicConfig {
        enabled: true,
        endpoint: "http://127.0.0.1:9".into(),
        model: "mock".into(),
    });
    // Anthropic slot is independent from the OpenAI slot.
    let report = dry_run_report(&openai.provider, &keyring).unwrap();
    assert!(!report.ok);

    let report = handshake_acp(&mock_agent_argv(&[])).unwrap();
    assert!(report.ok);
    // Transport failure surfaces as data (ok:false), not as Err.
    let report = handshake_acp(&AcpArgv {
        command: "marxen-definitely-missing-binary".into(),
        args: vec![],
    })
    .unwrap();
    assert!(!report.ok);
    assert!(
        report.detail.contains("marxen-definitely-missing-binary"),
        "{}",
        report.detail
    );
}

#[test]
/// Reject staging paths outside the owned root and copy identifiers absent from the registry.
fn staging_guard_and_manager_reject_outside_or_unknown_copies() {
    let root = tempfile::tempdir().unwrap();
    let inside = guard_isolation_path(root.path(), Path::new("copy_07")).unwrap();
    assert!(inside.starts_with(root.path()));
    assert!(guard_isolation_path(root.path(), Path::new("../live/doc.md")).is_err());
    assert!(guard_isolation_path(root.path(), root.path()).is_err());
    let manager = marxen_lib::open_isolation(root.path()).unwrap();
    assert!(manager.resolve(&IsolatedCopyId("copy_07".into())).is_err());
}

/// Execute one bounded mock ACP request and return its collected stream events for protocol assertions.
fn run_mock_prompt(
    extra: &[&str],
    flag_name: &str,
    timeout: Duration,
) -> (Vec<AiStreamEvent>, PathBuf) {
    let staging = fresh_dir(&format!("marxen-ai-test-staging-{flag_name}"));
    std::fs::create_dir_all(staging.join("copy_07")).expect("copy dir");
    let flags = fresh_dir(&format!("marxen-ai-test-flags-{flag_name}"));
    let argv = mock_agent_argv_with_flag_dir(extra, &flags);
    let request = acp_request(argv.clone());
    let staging_dir =
        guard_isolation_path(&staging, Path::new(&request.staging.copy_id.0)).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = acp_params(argv, &staging_dir, timeout);
    let mut events = Vec::new();
    let replies = registry.clone();
    run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            // Act as the chat user: answer surfaced permission requests with
            // the mock's deny option so runs settle without deadline waits.
            if let AiStreamEvent::Permission(permission) = &event {
                let _ = replies.reply_permission(
                    &permission.run_id,
                    &permission.request_id,
                    "mock_reject",
                );
            }
            events.push(event);
        },
    )
    .unwrap();
    (events, flags)
}

#[test]
/// Check that byte fragmentation and multiple messages in one read preserve the same ACP event sequence.
fn acp_fragmented_and_coalesced_writes_decode_identically() {
    for (extra, name) in [
        (vec!["--fragment"], "fragment"),
        (vec!["--coalesce"], "coalesce"),
    ] {
        let (events, _) = run_mock_prompt(&extra, name, Duration::from_secs(30));
        let (text, done, cancelled) = events_of(&events);
        assert_eq!(text, "こんにちは世界", "{name}");
        assert!(done && !cancelled, "{name}");
    }
}

#[test]
/// Require oversized ACP frames to fail within the configured input bound.
fn acp_rejects_oversized_lines() {
    let staging = fresh_dir("marxen-ai-test-staging-huge");
    std::fs::create_dir_all(staging.join("copy_07")).expect("copy dir");
    let request = acp_request(mock_agent_argv(&["--huge-line", "--no-permission"]));
    let staging_dir =
        guard_isolation_path(&staging, Path::new(&request.staging.copy_id.0)).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = acp_params(
        mock_agent_argv(&["--huge-line", "--no-permission"]),
        &staging_dir,
        Duration::from_secs(30),
    );
    let mut events = Vec::new();
    let outcome = run_acp_prompt(
        &params,
        &request,
        &run_id,
        &registry,
        &cancel,
        &mut |event| {
            events.push(event);
        },
    );
    // An oversized line must never surface as a successful proposal. The
    // fast path is an explicit stream error; under heavy parallel load the
    // per-run wall-clock watchdog may win first, which surfaces as an error
    // event plus Ok (the timeout/cancel settlement shape), never Done.
    let oversized_failed = matches!(outcome, Err(AiError::StreamFailed { .. }));
    let timed_out = outcome.is_ok()
        && events.iter().any(|event| {
            matches!(
                event,
                AiStreamEvent::Error(StreamError {
                    error: AiError::StreamFailed { .. },
                    ..
                })
            )
        })
        && !events
            .iter()
            .any(|event| matches!(event, AiStreamEvent::Done(_)));
    assert!(
        oversized_failed || timed_out,
        "oversized line must fail, got {outcome:?} with {events:?}"
    );
}

#[test]
/// Check graceful cancellation notification and child shutdown before escalating termination.
fn acp_graceful_cancel_uses_notification_and_clean_exit() {
    let staging = fresh_dir("marxen-ai-test-staging-graceful");
    std::fs::create_dir_all(staging.join("copy_07")).expect("copy dir");
    let flags = fresh_dir("marxen-ai-test-flags-graceful");
    let argv = mock_agent_argv_with_flag_dir(&["--cancel-graceful"], &flags);
    let request = acp_request(argv.clone());
    let staging_dir =
        guard_isolation_path(&staging, Path::new(&request.staging.copy_id.0)).unwrap();
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let params = acp_params(argv, &staging_dir, Duration::from_secs(30));
    let events: Arc<Mutex<Vec<AiStreamEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let driver_events = events.clone();
    let driver_registry = registry.clone();
    let driver_cancel = cancel.clone();
    let driver = std::thread::spawn(move || {
        let mut emit = |event: AiStreamEvent| {
            driver_events.lock().expect("events lock").push(event);
        };
        run_acp_prompt(
            &params,
            &request,
            &run_id,
            &driver_registry,
            &driver_cancel,
            &mut emit,
        )
    });
    for _ in 0..500 {
        let has_chunk = events
            .lock()
            .expect("events lock")
            .iter()
            .any(|event| matches!(event, AiStreamEvent::Chunk(_)));
        if has_chunk {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Flag only: no kill. The agent must answer session/cancel with the
    // `cancelled` stop reason and exit cleanly on stdin close.
    cancel.store(true, Ordering::SeqCst);
    driver.join().expect("driver").unwrap();
    let events = events.lock().expect("events lock").clone();
    let (text, done, cancelled) = events_of(&events);
    assert_eq!(text, "こんにちは");
    assert!(cancelled && !done);
    assert!(
        flags.join("clean_exit").is_file(),
        "agent must exit cleanly without being killed"
    );
    assert!(
        !flags.join("permission.json").exists(),
        "cancel path asks no permission"
    );
}

#[test]
/// Check initialization metadata, session creation and notifications through the mock ACP handshake.
fn acp_handshake_reports_version_session_and_notifications() {
    let staging = fresh_dir("marxen-ai-test-handshake");
    let info = agent_handshake(&mock_agent_argv(&[]), &staging, Duration::from_secs(30)).unwrap();
    assert_eq!(info.protocol_version, 1);
    assert_eq!(info.session_id, "mock-sess-1");
    assert_eq!(info.agent_name.as_deref(), Some("marxen-mock-acp"));
    // The mock sends available_commands_update before the session/new
    // response; id routing must have skipped it.
    assert!(info.notifications >= 1);
}

#[test]
/// Report an unavailable Codex executable as a discovery error without attempting authentication.
fn codex_adapter_without_install_is_a_clear_missing_binary() {
    if find_on_path("codex-acp").is_some() {
        println!("codex-acp is installed; skipping missing-binary expectation");
        return;
    }
    // No automatic downloads: the preset only names the adapter binary.
    let config = AiProviderConfig {
        kind: AiProviderKind::Acp,
        acp: Some(AcpConfig {
            selections: None,
            preset: AcpPreset::Codex,
            argv: None,
        }),
        openai: None,
        anthropic: None,
        connection_id: None,
    };
    let report = dry_run_report(&config, &MemoryKeyring::default()).unwrap();
    assert!(!report.ok);
    assert!(report.detail.contains("codex-acp"), "{}", report.detail);
    let argv = resolve_acp_argv(config.acp.as_ref().expect("acp")).unwrap();
    assert_eq!(argv.args.len(), 0);
    // handshake_acp reports transport failure as data, not as Err.
    let report = handshake_acp(&argv).unwrap();
    assert!(!report.ok);
    assert!(report.detail.contains("codex-acp"), "{}", report.detail);
}

#[test]
/// Opt in to a real OpenCode handshake only when its executable is explicitly configured; otherwise return.
fn real_opencode_handshake_when_binary_configured() {
    let bin = match std::env::var("MARXEN_REAL_ACP_BIN") {
        Ok(bin) => bin,
        Err(_) => {
            println!("MARXEN_REAL_ACP_BIN not set; skipping real-agent handshake");
            return;
        }
    };
    let args = std::env::var("MARXEN_REAL_ACP_ARGS").unwrap_or_default();
    let argv = AcpArgv {
        command: bin,
        args: if args.is_empty() {
            Vec::new()
        } else {
            args.split(',').map(str::to_owned).collect()
        },
    };
    validate_argv(&argv).unwrap();
    // Real-probe staging lives in this workspace (.local is gitignored),
    // never in the shared system temp dir.
    let probe_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(".local")
        .join("acp-probe");
    std::fs::create_dir_all(&probe_root).expect("probe dir");
    let staging = std::fs::canonicalize(&probe_root).expect("absolute probe dir");
    // initialize + session/new only. No prompt is ever sent: no cost, no auth.
    let info = agent_handshake(&argv, &staging, Duration::from_secs(60)).expect("real handshake");
    assert_eq!(info.protocol_version, 1);
    assert!(!info.session_id.is_empty());
    eprintln!(
        "real agent handshake: name={:?} session={} notifications={}",
        info.agent_name, info.session_id, info.notifications
    );
}

/// Read one HTTP request head plus its JSON body on loopback. Bodies carry the
/// explicit multi-turn history; the mock never touches real credentials.
fn serve_capture_body(stages: Vec<(u64, Vec<u8>)>) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let base = format!(
        "http://127.0.0.1:{}",
        listener.local_addr().expect("port").port()
    );
    let (seen_tx, seen_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let Some(mut stream) = accept_bounded(&listener) else {
            return;
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read_exact(&mut byte).is_err() || head.len() > 65536 {
                break;
            }
            head.extend_from_slice(&byte);
        }
        let head_text = String::from_utf8_lossy(&head).into_owned();
        let length = head_text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        });
        let mut body = vec![0u8; length.unwrap_or(0).min(1_048_576)];
        if !body.is_empty() {
            let _ = stream.read_exact(&mut body);
        }
        let _ = seen_tx.send(String::from_utf8_lossy(&body).into_owned());
        for (delay_ms, bytes) in stages {
            if delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
            if stream.write_all(&bytes).is_err() {
                return;
            }
        }
    });
    (base, seen_rx)
}

#[tokio::test]
/// Inspect the captured request body to require complete prior turns before the current user message.
async fn openai_two_turn_history_reaches_mock_server() {
    let body = include_str!("../../tests/fixtures/ai_sse_openai.txt").replace("\r\n", "\n");
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes();
    let (base, seen) = serve_capture_body(vec![(0, reply)]);
    let mut request = openai_request(&base);
    request.history = vec![
        ChatHistoryMessage {
            role: ChatRole::User,
            text: "1件目の質問".into(),
        },
        ChatHistoryMessage {
            role: ChatRole::Assistant,
            text: "1件目の回答".into(),
        },
    ];
    request.prompt = "2件目の質問".into();
    let run_id = AiRunId("run_history_2turn".into());
    let cancel = AtomicBool::new(false);
    let mut events = Vec::new();
    let client = http_client(Duration::from_secs(20)).unwrap();
    let target = http_target(&request.provider).unwrap();
    run_http_prompt(
        &client,
        &target,
        "mock-secret",
        &request,
        &run_id,
        &cancel,
        &mut |event| events.push(event),
    )
    .await
    .unwrap();
    let (text, done, cancelled) = events_of(&events);
    assert_eq!(text, "Hello, 世界！");
    assert!(done && !cancelled);
    let sent = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    let payload: serde_json::Value = serde_json::from_str(&sent).expect("request json");
    let messages = payload["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 3, "{sent}");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "1件目の質問");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "1件目の回答");
    assert!(messages[2]["content"]
        .as_str()
        .expect("content")
        .contains("2件目の質問"));
    assert!(
        !sent.contains("mock-secret"),
        "secrets stay in headers, never in bodies"
    );
}

#[test]
/// Reject excessive conversation history during validation before transport or staging can start.
fn oversized_history_is_rejected_before_any_side_effect() {
    let mut request = openai_request("http://127.0.0.1:9");
    request.history = vec![ChatHistoryMessage {
        role: ChatRole::User,
        text: "   ".into(),
    }];
    assert!(validate_prompt_request(&request).is_err());
    request.history = (0..MAX_HISTORY_MESSAGES + 1)
        .map(|i| ChatHistoryMessage {
            role: ChatRole::User,
            text: format!("q{i}"),
        })
        .collect();
    assert!(validate_prompt_request(&request).is_err());
}

/// Require chosen model and effort on the independent agent before prompting; reject ignored or unavailable choices.
#[test]
fn acp_model_choices_are_acknowledged_before_prompt() {
    for (extra, model, succeeds) in [
        (vec!["--models", "--no-permission"], "fixture-b", true),
        (
            vec!["--models", "--no-permission", "--ignore-model"],
            "fixture-b",
            false,
        ),
        (vec!["--models", "--no-permission"], "unavailable", false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let flags = tempfile::tempdir().unwrap();
        let argv = mock_agent_argv_with_flag_dir(&extra, flags.path());
        let probe = agent_handshake(&argv, dir.path(), Duration::from_secs(10)).unwrap();
        assert_eq!(probe.config_options[0].options[1].value, "fixture-b");
        let mut request = acp_request(argv.clone());
        request.provider.acp.as_mut().unwrap().selections = Some(vec![
            AcpSelection {
                id: "reasoning".into(),
                value: "xhigh".into(),
            },
            AcpSelection {
                id: "model".into(),
                value: model.into(),
            },
        ]);
        let registry = Arc::new(RunRegistry::new());
        let (run_id, cancel) = registry.register();
        let mut events = Vec::new();
        let outcome = run_acp_prompt(
            &acp_params(argv, dir.path(), Duration::from_secs(10)),
            &request,
            &run_id,
            &registry,
            &cancel,
            &mut |event| events.push(event),
        );
        if succeeds {
            outcome.unwrap();
            let record: serde_json::Value = serde_json::from_slice(
                &std::fs::read(flags.path().join("prompt-model.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(record["model"], "fixture-b");
            assert_eq!(record["effort"], "xhigh");
            assert!(events_of(&events).1);
            #[cfg(windows)]
            assert_eq!(
                std::fs::read_to_string(flags.path().join("console.txt")).unwrap(),
                "0"
            );
        } else {
            assert!(matches!(outcome, Err(AiError::InvalidConfig { .. })));
            assert!(!flags.path().join("prompt-model.json").exists());
        }
    }
}

#[tokio::test]
/// Use a configured Responses endpoint, preserve stateless history and reject incomplete streams.
async fn responses_streams_typed_events_and_requires_completion() {
    for (terminal, succeeds) in [
        ("response.completed", true),
        ("response.incomplete", false),
        ("response.failed", false),
        ("", false),
    ] {
        let body = format!("data: {{\"type\":\"response.output_text.delta\",\"delta\":\"日本語😀\"}}\n\ndata: {{\"type\":\"{terminal}\"}}\n\n");
        let mut server = serve(vec![(0, sse_reply(&body))]);
        let mut request = openai_request(&server.base);
        request.provider.kind = AiProviderKind::OpenaiResponses;
        request.provider.openai.as_mut().unwrap().endpoint = format!("{}/responses", server.base);
        request.history = vec![ChatHistoryMessage {
            role: ChatRole::Assistant,
            text: "previous".into(),
        }];
        let target = http_target(&request.provider).unwrap();
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let outcome = run_http_prompt(
            &http_client(Duration::from_secs(5)).unwrap(),
            &target,
            "fixture-key",
            &request,
            &AiRunId("responses".into()),
            &cancel,
            &mut |event| events.push(event),
        )
        .await;
        assert_eq!(outcome.is_ok(), succeeds);
        assert_eq!(events_of(&events).0, "日本語😀");
        assert_eq!(events_of(&events).1, succeeds);
        let sent = server.seen.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(sent.starts_with("POST /responses "));
        let payload: serde_json::Value =
            serde_json::from_str(sent.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(payload["input"][0]["content"], "previous");
        assert_eq!(payload["store"], false);
        assert!(payload.get("messages").is_none());
        server.done.take().unwrap().join().unwrap();
    }
}

#[test]
/// Bound initial ACP waits and accept the legacy model API without inventing model IDs.
fn acp_startup_timeout_and_legacy_models() {
    let dir = tempfile::tempdir().unwrap();
    let started = std::time::Instant::now();
    assert!(agent_handshake(
        &mock_agent_argv(&["--initialize-delay-ms", "5000"]),
        dir.path(),
        Duration::from_millis(100)
    )
    .is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    let flags = tempfile::tempdir().unwrap();
    let argv = mock_agent_argv_with_flag_dir(&["--legacy-models", "--no-permission"], flags.path());
    let probe = agent_handshake(&argv, dir.path(), Duration::from_secs(5)).unwrap();
    assert_eq!(probe.config_options[0].options[1].value, "fixture-b");
    let mut request = acp_request(argv.clone());
    request.provider.acp.as_mut().unwrap().selections = Some(vec![AcpSelection {
        id: "model".into(),
        value: "fixture-b".into(),
    }]);
    let registry = Arc::new(RunRegistry::new());
    let (run, cancel) = registry.register();
    let mut events = Vec::new();
    run_acp_prompt(
        &acp_params(argv, dir.path(), Duration::from_secs(5)),
        &request,
        &run,
        &registry,
        &cancel,
        &mut |event| events.push(event),
    )
    .unwrap();
    assert!(events_of(&events).1);
    let record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(flags.path().join("prompt-model.json")).unwrap())
            .unwrap();
    assert_eq!(record["model"], "fixture-b");
}

/// Full URLs and API roots retain their query data when selecting a protocol endpoint.
#[test]
fn configured_http_endpoints_preserve_query_parameters() {
    use marxen_lib::domain::ai::http_endpoints;
    for suffix in ["/chat/completions", "/responses", "/messages"] {
        let base = "https://example.com/custom/v1?api-version=fixture&tenant=work";
        let full = format!("https://example.com/custom/v1{suffix}?api-version=fixture&tenant=work");
        assert_eq!(http_endpoints(base, suffix), (base.into(), full.clone()));
        assert_eq!(http_endpoints(&full, suffix), (base.into(), full));
    }
}
