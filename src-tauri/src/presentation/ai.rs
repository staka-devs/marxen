//! Thin Tauri AI commands preserve IPC payloads while application owns each run.
use super::{document::ActorState, isolation::IsolationState};
use crate::application::ai::service::AiService;
use crate::contracts::ai::*;
use std::sync::Arc;
use tauri::Emitter;
#[tauri::command]
pub fn ai_credential_state(
    service: tauri::State<'_, AiService>,
    kind: AiProviderKind,
) -> Result<CredentialRef, AiError> {
    service.credential_state(kind)
}
#[tauri::command]
pub fn ai_set_credential(
    service: tauri::State<'_, AiService>,
    kind: AiProviderKind,
    secret: String,
) -> Result<(), AiError> {
    service.set_credential(kind, &secret)
}
#[tauri::command]
pub fn ai_delete_credential(
    service: tauri::State<'_, AiService>,
    kind: AiProviderKind,
) -> Result<(), AiError> {
    service.delete_credential(kind)
}
#[tauri::command]
pub async fn ai_test_connection(
    service: tauri::State<'_, AiService>,
    config: AiProviderConfig,
    live: bool,
) -> Result<AiTestResult, AiError> {
    service.test_connection(config, live).await
}
#[tauri::command]
pub async fn ai_prompt_stream(
    app: tauri::AppHandle,
    service: tauri::State<'_, AiService>,
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    request: AiPromptRequest,
) -> Result<AiRunId, AiError> {
    service.prompt_stream(
        Arc::new(move |event| {
            let _ = app.emit("ai-stream", event);
        }),
        workspace_state.workspace.clone(),
        isolation.manager.clone(),
        request,
    )
}
#[tauri::command]
pub fn ai_prompt_cancel(
    service: tauri::State<'_, AiService>,
    run_id: AiRunId,
) -> Result<bool, AiError> {
    service.cancel(run_id)
}
