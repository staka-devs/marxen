//! Read account limits through an injected provider adapter without authorizing inference.
use crate::application::ports::Clock;
use crate::contracts::ai::{AiError, CodexAccountUsage, CodexUsageBucket};
use std::sync::Arc;

/// Read the installed Codex account's reported limit buckets, never its credentials.
pub trait AccountUsageReader: Send + Sync {
    /// Read official account metadata without creating a conversation or model turn.
    fn read_codex(&self) -> Result<Vec<CodexUsageBucket>, AiError>;
}

/// Account-level usage is separate from context and token observations for prompt runs.
pub struct AccountUsageService {
    pub reader: Arc<dyn AccountUsageReader>,
    pub clock: Arc<dyn Clock>,
}

impl AccountUsageService {
    /// Read the provider's limits and stamp receipt time without storing account secrets.
    pub fn read_codex(&self) -> Result<CodexAccountUsage, AiError> {
        let buckets = self.reader.read_codex()?;
        Ok(CodexAccountUsage {
            buckets,
            received_ms: (self.clock.nanos() / 1_000_000).min(u128::from(u64::MAX)) as u64,
        })
    }
}
