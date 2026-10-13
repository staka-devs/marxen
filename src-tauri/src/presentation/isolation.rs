//! Tauri isolation commands and desktop shared state.
use crate::application::isolation::IsolationManager;
use crate::application::workspace::Workspace;
use crate::contracts::ai::{IsolatedCopyId, PromptContext, PromptMode, ProposalText};
use crate::contracts::isolation::{ApproveResult, IsolatedCopyInfo, IsolationDiff, StagedNewFile, StagedProposal};
use crate::contracts::WorkspaceError;
use crate::presentation::document::ActorState;

/// Lock workspace before isolation so review operations share the same mutation order as AI scope pins.
fn with_both<T>(
    workspace: &ActorState,
    isolation: &IsolationState,
    call: impl FnOnce(&Workspace, &mut IsolationManager) -> Result<T, WorkspaceError>,
) -> Result<T, WorkspaceError> {
    let mut wguard = workspace.workspace.lock().map_err(|_| WorkspaceError::Io {
        detail: "workspace lock poisoned".into(),
    })?;
    let workspace = wguard.as_mut().ok_or(WorkspaceError::NoWorkspace)?;
    let mut mguard = isolation.manager.lock().map_err(|_| WorkspaceError::Io {
        detail: "isolation lock poisoned".into(),
    })?;
    call(workspace, &mut mguard)
}

#[tauri::command(async)]
/// Capture exact authoritative document scopes into a registered isolated copy.
pub fn isolation_create(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    contexts: Vec<PromptContext>,
) -> Result<IsolatedCopyInfo, WorkspaceError> {
    with_both(&workspace_state, &isolation, |w, m| {
        m.create_copy(w, &contexts)
    })
}

#[tauri::command(async)]
/// Compare registered staging scopes with their live authoritative snapshots.
pub fn isolation_diff(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
) -> Result<Vec<IsolationDiff>, WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| m.diff(w, &id))
}

#[tauri::command(async)]
/// List new agent-created Markdown files inside the staging copy for import.
///
/// Only contained relative `.md` paths are reported; forbidden and
/// non-Markdown files are omitted. Content is staged text, never applied.
pub fn isolation_new_files(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
) -> Result<Vec<StagedNewFile>, WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| m.staged_new_files(w, &id))
}

#[tauri::command(async)]
/// Validate and stage a proposal against the copy's registered scopes.
pub fn isolation_stage_proposal(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
    proposal: ProposalText,
    mode: PromptMode,
) -> Result<StagedProposal, WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| {
        m.stage_proposal(w, &id, &proposal, mode)
    })
}

#[tauri::command(async)]
/// Apply only approved scoped patches through the authoritative document actors.
pub fn isolation_approve(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
) -> Result<ApproveResult, WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| m.approve(w, &id))
}

#[tauri::command(async)]
/// Discard an unpinned copy without editing live documents.
pub fn isolation_reject(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
) -> Result<(), WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| {
        let _ = w;
        m.reject(&id)
    })
}

#[tauri::command(async)]
/// Cancel an unpinned copy after its owning AI run has settled.
pub fn isolation_cancel(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
) -> Result<(), WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| {
        let _ = w;
        m.cancel(&id)
    })
}

/// Tauri-shared isolation state (desktop). Single manager keyed by copy id.
pub struct IsolationState {
    pub manager: std::sync::Arc<std::sync::Mutex<IsolationManager>>,
}

impl IsolationState {
    /// Share one injected staging manager across command and background run settlement paths.
    pub fn new(manager: IsolationManager) -> Self {
        Self {
            manager: std::sync::Arc::new(std::sync::Mutex::new(manager)),
        }
    }
}
