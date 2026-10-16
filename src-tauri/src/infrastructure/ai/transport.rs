//! Production AI transport and runtime task adapters.
use crate::application::ai::runs::RunRegistry;
use crate::application::ai::transport::*;
use crate::contracts::ai::*;
use crate::domain::ai::*;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;
#[derive(Default)]
pub struct NativeAiTransport {
    pub accounts: Option<Arc<crate::application::provider_accounts::ProviderAccountService>>,
}

impl NativeAiTransport {
    /// Resolve only known ACP account adapters, preserving custom commands' inherited login.
    fn environment(
        &self,
        argv: &AcpArgv,
    ) -> Result<crate::application::provider_accounts::AccountLaunchEnvironment, AiError> {
        use crate::contracts::provider_accounts::{AccountHost, AccountProvider};
        let command = argv
            .command
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let command = command
            .trim_end_matches(".exe")
            .trim_end_matches(".cmd")
            .trim_end_matches(".ps1");
        let provider = match command {
            "codex-acp" => AccountProvider::Codex,
            "claude-agent-acp" => AccountProvider::Claude,
            "opencode" => AccountProvider::Opencode,
            _ => return Ok(Default::default()),
        };
        match &self.accounts {
            Some(accounts) => accounts
                .launch_environment(provider, &AccountHost::Local)
                .map_err(|error| AiError::InvalidConfig {
                    detail: format!("選択したアカウントを使用できません: {error:?}"),
                }),
            None => Ok(Default::default()),
        }
    }
}
impl AiTransport for NativeAiTransport {
    /// Resolve configured argv to a directly spawnable program without a shell.
    fn resolve_launch(&self, argv: &AcpArgv) -> Result<ResolvedAcpLaunch, AiError> {
        super::acp::resolve_acp_launch(argv)
    }
    /// Run the explicit ACP readiness probe through the native subprocess adapter.
    fn handshake(&self, argv: &AcpArgv) -> Result<AiTestResult, AiError> {
        super::acp::handshake_acp_with_environment(argv, &self.environment(argv)?)
    }
    /// Dispatch a connection probe using the validated API root and selected provider credential.
    fn test_http<'a>(
        &'a self,
        target: &'a HttpTarget,
        secret: &'a str,
    ) -> AiFuture<'a, Result<AiTestResult, AiError>> {
        Box::pin(async move {
            let client = super::http::http_client(HTTP_TEST_TIMEOUT)?;
            match target.backend {
                HttpBackend::OpenAi | HttpBackend::OpenAiResponses => {
                    super::http::test_openai_live(&client, &target.base, secret).await
                }
                HttpBackend::Anthropic => {
                    super::http::test_anthropic_live(&client, &target.base, &target.model, secret)
                        .await
                }
            }
        })
    }
    /// Drive a scoped native ACP process with the owning registry's cancellation and settlement state.
    fn run_acp(
        &self,
        params: &AcpRunParams,
        request: &AiPromptRequest,
        run_id: &AiRunId,
        registry: &Arc<RunRegistry>,
        cancel: &AtomicBool,
        emit: &mut (dyn FnMut(AiStreamEvent) + Send),
    ) -> Result<(), AiError> {
        super::acp::run_acp_prompt_with_environment(
            params,
            request,
            run_id,
            registry,
            cancel,
            &self.environment(&params.argv)?,
            emit,
        )
    }
    /// Drive a scoped HTTP stream with a bounded client and the owning cancellation flag.
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
    /// Run a blocking ACP driver on a dedicated native thread.
    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send>) {
        std::thread::spawn(task);
    }
    /// Run the owned HTTP future on the desktop runtime.
    fn spawn_async(&self, task: AiFuture<'static, ()>) {
        tauri::async_runtime::spawn(task);
    }
}
