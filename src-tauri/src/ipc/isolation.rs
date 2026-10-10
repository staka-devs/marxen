//! Tauri isolation commands and desktop shared state.
use crate::ai_contracts::{IsolatedCopyId, PromptContext, PromptMode, ProposalText};
use crate::contracts::WorkspaceError;
use crate::ipc::ActorState;
use crate::isolation::{
    ApproveResult, IsolatedCopyInfo, IsolationDiff, IsolationManager, StagedProposal,
};
use crate::workspace::Workspace;

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
pub fn isolation_diff(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
) -> Result<Vec<IsolationDiff>, WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| m.diff(w, &id))
}

#[tauri::command(async)]
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
pub fn isolation_approve(
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    copy_id: String,
) -> Result<ApproveResult, WorkspaceError> {
    let id = IsolatedCopyId(copy_id);
    with_both(&workspace_state, &isolation, |w, m| m.approve(w, &id))
}

#[tauri::command(async)]
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
    pub manager: std::sync::Mutex<IsolationManager>,
}

impl Default for IsolationState {
    fn default() -> Self {
        let manager = IsolationManager::open_default().expect("staging dir");
        Self {
            manager: std::sync::Mutex::new(manager),
        }
    }
}
