//! HTTP clients and streamed AI protocol adapters.
use crate::application::ai::credentials::*;
use crate::application::ai::runs::*;
use crate::contracts::ai::*;
use crate::contracts::Utf16Range;
use crate::domain::ai::*;
use crate::domain::validation::validate_document_id;
use futures::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
pub fn http_client(timeout: Duration) -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| AiError::ConnectionFailed {
            detail: format!("HTTP クライアントを作れません: {error}"),
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
    // A silent server must never hold a run until the client timeout: race
    // the send against the shared cancel flag so cancellation lands while
    // response headers are still awaited.
    let send_future = builder.send();
    tokio::pin!(send_future);
    let response = loop {
        tokio::select! {
            result = &mut send_future => break result.map_err(|error| {
                if error.is_timeout() {
                    AiError::StreamFailed {
                        detail: "時間内に応答がありませんでした".into(),
                    }
                } else {
                    AiError::ConnectionFailed {
                        detail: format!("接続できません: {error}"),
                    }
                }
            })?,
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if cancel.load(Ordering::SeqCst) {
                    emit(AiStreamEvent::Cancelled(StreamCancelled {
                        run_id: run_id.clone(),
                    }));
                    return Ok(());
                }
            }
        }
    };
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
    loop {
        // Stall-safe read: a server that goes quiet after headers must not
        // hold the run until the client timeout when cancellation arrives.
        let next = tokio::select! {
            next = stream.next() => next,
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if cancel.load(Ordering::SeqCst) {
                    emit(AiStreamEvent::Cancelled(StreamCancelled {
                        run_id: run_id.clone(),
                    }));
                    return Ok(());
                }
                continue;
            }
        };
        let Some(chunk) = next else { break };
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
