//! AI use cases own scope authorization, credential readiness, cancellation, and terminal order.
use super::{
    credentials::AgentKeyring, credentials::ApiConnectionKeyring, runs::*, transport::*,
    usage::UsageRegistry,
};
use crate::application::{isolation::IsolationManager, workspace::Workspace};
use crate::contracts::ai::*;
use crate::domain::ai::*;
use std::sync::{Arc, Mutex};
pub struct AiService {
    pub keyring: Arc<dyn AgentKeyring>,
    pub connection_keyring: Arc<dyn ApiConnectionKeyring>,
    pub transport: Arc<dyn AiTransport>,
    pub spawner: Arc<dyn TaskSpawner>,
    pub runs: Arc<RunRegistry>,
    pub usage: Arc<UsageRegistry>,
}
/// Map workspace authorization failures to AI errors without exposing live paths.
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
    workspace_state: &Arc<Mutex<Option<Workspace>>>,
    isolation: &Arc<Mutex<IsolationManager>>,
    request: &AiPromptRequest,
) -> Result<std::path::PathBuf, AiError> {
    let mut wguard = workspace_state
        .lock()
        .map_err(|_| AiError::ConnectionFailed {
            detail: "ワークスペースの状態を取得できません".into(),
        })?;
    let workspace = wguard.as_mut().ok_or_else(|| AiError::StagingUnresolved {
        copy_id: request.staging.copy_id.clone(),
    })?;
    let mut mguard = isolation.lock().map_err(|_| AiError::ConnectionFailed {
        detail: "隔離コピーの状態を取得できません".into(),
    })?;
    mguard
        .prepare_prompt_run(workspace, request)
        .map_err(|error| scope_error(request, error))
}

/// Release the staging pin after the owning run has settled.
fn release_scoped_run(isolation: &Arc<Mutex<IsolationManager>>, copy_id: &IsolatedCopyId) {
    if let Ok(mut manager) = isolation.lock() {
        manager.unpin_for_run(copy_id);
    }
}

impl AiService {
    /// Return credential presence without returning the stored secret to the caller.
    pub fn credential_state(&self, kind: AiProviderKind) -> Result<CredentialRef, AiError> {
        Ok(CredentialRef {
            provider: kind,
            has_secret: self.keyring.has(kind)?,
        })
    }
    /// Validate and store an explicitly supplied credential through the native secret port.
    pub fn set_credential(&self, kind: AiProviderKind, secret: &str) -> Result<(), AiError> {
        self.keyring.set(kind, secret)
    }
    /// Delete the selected credential without contacting its provider.
    pub fn delete_credential(&self, kind: AiProviderKind) -> Result<(), AiError> {
        self.keyring.delete(kind)
    }
    /// Return one named connection's credential presence without its value.
    pub fn connection_credential_state(
        &self,
        id: &ApiConnectionId,
    ) -> Result<ConnectionCredentialRef, AiError> {
        validate_connection_id(id)?;
        Ok(ConnectionCredentialRef {
            connection_id: id.clone(),
            has_secret: self.connection_keyring.has_connection(id)?,
        })
    }
    /// Validate and store one named connection's credential through the connection port.
    pub fn set_connection_credential(
        &self,
        id: &ApiConnectionId,
        secret: &str,
    ) -> Result<(), AiError> {
        validate_connection_id(id)?;
        self.connection_keyring.set_connection(id, secret)
    }
    /// Delete only the named connection's credential without contacting its provider.
    pub fn delete_connection_credential(&self, id: &ApiConnectionId) -> Result<(), AiError> {
        validate_connection_id(id)?;
        self.connection_keyring.delete_connection(id)
    }
    /// Copy the legacy kind credential into a named connection slot inside Rust.
    /// Copies only when the target slot is absent; legacy slots are never
    /// deleted here and no secret crosses the IPC boundary.
    pub fn migrate_connection_credential(
        &self,
        id: &ApiConnectionId,
        kind: AiProviderKind,
    ) -> Result<ConnectionCredentialRef, AiError> {
        validate_connection_id(id)?;
        if !self.connection_keyring.has_connection(id)? {
            if let Some(secret) = self.keyring.get(kind)? {
                self.connection_keyring.set_connection(id, &secret)?;
            }
        }
        self.connection_credential_state(id)
    }
    /// Check local readiness or perform the caller's explicit live connection probe.
    pub async fn test_connection(
        &self,
        config: AiProviderConfig,
        live: bool,
    ) -> Result<AiTestResult, AiError> {
        validate_provider_config(&config)?;
        if !live {
            return match config.kind {
                AiProviderKind::Acp => {
                    let argv = resolve_acp_argv(config.acp.as_ref().expect("validated"))?;
                    Ok(match self.transport.resolve_launch(&argv) {
                        Ok(launch) => AiTestResult {
                            config_options: None,
                            ok: true,
                            detail: format!(
                                "{} が見つかりました ({})",
                                argv.command,
                                launch.program.display()
                            ),
                        },
                        Err(AiError::MissingBinary { command }) => AiTestResult {
                            config_options: None,
                            ok: false,
                            detail: format!(
                                "{} が見つかりません。{}",
                                command,
                                missing_binary_hint(&command)
                            ),
                        },
                        Err(error) => return Err(error),
                    })
                }
                kind => Ok({
                    let has_secret = match config.connection_id.as_ref() {
                        Some(id) => {
                            validate_connection_id(id)?;
                            self.connection_keyring.has_connection(id)?
                        }
                        None => self.keyring.has(kind)?,
                    };
                    if has_secret {
                        AiTestResult {
                            config_options: None,
                            ok: true,
                            detail: "設定と資格情報の存在を確認しました（通信なし）".into(),
                        }
                    } else {
                        AiTestResult {
                            config_options: None,
                            ok: false,
                            detail: "資格情報が OS ストアにありません".into(),
                        }
                    }
                }),
            };
        }
        match config.kind {
            AiProviderKind::Acp => self
                .transport
                .handshake(&resolve_acp_argv(config.acp.as_ref().expect("validated"))?),
            kind => {
                let target = http_target(&config)?;
                let secret = match config.connection_id.as_ref() {
                    Some(id) => {
                        validate_connection_id(id)?;
                        self.connection_keyring
                            .get_connection(id)?
                            .ok_or(AiError::MissingCredentials { provider: kind })?
                    }
                    None => self
                        .keyring
                        .get(kind)?
                        .ok_or(AiError::MissingCredentials { provider: kind })?,
                };
                self.transport.test_http(&target, &secret).await
            }
        }
    }
    /// Authorize exact captured scopes, launch the configured provider and settle each run once.
    pub fn prompt_stream(
        &self,
        emit: Arc<dyn Fn(AiStreamEvent) + Send + Sync>,
        workspace_state: Arc<Mutex<Option<Workspace>>>,
        isolation: Arc<Mutex<IsolationManager>>,
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
                let (run_id, cancel) = self.runs.register();
                self.usage.reset_for_run(&run_id);
                let registry = self.runs.clone();
                let usage = self.usage.clone();
                let owned_run_id = run_id.clone();
                let owned_request = request.clone();
                let transport = self.transport.clone();
                self.spawner.spawn_blocking(Box::new(move || {
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
                        let inner = transport.run_acp(
                            &params,
                            &owned_request,
                            &owned_run_id,
                            &registry,
                            &cancel,
                            &mut |event| {
                                gate.push(event, &mut |live| {
                                    if let AiStreamEvent::Usage(report) = &live {
                                        usage.record(report.usage.clone());
                                    }
                                    emit(live);
                                });
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
                        || release_scoped_run(&isolation, &owned_request.staging.copy_id),
                    );
                    emit(terminal);
                    registry.remove(&owned_run_id);
                }));
                Ok(run_id)
            }
            AiProviderKind::OpenaiCompatible | AiProviderKind::Anthropic => {
                // Credential and target readiness BEFORE any scope pin: a missing
                // secret or keyring failure must return without pinning, so the
                // copy stays usable for reject/cancel/approve. Scope
                // authorization still precedes every network side effect.
                let (target, secret) = resolve_http_request(
                    self.keyring.as_ref(),
                    self.connection_keyring.as_ref(),
                    &request.provider,
                )?;
                prepare_scoped_run(&workspace_state, &isolation, &request)?;
                let (run_id, cancel) = self.runs.register();
                self.usage.reset_for_run(&run_id);
                let registry = self.runs.clone();
                let owned_run_id = run_id.clone();
                let owned_request = request.clone();
                let owned_copy = request.staging.copy_id.clone();
                let transport = self.transport.clone();
                self.spawner.spawn_async(Box::pin(async move {
                    // Same production settlement contract as ACP, shared with
                    // tests: buffer terminals, settle HTTP, release the pin,
                    // then deliver exactly once.
                    let settled =
                        futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(async {
                            let mut gate = TerminalGate::new();
                            let inner = async {
                                transport
                                    .run_http(
                                        &target,
                                        &secret,
                                        &owned_request,
                                        &owned_run_id,
                                        &cancel,
                                        &mut |event| {
                                            gate.push(event, &mut |live| emit(live));
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
                        || release_scoped_run(&isolation, &owned_copy),
                    );
                    emit(terminal);
                    registry.remove(&owned_run_id);
                }));
                Ok(run_id)
            }
        }
    }

    /// Signal cancellation while retaining scope pins until the driver reaps or settles.
    pub fn cancel(&self, run_id: AiRunId) -> Result<bool, AiError> {
        validate_run_id(&run_id)?;
        Ok(self.runs.cancel(&run_id))
    }

    /// Record the chat user's explicit permission choice by exact run/request/option IDs.
    ///
    /// Rejects stale or foreign run/request IDs and unoffered option IDs
    /// without touching the agent; the waiting driver delivers a validated
    /// choice exactly once or answers cancellation on its own path.
    pub fn reply_permission(
        &self,
        run_id: AiRunId,
        request_id: String,
        option_id: String,
    ) -> Result<(), AiError> {
        validate_run_id(&run_id)?;
        self.runs.reply_permission(&run_id, &request_id, &option_id)
    }

    /// Return the latest reported ACP usage for popup refresh.
    /// This is read-only: it never sends a prompt or starts inference.
    pub fn usage_snapshot(&self) -> Vec<ReportedUsage> {
        self.usage.snapshot()
    }
}
