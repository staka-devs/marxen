//! Tauri AI commands: desktop state, credential access, tasks, and event delivery.
use super::{isolation::IsolationState, ActorState};
use crate::ai::{
    dry_run_report, handshake_acp, http_client, resolve_acp_argv, resolve_http_request,
    run_acp_prompt, run_http_prompt, settle_production_run, test_anthropic_live, test_openai_live,
    validate_prompt_request, validate_provider_config, validate_run_id, AcpRunParams, AgentKeyring,
    OsKeyring, RunRegistry, TerminalGate, ACP_DEFAULT_TIMEOUT, HTTP_TEST_TIMEOUT,
};
use crate::ai_contracts::*;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::Emitter;

// ---- Tauri commands (desktop only; JavaScript never sees secrets) ----

static RUNS: LazyLock<Arc<RunRegistry>> = LazyLock::new(|| Arc::new(RunRegistry::new()));

fn emit_to_frontend(app: &tauri::AppHandle, event: AiStreamEvent) {
    let _ = app.emit("ai-stream", event);
}

#[tauri::command]
pub fn ai_credential_state(kind: AiProviderKind) -> Result<CredentialRef, AiError> {
    Ok(CredentialRef {
        provider: kind,
        has_secret: OsKeyring.has(kind)?,
    })
}

#[tauri::command]
pub fn ai_set_credential(kind: AiProviderKind, secret: String) -> Result<(), AiError> {
    OsKeyring.set(kind, &secret)
}

#[tauri::command]
pub fn ai_delete_credential(kind: AiProviderKind) -> Result<(), AiError> {
    OsKeyring.delete(kind)
}

#[tauri::command]
pub async fn ai_test_connection(
    config: AiProviderConfig,
    live: bool,
) -> Result<AiTestResult, AiError> {
    validate_provider_config(&config)?;
    if !live {
        return dry_run_report(&config, &OsKeyring);
    }
    match config.kind {
        AiProviderKind::Acp => {
            let argv = resolve_acp_argv(config.acp.as_ref().expect("validated"))?;
            handshake_acp(&argv)
        }
        AiProviderKind::OpenaiCompatible => {
            let openai = config.openai.as_ref().expect("validated");
            let secret = OsKeyring
                .get(config.kind)?
                .ok_or(AiError::MissingCredentials {
                    provider: config.kind,
                })?;
            test_openai_live(&http_client(HTTP_TEST_TIMEOUT)?, &openai.endpoint, &secret).await
        }
        AiProviderKind::Anthropic => {
            let anthropic = config.anthropic.as_ref().expect("validated");
            let secret = OsKeyring
                .get(config.kind)?
                .ok_or(AiError::MissingCredentials {
                    provider: config.kind,
                })?;
            test_anthropic_live(
                &http_client(HTTP_TEST_TIMEOUT)?,
                &anthropic.endpoint,
                &anthropic.model,
                &secret,
            )
            .await
        }
    }
}

fn scope_error(request: &AiPromptRequest, error: crate::contracts::WorkspaceError) -> AiError {
    use crate::contracts::WorkspaceError as W;
    match error {
        W::OutsideWorkspace => AiError::LiveTargetRejected {
            detail: "作業コピーの外を指しています".into(),
        },
        W::NotFound | W::UnknownDocument | W::NoWorkspace => AiError::StagingUnresolved {
            copy_id: request.staging.copy_id.clone(),
        },
        W::Contract { error } => AiError::InvalidConfig {
            detail: format!("送信範囲が文書と一致しません: {error:?}"),
        },
        W::Conflict { path } => AiError::InvalidConfig {
            detail: format!("ディスクが変更されています。再同期してください: {path}"),
        },
        W::Io { detail } => AiError::InvalidConfig { detail },
        _ => AiError::StagingUnresolved {
            copy_id: request.staging.copy_id.clone(),
        },
    }
}

/// Resolve the staging copy, authorize the prompt scope against the captured
/// Rust snapshots, and pin the copy for the run. Workspace is locked before
/// the isolation manager, matching the isolation IPC order.
fn prepare_scoped_run(
    workspace_state: &tauri::State<'_, ActorState>,
    isolation: &tauri::State<'_, IsolationState>,
    request: &AiPromptRequest,
) -> Result<std::path::PathBuf, AiError> {
    let mut wguard = workspace_state
        .workspace
        .lock()
        .map_err(|_| AiError::ConnectionFailed {
            detail: "ワークスペースの状態を取得できません".into(),
        })?;
    let workspace = wguard.as_mut().ok_or_else(|| AiError::StagingUnresolved {
        copy_id: request.staging.copy_id.clone(),
    })?;
    let mut mguard = isolation
        .manager
        .lock()
        .map_err(|_| AiError::ConnectionFailed {
            detail: "隔離コピーの状態を取得できません".into(),
        })?;
    mguard
        .prepare_prompt_run(workspace, request)
        .map_err(|error| scope_error(request, error))
}

fn release_scoped_run(app: &tauri::AppHandle, copy_id: &IsolatedCopyId) {
    // Settlement-only release looked up from the owned handle, so background
    // threads never need to carry State across lifetimes.
    use tauri::Manager as _;
    if let Some(state) = app.try_state::<IsolationState>() {
        if let Ok(mut manager) = state.manager.lock() {
            manager.unpin_for_run(copy_id);
        }
    }
}

#[tauri::command]
pub async fn ai_prompt_stream(
    app: tauri::AppHandle,
    workspace_state: tauri::State<'_, ActorState>,
    isolation: tauri::State<'_, IsolationState>,
    request: AiPromptRequest,
) -> Result<AiRunId, AiError> {
    validate_prompt_request(&request)?;
    match request.provider.kind {
        AiProviderKind::Acp => {
            let argv = resolve_acp_argv(request.provider.acp.as_ref().expect("validated"))?;
            // #8: agents run with the isolated copy as cwd after scope
            // authorization. Live paths never cross this boundary; unknown,
            // inactive, or out-of-scope copies are refused before spawning.
            let staging_dir = prepare_scoped_run(&workspace_state, &isolation, &request)?;
            let (run_id, cancel) = RUNS.register();
            let registry = RUNS.clone();
            let owned_run_id = run_id.clone();
            let owned_request = request.clone();
            std::thread::spawn(move || {
                let params = AcpRunParams {
                    argv,
                    staging_dir,
                    timeout: ACP_DEFAULT_TIMEOUT,
                };
                // Production settlement order shared with tests: the driver
                // runs with terminals buffered, then the child is reaped,
                // the pin released, and exactly one terminal delivered. The
                // panel's Done never precedes settlement, and panics settle
                // without leaking the child, the pin, or delivery.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut gate = TerminalGate::new();
                    let inner = run_acp_prompt(
                        &params,
                        &owned_request,
                        &owned_run_id,
                        &registry,
                        &cancel,
                        &mut |event| {
                            gate.push(event, &mut |live| emit_to_frontend(&app, live));
                        },
                    );
                    (gate, inner)
                }));
                let terminal = settle_production_run(
                    outcome,
                    &owned_run_id,
                    || {
                        registry.cancel(&owned_run_id);
                    },
                    || release_scoped_run(&app, &owned_request.staging.copy_id),
                );
                emit_to_frontend(&app, terminal);
                registry.remove(&owned_run_id);
            });
            Ok(run_id)
        }
        AiProviderKind::OpenaiCompatible | AiProviderKind::Anthropic => {
            // Credential and target readiness BEFORE any scope pin: a missing
            // secret or keyring failure must return without pinning, so the
            // copy stays usable for reject/cancel/approve. Scope
            // authorization still precedes every network side effect.
            let (target, secret) = resolve_http_request(&OsKeyring, &request.provider)?;
            prepare_scoped_run(&workspace_state, &isolation, &request)?;
            let (run_id, cancel) = RUNS.register();
            let registry = RUNS.clone();
            let owned_run_id = run_id.clone();
            let owned_request = request.clone();
            let owned_copy = request.staging.copy_id.clone();
            tauri::async_runtime::spawn(async move {
                // Same production settlement contract as ACP, shared with
                // tests: buffer terminals, settle HTTP, release the pin,
                // then deliver exactly once.
                let settled =
                    futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(async {
                        let mut gate = TerminalGate::new();
                        let inner = async {
                            let client = http_client(Duration::from_secs(600))?;
                            run_http_prompt(
                                &client,
                                &target,
                                &secret,
                                &owned_request,
                                &owned_run_id,
                                &cancel,
                                &mut |event| {
                                    gate.push(event, &mut |live| emit_to_frontend(&app, live));
                                },
                            )
                            .await
                        }
                        .await;
                        (gate, inner)
                    }))
                    .await;
                let terminal = settle_production_run(
                    settled,
                    &owned_run_id,
                    || {},
                    || release_scoped_run(&app, &owned_copy),
                );
                emit_to_frontend(&app, terminal);
                registry.remove(&owned_run_id);
            });
            Ok(run_id)
        }
    }
}

#[tauri::command]
pub fn ai_prompt_cancel(run_id: AiRunId) -> Result<bool, AiError> {
    validate_run_id(&run_id)?;
    Ok(RUNS.cancel(&run_id))
}
