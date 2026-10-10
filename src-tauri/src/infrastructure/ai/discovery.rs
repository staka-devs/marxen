//! Native connection readiness probes.
use super::acp::find_on_path;
use crate::application::ai::credentials::*;
use crate::application::ai::runs::*;
use crate::contracts::ai::*;
use crate::contracts::Utf16Range;
use crate::domain::ai::*;
use crate::domain::validation::validate_document_id;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
pub fn dry_run_report(
    config: &AiProviderConfig,
    keyring: &dyn AgentKeyring,
) -> Result<AiTestResult, AiError> {
    validate_provider_config(config)?;
    match config.kind {
        AiProviderKind::Acp => {
            let acp = config.acp.as_ref().expect("validated");
            let argv = resolve_acp_argv(acp)?;
            match find_on_path(&argv.command) {
                Some(path) => Ok(AiTestResult {
                    ok: true,
                    detail: format!("{} が見つかりました ({})", argv.command, path.display()),
                }),
                None => Ok(AiTestResult {
                    ok: false,
                    detail: format!(
                        "{} が見つかりません。CLI をインストールして PATH を通してください",
                        argv.command
                    ),
                }),
            }
        }
        kind => {
            if keyring.has(kind)? {
                Ok(AiTestResult {
                    ok: true,
                    detail: "設定と資格情報の存在を確認しました（通信なし）".into(),
                })
            } else {
                Ok(AiTestResult {
                    ok: false,
                    detail: "資格情報が OS ストアにありません".into(),
                })
            }
        }
    }
}
