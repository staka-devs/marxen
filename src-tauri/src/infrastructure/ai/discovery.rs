//! Native connection readiness probes.
use super::acp::resolve_acp_launch;
use crate::application::ai::credentials::*;
use crate::contracts::ai::*;
use crate::domain::ai::*;
/// Check provider configuration, binary or credential presence without starting a process or network request.
pub fn dry_run_report(
    config: &AiProviderConfig,
    keyring: &dyn AgentKeyring,
) -> Result<AiTestResult, AiError> {
    validate_provider_config(config)?;
    match config.kind {
        AiProviderKind::Acp => {
            let acp = config.acp.as_ref().expect("validated");
            let argv = resolve_acp_argv(acp)?;
            match resolve_acp_launch(&argv) {
                Ok(launch) => Ok(AiTestResult {
                    config_options: None,
                    ok: true,
                    detail: format!(
                        "{} が見つかりました ({})",
                        argv.command,
                        launch.program.display()
                    ),
                }),
                Err(AiError::MissingBinary { command }) => Ok(AiTestResult {
                    config_options: None,
                    ok: false,
                    detail: format!(
                        "{} が見つかりません。{}",
                        command,
                        missing_binary_hint(&command)
                    ),
                }),
                Err(error) => Err(error),
            }
        }
        kind => {
            if keyring.has(kind)? {
                Ok(AiTestResult {
                    config_options: None,
                    ok: true,
                    detail: "設定と資格情報の存在を確認しました（通信なし）".into(),
                })
            } else {
                Ok(AiTestResult {
                    config_options: None,
                    ok: false,
                    detail: "資格情報が OS ストアにありません".into(),
                })
            }
        }
    }
}
