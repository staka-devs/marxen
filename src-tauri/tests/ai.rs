//! Issue #7 integration tests. HTTP backends run against a loopback mock
//! server; ACP runs against the mock-acp-agent subprocess. No real
//! credentials, no network beyond 127.0.0.1, no Claude Code anywhere.
use marxen_lib::ai::*;
use marxen_lib::ai_contracts::*;
use marxen_lib::contracts::{DocumentId, Revision, Utf16Offset, Utf16Range};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn context() -> PromptContext {
    PromptContext {
        document_id: DocumentId("doc_07".into()),
        revision: Revision(3),
        ranges: vec![Utf16Range {
            start: Utf16Offset(0),
            end: Utf16Offset(5),
        }],
        text: "a😀日本語".into(),
    }
}

fn openai_request(base: &str) -> AiPromptRequest {
    AiPromptRequest {
        provider: AiProviderConfig {
            kind: AiProviderKind::OpenaiCompatible,
            acp: None,
            openai: Some(OpenAiConfig {
                endpoint: base.into(),
                model: "mock-model".into(),
            }),
            anthropic: None,
        },
        mode: PromptMode::Rewrite,
        prompt: "書き換えてください".into(),
        contexts: vec![context()],
        staging: StagingTarget {
            copy_id: IsolatedCopyId("copy_07".into()),
        },
        session_id: None,
    }
}

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
    };
    request
}

struct MockHttp {
    base: String,
    seen: std::sync::mpsc::Receiver<String>,
    done: Option<std::thread::JoinHandle<()>>,
}

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
    }
    head_text
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
        let (mut stream, _) = listener.accept().expect("accept");
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

fn sse_reply(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

fn status_reply(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

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
async fn http_cancel_midstream_stops_without_done() {
    let body = include_str!("../../tests/fixtures/ai_sse_openai.txt").replace("\r\n", "\n");
    // Deliver the first event, then stall so the client must cancel mid-stream.
    let split = body.find("\n\n").expect("sse events") + 2;
    let (first, rest) = body.split_at(split);
    let mut server = serve(vec![
        (0, sse_reply_chunked(first)),
        (10_000, rest.as_bytes().to_vec()),
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
    // Wait for the first chunk, then cancel.
    for _ in 0..500 {
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
    cancel.store(true, Ordering::SeqCst);
    driver.await.expect("driver").unwrap();
    let events = events.lock().expect("events lock").clone();
    let (_, done, cancelled) = events_of(&events);
    assert!(cancelled && !done);
    server.done.take().expect("join").join().expect("server");
}

fn sse_reply_chunked(first: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
        first
    )
    .into_bytes()
}

#[tokio::test]
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

struct FixedResolver {
    root: PathBuf,
}

impl StagingResolver for FixedResolver {
    fn root(&self) -> &Path {
        &self.root
    }

    fn resolve(&self, copy_id: &IsolatedCopyId) -> Result<PathBuf, AiError> {
        let candidate = PathBuf::from(&copy_id.0);
        guard_staging_path(&self.root, &candidate)
    }
}

fn acp_request(argv: AcpArgv) -> AiPromptRequest {
    AiPromptRequest {
        provider: AiProviderConfig {
            kind: AiProviderKind::Acp,
            acp: Some(AcpConfig {
                preset: AcpPreset::Custom,
                argv: Some(argv),
            }),
            openai: None,
            anthropic: None,
        },
        mode: PromptMode::Workspace,
        prompt: "修正案をください".into(),
        contexts: vec![context()],
        staging: StagingTarget {
            copy_id: IsolatedCopyId("copy_07".into()),
        },
        session_id: None,
    }
}

fn mock_agent_argv(extra: &[&str]) -> AcpArgv {
    let exe = env!("CARGO_BIN_EXE_mock-acp-agent");
    AcpArgv {
        command: exe.into(),
        args: extra.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

fn acp_params(argv: AcpArgv, dir: &Path, timeout: Duration) -> AcpRunParams {
    AcpRunParams {
        argv,
        staging_dir: dir.to_owned(),
        timeout,
    }
}

#[test]
fn acp_full_run_streams_chunks_inside_staging_copy() {
    let staging = std::env::temp_dir().join("marxen-ai-test-staging");
    std::fs::create_dir_all(&staging).expect("staging dir");
    std::fs::create_dir_all(staging.join("copy_07")).expect("copy dir");
    let resolver = FixedResolver {
        root: staging.clone(),
    };
    let request = acp_request(mock_agent_argv(&[]));
    let staging_dir = resolver.resolve(&request.staging.copy_id).unwrap();
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
    let (text, done, cancelled) = events_of(&events);
    assert_eq!(text, "こんにちは世界");
    assert!(done && !cancelled);
}

#[test]
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
fn acp_cancel_midrun_kills_the_agent() {
    let staging = std::env::temp_dir().join("marxen-ai-test-cancel");
    std::fs::create_dir_all(&staging).expect("staging dir");
    let request = acp_request(mock_agent_argv(&["--respond-after-ms=200"]));
    let registry = Arc::new(RunRegistry::new());
    let (run_id, cancel) = registry.register();
    let cancel_id = run_id.clone();
    let params = acp_params(
        mock_agent_argv(&["--respond-after-ms=200"]),
        &staging,
        Duration::from_secs(30),
    );
    let events: Arc<Mutex<Vec<AiStreamEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let driver_events = events.clone();
    let driver_registry = registry.clone();
    let driver = std::thread::spawn(move || {
        let mut emit = |event: AiStreamEvent| {
            driver_events.lock().expect("events lock").push(event);
        };
        run_acp_prompt(
            &params,
            &request,
            &run_id,
            &driver_registry,
            &cancel,
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
    assert!(registry.cancel(&cancel_id));
    driver.join().expect("driver").unwrap();
    let events = events.lock().expect("events lock").clone();
    let (_, done, cancelled) = events_of(&events);
    assert!(cancelled && !done);
}

#[test]
fn dry_runs_and_handshakes_use_no_real_credentials() {
    let keyring = MemoryKeyring::default();
    let config = AiProviderConfig {
        kind: AiProviderKind::Acp,
        acp: Some(AcpConfig {
            preset: AcpPreset::Custom,
            argv: Some(AcpArgv {
                command: "marxen-definitely-missing-binary".into(),
                args: vec![],
            }),
        }),
        openai: None,
        anthropic: None,
    };
    let report = dry_run_report(&config, &keyring).unwrap();
    assert!(!report.ok);
    assert!(report.detail.contains("marxen-definitely-missing-binary"));

    let mut openai = openai_request("http://127.0.0.1:9");
    let report = dry_run_report(&openai.provider, &keyring).unwrap();
    assert!(!report.ok);
    keyring
        .set(AiProviderKind::OpenaiCompatible, "mock")
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
    assert!(handshake_acp(&AcpArgv {
        command: "marxen-definitely-missing-binary".into(),
        args: vec![],
    })
    .is_err());
}

#[test]
fn staging_resolver_interface_rejects_outside_copies() {
    let root = std::env::temp_dir().join("marxen-ai-test-resolver");
    std::fs::create_dir_all(&root).expect("root");
    let resolver = FixedResolver { root: root.clone() };
    let inside = resolver.resolve(&IsolatedCopyId("copy_07".into())).unwrap();
    assert!(inside.starts_with(&root));
    assert!(RejectingResolver
        .resolve(&IsolatedCopyId("copy_07".into()))
        .is_err());
}
