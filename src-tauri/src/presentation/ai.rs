//! Thin Tauri AI commands preserve IPC payloads while application owns each run.
use super::{document::ActorState, isolation::IsolationState};
use crate::application::ai::account_usage::AccountUsageService;
use crate::application::ai::service::AiService;
use crate::contracts::ai::*;
use std::sync::Arc;
use tauri::Emitter;
#[tauri::command]
/// Return credential presence through the AI use case without returning its value.
pub fn ai_credential_state(
    service: tauri::State<'_, AiService>,
    kind: AiProviderKind,
) -> Result<CredentialRef, AiError> {
    service.credential_state(kind)
}
#[tauri::command]
/// Pass an explicitly supplied credential to the native-backed AI use case.
pub fn ai_set_credential(
    service: tauri::State<'_, AiService>,
    kind: AiProviderKind,
    secret: String,
) -> Result<(), AiError> {
    service.set_credential(kind, &secret)
}
#[tauri::command]
/// Remove the selected provider credential through the AI use case.
pub fn ai_delete_credential(
    service: tauri::State<'_, AiService>,
    kind: AiProviderKind,
) -> Result<(), AiError> {
    service.delete_credential(kind)
}
#[tauri::command]
/// Return one named connection's credential presence without its value.
pub fn ai_connection_credential_state(
    service: tauri::State<'_, AiService>,
    connection_id: ApiConnectionId,
) -> Result<ConnectionCredentialRef, AiError> {
    service.connection_credential_state(&connection_id)
}
#[tauri::command]
/// Pass one named connection's explicitly supplied credential to the use case.
pub fn ai_set_connection_credential(
    service: tauri::State<'_, AiService>,
    connection_id: ApiConnectionId,
    secret: String,
) -> Result<(), AiError> {
    service.set_connection_credential(&connection_id, &secret)
}
#[tauri::command]
/// Remove only the named connection's credential through the AI use case.
pub fn ai_delete_connection_credential(
    service: tauri::State<'_, AiService>,
    connection_id: ApiConnectionId,
) -> Result<(), AiError> {
    service.delete_connection_credential(&connection_id)
}
#[tauri::command]
/// Run the caller's local readiness or explicit live provider probe.
pub async fn ai_test_connection(
    service: tauri::State<'_, AiService>,
    config: AiProviderConfig,
    live: bool,
) -> Result<AiTestResult, AiError> {
    service.test_connection(config, live).await
}
#[tauri::command]
/// Bridge application stream events to Tauri and return the registered run identifier.
pub async fn ai_prompt_stream(
    app: tauri::AppHandle,
    service: tauri::State<'_, AiService>,
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    request: AiPromptRequest,
) -> Result<AiRunId, AiError> {
    if request
        .conversation_id
        .as_ref()
        .is_none_or(|id| id.is_empty() || id.len() > 128)
    {
        return Err(AiError::InvalidConfig {
            detail: "会話の識別子がありません".into(),
        });
    }
    if request
        .contexts
        .iter()
        .any(|context| context.location.is_none())
    {
        return Err(AiError::InvalidConfig {
            detail: "送信対象の所有ルートがありません".into(),
        });
    }
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
/// Route cancellation to the exact registered AI run.
pub fn ai_prompt_cancel(
    service: tauri::State<'_, AiService>,
    run_id: AiRunId,
) -> Result<bool, AiError> {
    service.cancel(run_id)
}
#[tauri::command]
/// Record the chat user's explicit permission choice by exact run/request/option IDs.
///
/// Rejects stale, foreign, or unoffered IDs without touching the agent. The
/// waiting ACP driver delivers a validated choice exactly once; cancellation
/// travels through `ai_prompt_cancel` instead of this command.
pub fn ai_permission_reply(
    service: tauri::State<'_, AiService>,
    run_id: AiRunId,
    request_id: String,
    option_id: String,
) -> Result<(), AiError> {
    service.reply_permission(run_id, request_id, option_id)
}
#[tauri::command]
/// Return the latest reported ACP usage for popup refresh.
/// This is read-only: it never sends a prompt or starts inference.
pub fn ai_usage_snapshot(service: tauri::State<'_, AiService>) -> Vec<ReportedUsage> {
    service.usage_snapshot()
}

#[tauri::command(async)]
/// Read the installed Codex account's official limits without starting inference.
pub fn ai_codex_account_usage(
    service: tauri::State<'_, AccountUsageService>,
) -> Result<CodexAccountUsage, AiError> {
    service.read_codex()
}
