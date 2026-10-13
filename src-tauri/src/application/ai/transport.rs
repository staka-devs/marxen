//! Used transport and task-launch ports; protocol clients stay in native adapters.
use super::runs::RunRegistry;
use crate::contracts::ai::*;
use crate::domain::ai::HttpTarget;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;
pub type AiFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub struct AcpRunParams {
    pub argv: AcpArgv,
    pub staging_dir: PathBuf,
    pub timeout: Duration,
}
pub trait AiTransport: Send + Sync {
    /// Find a configured executable without spawning an agent or reading credentials.
    fn find_binary(&self, command: &str) -> Option<PathBuf>;
    /// Probe an explicitly requested ACP handshake in a temporary native staging directory.
    fn handshake(&self, argv: &AcpArgv) -> Result<AiTestResult, AiError>;
    /// Perform the explicitly requested HTTP probe using an already resolved credential.
    fn test_http<'a>(
        &'a self,
        target: &'a HttpTarget,
        secret: &'a str,
    ) -> AiFuture<'a, Result<AiTestResult, AiError>>;
    /// Run a scoped ACP prompt, leaving cancellation and settlement registry semantics intact.
    fn run_acp(
        &self,
        params: &AcpRunParams,
        request: &AiPromptRequest,
        run_id: &AiRunId,
        registry: &Arc<RunRegistry>,
        cancel: &AtomicBool,
        emit: &mut (dyn FnMut(AiStreamEvent) + Send),
    ) -> Result<(), AiError>;
    /// Stream an HTTP proposal for previously authorized context without mutating live documents.
    #[allow(clippy::too_many_arguments)]
    fn run_http<'a>(
        &'a self,
        target: &'a HttpTarget,
        secret: &'a str,
        request: &'a AiPromptRequest,
        run_id: &'a AiRunId,
        cancel: &'a AtomicBool,
        emit: &'a mut (dyn FnMut(AiStreamEvent) + Send),
    ) -> AiFuture<'a, Result<(), AiError>>;
}
pub trait TaskSpawner: Send + Sync {
    /// Launch a blocking ACP driver owned by the application lifecycle.
    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send>);
    /// Launch an asynchronous HTTP driver owned by the application lifecycle.
    fn spawn_async(&self, task: AiFuture<'static, ()>);
}
