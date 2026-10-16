//! Official read-only Codex account RPC, using installed CLI authentication.
use super::acp::{codex_npm_program, find_on_path, spawn_acp, AgentConn, ConnLine, ReadFail};
use crate::application::ai::account_usage::AccountUsageReader;
use crate::application::provider_accounts::AccountLaunchEnvironment;
use crate::contracts::ai::{AcpArgv, AiError, CodexUsageBucket};
use crate::domain::ai_account_usage::parse_codex_rate_limits;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub struct NativeAccountUsageReader;

/// Return a bounded read failure without exposing provider error bodies or account data.
fn read_error() -> AiError {
    AiError::ConnectionFailed {
        detail: "Codex の利用枠を取得できませんでした".into(),
    }
}

/// Await a matching account reply within one deadline and refuse server tool requests.
fn reply(connection: &mut AgentConn, id: u64, deadline: Instant) -> Result<Value, AiError> {
    for _ in 0..64 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(read_error)?;
        match connection.read_next(Some(remaining)) {
            Ok(ConnLine::Value(message)) if message.get("method").is_some() => {
                if let Some(request_id) = message.get("id") {
                    connection.write(&json!({ "id": request_id, "error": { "code": -32601, "message": "Read-only account usage" } }))?;
                }
            }
            Ok(ConnLine::Value(message))
                if message.get("id").and_then(Value::as_u64) == Some(id) =>
            {
                if message.get("error").is_some() {
                    return Err(read_error());
                }
                return message.get("result").cloned().ok_or_else(read_error);
            }
            Ok(ConnLine::Value(_)) => return Err(read_error()),
            Ok(ConnLine::Eof) | Err(ReadFail::Timeout) => return Err(read_error()),
            Err(ReadFail::Stream(_)) => return Err(read_error()),
        }
    }
    Err(read_error())
}

/// Launch only the supplied account reader, perform initialization and limit-read, then reap it.
/// No thread, model turn, login, reset-credit consumption, or prompt is requested.
pub fn read_codex_with_argv(
    argv: &AcpArgv,
    timeout: Duration,
) -> Result<Vec<CodexUsageBucket>, AiError> {
    read_codex_with_environment(argv, timeout, None)
}

/// Read limits with a managed child environment while retaining the bounded RPC protocol.
pub fn read_codex_with_environment(
    argv: &AcpArgv,
    timeout: Duration,
    environment: Option<&AccountLaunchEnvironment>,
) -> Result<Vec<CodexUsageBucket>, AiError> {
    let scratch = tempfile::tempdir().map_err(|_| read_error())?;
    let mut child = if let Some(environment) = environment {
        let launch = super::acp::resolve_acp_launch(argv)?;
        let mut command = std::process::Command::new(&launch.program);
        command
            .args(&launch.args)
            .current_dir(scratch.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for key in &environment.remove {
            command.env_remove(key);
        }
        command.envs(&environment.set);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command.spawn().map_err(|_| read_error())?
    } else {
        spawn_acp(argv, scratch.path())?
    };
    let result = (|| {
        let stdin = child.stdin.take().ok_or_else(read_error)?;
        let stdout = child.stdout.take().ok_or_else(read_error)?;
        if let Some(mut stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            });
        }
        let mut connection = AgentConn::launch(stdin, stdout);
        let deadline = Instant::now() + timeout;
        connection.write(&json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "marxen", "title": "Marxen", "version": env!("CARGO_PKG_VERSION") } } }))?;
        reply(&mut connection, 1, deadline)?;
        connection.notify(&json!({ "method": "initialized", "params": {} }))?;
        connection.write(&json!({ "id": 2, "method": "account/rateLimits/read" }))?;
        let reported = reply(&mut connection, 2, deadline)?;
        Ok(parse_codex_rate_limits(&reported))
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Resolve the installed Codex account reader without starting it.
pub fn codex_account_argv() -> Result<AcpArgv, AiError> {
    let mut command = "codex".to_owned();
    if !cfg!(windows) {
        if let Some(script) = find_on_path("codex").and_then(|path| path.canonicalize().ok()) {
            if script.ends_with("@openai/codex/bin/codex.js") {
                let npm_root = script.ancestors().nth(5).ok_or_else(read_error)?;
                command = codex_npm_program(npm_root)
                    .ok_or_else(|| AiError::MissingBinary {
                        command: "codex".into(),
                    })?
                    .to_string_lossy()
                    .into_owned();
            }
        }
    }
    Ok(AcpArgv {
        command,
        args: vec!["app-server".into(), "--listen".into(), "stdio://".into()],
    })
}

impl AccountUsageReader for NativeAccountUsageReader {
    /// Read official Codex limits using the installed CLI and its managed authentication.
    fn read_codex(&self) -> Result<Vec<CodexUsageBucket>, AiError> {
        read_codex_with_argv(&codex_account_argv()?, Duration::from_secs(15))
    }
}
