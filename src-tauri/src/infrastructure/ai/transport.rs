//! Production AI transport and runtime task adapters.
use crate::application::ai::runs::RunRegistry;
use crate::application::ai::transport::*;
use crate::contracts::ai::*;
use crate::domain::ai::*;
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;
pub struct NativeAiTransport;
impl AiTransport for NativeAiTransport {
    fn find_binary(&self, command: &str) -> Option<PathBuf> {
        super::acp::find_on_path(command)
    }
    fn handshake(&self, argv: &AcpArgv) -> Result<AiTestResult, AiError> {
        super::acp::handshake_acp(argv)
    }
    fn test_http<'a>(
        &'a self,
        target: &'a HttpTarget,
        secret: &'a str,
    ) -> AiFuture<'a, Result<AiTestResult, AiError>> {
        Box::pin(async move {
            let client = super::http::http_client(HTTP_TEST_TIMEOUT)?;
            match target.backend {
                HttpBackend::OpenAi => {
                    super::http::test_openai_live(&client, &target.base, secret).await
                }
                HttpBackend::Anthropic => {
                    super::http::test_anthropic_live(&client, &target.base, &target.model, secret)
                        .await
                }
            }
        })
    }
    fn run_acp(
        &self,
        params: &AcpRunParams,
        request: &AiPromptRequest,
        run_id: &AiRunId,
        registry: &Arc<RunRegistry>,
        cancel: &AtomicBool,
        emit: &mut (dyn FnMut(AiStreamEvent) + Send),
    ) -> Result<(), AiError> {
        super::acp::run_acp_prompt(params, request, run_id, registry, cancel, emit)
    }
    fn run_http<'a>(
        &'a self,
        target: &'a HttpTarget,
        secret: &'a str,
        request: &'a AiPromptRequest,
        run_id: &'a AiRunId,
        cancel: &'a AtomicBool,
        emit: &'a mut (dyn FnMut(AiStreamEvent) + Send),
    ) -> AiFuture<'a, Result<(), AiError>> {
        Box::pin(async move {
            let client = super::http::http_client(Duration::from_secs(600))?;
            super::http::run_http_prompt(&client, target, secret, request, run_id, cancel, emit)
                .await
        })
    }
}
#[cfg(feature = "desktop")]
pub struct NativeTaskSpawner;
#[cfg(feature = "desktop")]
impl TaskSpawner for NativeTaskSpawner {
    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send>) {
        std::thread::spawn(task);
    }
    fn spawn_async(&self, task: AiFuture<'static, ()>) {
        tauri::async_runtime::spawn(task);
    }
}
