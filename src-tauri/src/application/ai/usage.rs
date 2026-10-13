//! In-memory latest-usage registry for the ACP usage popup (Issue #59).
//!
//! The registry keeps only the latest reported usage per run, bounded to a
//! small fixed capacity. It never accumulates token counters, never derives
//! quota or cost figures, and never touches the network or the filesystem.
use crate::contracts::ai::{AiRunId, ReportedUsage};
use std::collections::HashMap;
use std::sync::Mutex;

/// Maximum retained usage reports. Oldest reports by receipt time are evicted
/// first, so popup refresh stays bounded without a history database.
pub const MAX_USAGE_ENTRIES: usize = 32;

/// Thread-safe store of the latest reported usage per run.
/// Keys are run identifiers; each value already carries its public
/// provider/run/session triple plus source, scope, and receipt time.
pub struct UsageRegistry {
    entries: Mutex<HashMap<String, ReportedUsage>>,
}

impl UsageRegistry {
    /// Create an empty usage registry with no recorded reports.
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Record the latest report for its run, replacing any previous report for
    /// the same run without summing counters. Evict oldest reports by receipt
    /// time when the bounded capacity would be exceeded.
    pub fn record(&self, usage: ReportedUsage) {
        let mut entries = self.entries.lock().expect("usage registry lock");
        entries.insert(usage.run_id.0.clone(), usage);
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
            .remove(&run_id.0);
    }

    /// Clone the latest report for one run, if any.
    pub fn get(&self, run_id: &AiRunId) -> Option<ReportedUsage> {
        self.entries
            .lock()
            .expect("usage registry lock")
            .get(&run_id.0)
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
