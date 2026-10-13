//! In-memory latest-usage registry for the ACP usage popup (Issue #59).
//!
//! The registry keeps the latest observations per run, session, and source within
//! a fixed capacity. It never accumulates token counters, never derives
//! quota or cost figures, and never touches the network or the filesystem.
use crate::contracts::ai::{AcpUsageSource, AiRunId, ReportedUsage};
use std::collections::HashMap;
use std::sync::Mutex;

/// Maximum retained usage reports. Oldest reports by receipt time are evicted
/// first, so popup refresh stays bounded without a history database.
pub const MAX_USAGE_ENTRIES: usize = 32;

/// Thread-safe latest observations per run, wire session, and report source.
/// Context/session-cost updates and prompt token reports retain their separate scopes.
pub struct UsageRegistry {
    entries: Mutex<HashMap<(String, String, AcpUsageSource), ReportedUsage>>,
}

impl UsageRegistry {
    /// Create an empty usage registry with no recorded reports.
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Replace the latest observation for the same run, session, and source without
    /// summing counters or erasing the other source. Evict oldest reports by receipt
    /// time when the bounded capacity would be exceeded.
    pub fn record(&self, usage: ReportedUsage) {
        let mut entries = self.entries.lock().expect("usage registry lock");
        let key = (
            usage.run_id.0.clone(),
            usage.session_id.0.clone(),
            usage.source,
        );
        entries.insert(key, usage);
        while entries.len() > MAX_USAGE_ENTRIES {
            let oldest = entries
                .iter()
                .min_by_key(|(_, usage)| usage.received_ms)
                .map(|(key, _)| key.clone());
            match oldest {
                Some(key) => {
                    entries.remove(&key);
                }
                None => break,
            }
        }
    }

    /// Drop any stored report for the given run so a new run starts with a
    /// fresh scope instead of inheriting a previous report.
    pub fn reset_for_run(&self, run_id: &AiRunId) {
        self.entries
            .lock()
            .expect("usage registry lock")
            .retain(|(run, _, _), _| run != &run_id.0);
    }

    /// Clone the newest observation for one run without combining report scopes.
    pub fn get(&self, run_id: &AiRunId) -> Option<ReportedUsage> {
        self.entries
            .lock()
            .expect("usage registry lock")
            .values()
            .filter(|usage| usage.run_id == *run_id)
            .max_by_key(|usage| usage.received_ms)
            .cloned()
    }

    /// Clone all retained reports ordered by receipt time for popup refresh.
    /// This is read-only: it never sends a prompt or starts inference.
    pub fn snapshot(&self) -> Vec<ReportedUsage> {
        let mut usages: Vec<ReportedUsage> = self
            .entries
            .lock()
            .expect("usage registry lock")
            .values()
            .cloned()
            .collect();
        usages.sort_by_key(|usage| usage.received_ms);
        usages
    }
}

impl Default for UsageRegistry {
    /// Create the default empty usage registry.
    fn default() -> Self {
        Self::new()
    }
}
