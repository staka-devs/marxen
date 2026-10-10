use marxen_lib::application::ai::{
    credentials::AgentKeyring,
    runs::RunRegistry,
    service::AiService,
    transport::{AiFuture, TaskSpawner},
};
use marxen_lib::contracts::ai::*;
use marxen_lib::infrastructure::ai::{credentials::MemoryKeyring, transport::NativeAiTransport};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct ProbeOnlySpawner;
impl TaskSpawner for ProbeOnlySpawner {
    /// Reject unexpected agent launches while testing connection-probe orchestration.
    fn spawn_blocking(&self, _task: Box<dyn FnOnce() + Send>) {
        panic!("a connection probe must not launch an agent run");
    }
    /// Reject unexpected stream launches while testing connection-probe orchestration.
    fn spawn_async(&self, _task: AiFuture<'static, ()>) {
        panic!("a connection probe must not launch a prompt stream");
    }
}

/// Build the production service/transport boundary with a disposable in-memory credential.
fn service(kind: AiProviderKind) -> AiService {
    let keyring = Arc::new(MemoryKeyring::default());
    keyring.set(kind, "disposable-test-key").unwrap();
    AiService {
        keyring,
        transport: Arc::new(NativeAiTransport),
        spawner: Arc::new(ProbeOnlySpawner),
        runs: Arc::new(RunRegistry::new()),
    }
}

/// Build an explicit loopback provider configuration without a real account or remote endpoint.
fn config(kind: AiProviderKind, endpoint: String) -> AiProviderConfig {
    AiProviderConfig {
        kind,
        acp: None,
        openai: (kind == AiProviderKind::OpenaiCompatible).then(|| OpenAiConfig {
            endpoint: endpoint.clone(),
            model: "fixture-model".into(),
        }),
        anthropic: (kind == AiProviderKind::Anthropic).then(|| AnthropicConfig {
            enabled: true,
            endpoint,
            model: "fixture-model".into(),
        }),
    }
}

/// Capture one bounded loopback HTTP request through the real service and native transport.
async fn probe_request(kind: AiProviderKind) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1/", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "probe did not connect");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("loopback accept failed: {error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 1024];
        loop {
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0, "request ended before headers");
            bytes.extend_from_slice(&chunk[..count]);
            assert!(bytes.len() <= 16_384, "fixture request exceeded its bound");
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .unwrap();
        String::from_utf8(bytes).unwrap()
    });
    assert!(
        service(kind)
            .test_connection(config(kind, endpoint), true)
            .await
            .unwrap()
            .ok
    );
    server.join().unwrap()
}

/// Prevent the prompt URL from being reused as an OpenAI connection-probe API root.
#[tokio::test]
async fn openai_service_probes_models_at_the_validated_api_root() {
    let request = probe_request(AiProviderKind::OpenaiCompatible).await;
    assert!(
        request.starts_with("GET /v1/models HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer disposable-test-key"));
}

/// Prevent a duplicated messages suffix when probing an opted-in Anthropic API root.
#[tokio::test]
async fn anthropic_service_probes_messages_once_at_the_validated_api_root() {
    let request = probe_request(AiProviderKind::Anthropic).await;
    assert!(
        request.starts_with("POST /v1/messages HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(request
        .to_ascii_lowercase()
        .contains("x-api-key: disposable-test-key"));
    let body: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["model"], "fixture-model");
    assert_eq!(body["max_tokens"], 1);
}

/// Verify local readiness neither connects to the endpoint nor returns the dummy secret.
#[tokio::test]
async fn local_readiness_keeps_http_and_credentials_inside_the_service() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let kind = AiProviderKind::OpenaiCompatible;
    let result = service(kind)
        .test_connection(
            config(
                kind,
                format!("http://{}/v1", listener.local_addr().unwrap()),
            ),
            false,
        )
        .await
        .unwrap();
    assert!(result.ok);
    assert!(!result.detail.contains("disposable-test-key"));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(SECRET_SERVICE, "dev.staka.marxen");
}
