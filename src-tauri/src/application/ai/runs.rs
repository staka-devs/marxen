//! Run identity, cancellation, proposal assembly, and terminal settlement.
use super::credentials::AgentKeyring;
use crate::contracts::ai::*;
use crate::domain::ai::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
pub struct MockScript {
    pub chunks: Vec<String>,
    pub fail: Option<AiError>,
}

pub struct ProposalAssembler {
    text: String,
}

impl ProposalAssembler {
    /// Start an empty proposal accumulator.
    pub fn new() -> Self {
        Self {
            text: String::new(),
        }
    }

    /// Append one streamed text chunk in arrival order.
    pub fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
    }

    /// Build a scoped proposal from the accumulated text and captured request.
    pub fn finish(self, request: &AiPromptRequest) -> ProposalText {
        proposal_from_text(self.text, request)
    }
}

impl Default for ProposalAssembler {
    /// Create the default empty proposal accumulator.
    fn default() -> Self {
        Self::new()
    }
}

/// Exercise streamed proposal assembly with deterministic chunks, failures and cancellation.
pub fn run_mock_script(
    request: &AiPromptRequest,
    run_id: &AiRunId,
    script: &MockScript,
    cancel: &AtomicBool,
    emit: &mut (dyn FnMut(AiStreamEvent) + Send),
) -> String {
    let composed = compose_user_message_with_history(
        request.mode,
        &request.prompt,
        &request.contexts,
        &request.history,
    );
    emit(AiStreamEvent::Started(StreamStarted {
        run_id: run_id.clone(),
    }));
    if cancel.load(Ordering::SeqCst) {
        emit(AiStreamEvent::Cancelled(StreamCancelled {
            run_id: run_id.clone(),
        }));
        return composed;
    }
    if let Some(error) = &script.fail {
        emit(AiStreamEvent::Error(StreamError {
            run_id: Some(run_id.clone()),
            error: error.clone(),
        }));
        return composed;
    }
    let mut assembler = ProposalAssembler::new();
    for chunk in &script.chunks {
        if cancel.load(Ordering::SeqCst) {
            emit(AiStreamEvent::Cancelled(StreamCancelled {
                run_id: run_id.clone(),
            }));
            return composed;
        }
        assembler.push(chunk);
        emit(AiStreamEvent::Chunk(StreamChunk {
            run_id: run_id.clone(),
            text: chunk.clone(),
        }));
    }
    emit(AiStreamEvent::Done(StreamDone {
        run_id: run_id.clone(),
        proposal: assembler.finish(request),
        sent: summarize_contexts(request),
    }));
    composed
}

// ---- Run registry (cancel routing shared by commands and tests) ----

pub trait ManagedProcess: Send {
    /// Terminate and reap a running native process before its scope pin is released.
    fn terminate(&mut self);
    /// Wait for a graceful exit, then terminate and reap after the bounded grace.
    fn finish(&mut self, grace: Duration);
}

pub struct RunEntry {
    pub cancel: Arc<AtomicBool>,
    pub timed_out: Arc<AtomicBool>,
    pub child: Mutex<Option<Box<dyn ManagedProcess>>>,
}

pub struct RunRegistry {
    next: AtomicU64,
    entries: Mutex<HashMap<String, RunEntry>>,
}

impl RunRegistry {
    /// Create an empty run registry with monotonic run identifiers.
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Allocate a run identifier and register its shared cancellation flag.
    pub fn register(&self) -> (AiRunId, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let run_id = AiRunId(format!("run_{id}"));
        let cancel = Arc::new(AtomicBool::new(false));
        self.entries.lock().expect("run registry lock").insert(
            run_id.0.clone(),
            RunEntry {
                cancel: cancel.clone(),
                timed_out: Arc::new(AtomicBool::new(false)),
                child: Mutex::new(None),
            },
        );
        (run_id, cancel)
    }

    /// Apply an operation only while the requested run remains registered.
    fn with_entry(&self, id: &AiRunId, f: impl FnOnce(&RunEntry)) -> bool {
        match self.entries.lock().expect("run registry lock").get(&id.0) {
            Some(entry) => {
                f(entry);
                true
            }
            None => false,
        }
    }

    /// Clone the active run cancellation flag, returning None after removal.
    pub fn cancel_flag(&self, id: &AiRunId) -> Option<Arc<AtomicBool>> {
        self.entries
            .lock()
            .expect("run registry lock")
            .get(&id.0)
            .map(|entry| entry.cancel.clone())
    }

    /// Signal cancel and kill a live agent process. Returns false when the
    /// run already finished.
    pub fn cancel(&self, id: &AiRunId) -> bool {
        self.with_entry(id, |entry| {
            entry.cancel.store(true, Ordering::SeqCst);
            if let Some(mut child) = entry.child.lock().expect("child lock").take() {
                child.terminate();
            }
        })
    }

    /// Mark a timeout, signal cancellation and terminate the registered child.
    pub fn timeout_cancel(&self, id: &AiRunId) -> bool {
        self.with_entry(id, |entry| {
            entry.timed_out.store(true, Ordering::SeqCst);
            entry.cancel.store(true, Ordering::SeqCst);
            if let Some(mut child) = entry.child.lock().expect("child lock").take() {
                child.terminate();
            }
        })
    }

    /// Distinguish deadline cancellation from the caller's explicit cancellation.
    pub fn was_timed_out(&self, id: &AiRunId) -> bool {
        self.entries
            .lock()
            .expect("run registry lock")
            .get(&id.0)
            .map(|entry| entry.timed_out.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    /// Attach the spawned process to the active run for cancellation and settlement.
    pub fn set_child(&self, id: &AiRunId, child: Box<dyn ManagedProcess>) -> bool {
        self.with_entry(id, |entry| {
            *entry.child.lock().expect("child lock") = Some(child);
        })
    }

    /// Transfer the registered child out of the run for final reaping.
    pub fn take_child(&self, id: &AiRunId) -> Option<Box<dyn ManagedProcess>> {
        self.entries
            .lock()
            .expect("run registry lock")
            .get(&id.0)
            .and_then(|entry| entry.child.lock().expect("child lock").take())
    }

    /// Remove a fully settled run so late cancellation cannot affect another run.
    pub fn remove(&self, id: &AiRunId) {
        self.entries
            .lock()
            .expect("run registry lock")
            .remove(&id.0);
    }
}

impl Default for RunRegistry {
    /// Create the default empty cancellation registry.
    fn default() -> Self {
        Self::new()
    }
}

// ---- ACP subprocess driver (blocking stdio, no shell) ----

#[derive(Debug, Default)]
pub struct TerminalGate {
    terminal: Option<AiStreamEvent>,
}

/// Identify events that must wait until the child and scope pin settle.
fn is_terminal(event: &AiStreamEvent) -> bool {
    matches!(
        event,
        AiStreamEvent::Done(_) | AiStreamEvent::Cancelled(_) | AiStreamEvent::Error(_)
    )
}

impl TerminalGate {
    /// Start a terminal gate without a buffered settlement.
    pub fn new() -> Self {
        Self { terminal: None }
    }

    /// Route one driver event: live events go to `emit` now, terminals held.
    pub fn push(&mut self, event: AiStreamEvent, emit: &mut (dyn FnMut(AiStreamEvent) + Send)) {
        if is_terminal(&event) {
            if self.terminal.is_none() {
                self.terminal = Some(event);
            }
        } else {
            emit(event);
        }
    }

    /// The single terminal to deliver after settlement and pin release.
    /// Drivers settle with exactly one terminal; a silent Ok still delivers
    /// an explicit internal error rather than hanging the panel.
    pub fn settle(self, outcome: &Result<(), AiError>, run_id: &AiRunId) -> AiStreamEvent {
        if let Some(event) = self.terminal {
            return event;
        }
        match outcome {
            Err(error) => AiStreamEvent::Error(StreamError {
                run_id: Some(run_id.clone()),
                error: error.clone(),
            }),
            Ok(()) => AiStreamEvent::Error(StreamError {
                run_id: Some(run_id.clone()),
                error: AiError::StreamFailed {
                    detail: "エージェントが終了状態を返しませんでした".into(),
                },
            }),
        }
    }
}

// ---- Production run settlement (shared by orchestration and tests) ----

/// Resolve HTTP credentials and target without touching any scope state.
/// Credential/target readiness runs BEFORE any scope pin, so missing secrets,
/// store errors, and invalid endpoints fail without pinning the copy.
pub fn resolve_http_request(
    keyring: &dyn AgentKeyring,
    provider: &AiProviderConfig,
) -> Result<(HttpTarget, String), AiError> {
    let target = http_target(provider)?;
    let secret = keyring
        .get(provider.kind)?
        .ok_or(AiError::MissingCredentials {
            provider: provider.kind,
        })?;
    Ok((target, secret))
}

/// Settle one production run on every path with a fixed order: reap the
/// child first (kill on abnormal paths; idempotent when already reaped),
/// then release the scope pin, then return exactly one terminal event.
/// Cancellation alone never reaches this helper; only driver completion,
/// errors, and panics settle here. Both IPC orchestration and tests call
/// this helper, so ordering is exercised rather than re-described.
pub fn settle_production_run(
    outcome: std::thread::Result<(TerminalGate, Result<(), AiError>)>,
    run_id: &AiRunId,
    reap_child: impl FnOnce(),
    release_pin: impl FnOnce(),
) -> AiStreamEvent {
    // Reap before unpin on every path: a panicking driver must not leave a
    // writing child alive past the pin release.
    reap_child();
    release_pin();
    match outcome {
        Ok((gate, inner)) => gate.settle(&inner, run_id),
        Err(_) => AiStreamEvent::Error(StreamError {
            run_id: Some(run_id.clone()),
            error: AiError::StreamFailed {
                detail: "エージェント実行が異常終了しました".into(),
            },
        }),
    }
}
