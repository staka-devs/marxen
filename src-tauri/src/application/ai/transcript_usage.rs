//! Read locally measured transcript totals without starting an agent or inference.
use crate::application::ports::Clock;
use crate::contracts::ai::{TranscriptAgentUsage, TranscriptUsageReport};
use std::sync::Arc;

/// Read measured transcript totals for every known local store.
pub trait TranscriptUsageReader: Send + Sync {
    /// Scan read-only local transcript stores without network or inference.
    fn read_agents(&self) -> Vec<TranscriptAgentUsage>;
}

/// Local transcript usage is separate from wire observations and account quotas.
pub struct TranscriptUsageService {
    /// Injected native transcript reader owned by infrastructure.
    pub reader: Arc<dyn TranscriptUsageReader>,
    /// Clock for stamping the finished scan.
    pub clock: Arc<dyn Clock>,
}

impl TranscriptUsageService {
    /// Scan the user's local transcript stores and stamp receipt time.
    /// The scan is read-only and bounded; failures surface per agent as
    /// reasons, never as transport errors.
    pub fn read(&self) -> TranscriptUsageReport {
        TranscriptUsageReport {
            agents: self.reader.read_agents(),
            received_ms: (self.clock.nanos() / 1_000_000).min(u128::from(u64::MAX)) as u64,
        }
    }
}
