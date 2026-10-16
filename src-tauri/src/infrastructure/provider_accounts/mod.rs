//! Private account homes and quota adapters never change host-default authentication.
mod store;
mod usage;
#[cfg(windows)]
mod windows;
use crate::application::provider_accounts::*;
use crate::contracts::provider_accounts::*;
use crate::domain::provider_accounts::{valid_id, validate_account};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};
pub use store::{NativeAccountCredentials, NativeAccountStore};

pub struct NativeAccountRuntime {
    pub root: PathBuf,
    pub home: PathBuf,
}

/// Resolve platform application storage without using a workspace or a provider's default home.
pub fn platform_paths() -> Result<(PathBuf, PathBuf), ProviderAccountError> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or(ProviderAccountError::StoreFailed)?;
    let data = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or(ProviderAccountError::StoreFailed)?
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"))
    };
    if !home.is_absolute() || !data.is_absolute() {
        return Err(ProviderAccountError::StoreFailed);
    }
    Ok((data.join("marxen/provider-accounts"), home))
}

/// Write a secret-bearing runtime file atomically with Unix owner-only permissions.
fn private_file(path: &Path, bytes: &[u8]) -> Result<(), ProviderAccountError> {
    let parent = path.parent().ok_or(ProviderAccountError::StoreFailed)?;
    store::directory(parent)?;
    store::reject_link(path)?;
    let expected = crate::infrastructure::storage::disk_fingerprint(path)
        .map_err(|_| ProviderAccountError::StoreFailed)?;
    crate::infrastructure::storage::atomic_write(path, bytes, expected.as_ref(), None)
        .map_err(|_| ProviderAccountError::StoreFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| ProviderAccountError::StoreFailed)?;
    }
    Ok(())
}

/// Observe launcher failures without terminating a browser that remains attached to its launcher.
fn wait_browser_launcher(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> Result<(), ProviderAccountError> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(ProviderAccountError::RequestFailed)
                }
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Ok(None) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(_) => return Err(ProviderAccountError::RequestFailed),
        }
    }
}

impl NativeAccountRuntime {
    /// Select known default credential locations without scanning unrelated files or browsers.
    fn system_file(&self, provider: AccountProvider) -> Option<PathBuf> {
        match provider {
            AccountProvider::Codex => Some(
                std::env::var_os("CODEX_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.home.join(".codex"))
                    .join("auth.json"),
            ),
            AccountProvider::Claude => Some(
                std::env::var_os("CLAUDE_CONFIG_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.home.join(".claude"))
                    .join(".credentials.json"),
            ),
            AccountProvider::Opencode | AccountProvider::OpencodeGo => Some(
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.home.join(".local/share"))
                    .join("opencode/auth.json"),
            ),
            AccountProvider::Devin => Some(if cfg!(windows) {
                std::env::var_os("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.home.join("AppData/Roaming"))
                    .join("devin/credentials.toml")
            } else {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.home.join(".local/share"))
                    .join("devin/credentials.toml")
            }),
            AccountProvider::Gemini => Some(self.home.join(".gemini/oauth_creds.json")),
            _ => None,
        }
    }

    /// Read selected default credentials only for an explicit user action; never rewrite them.
    fn system_secret(
        &self,
        provider: AccountProvider,
    ) -> Result<Option<String>, ProviderAccountError> {
        let Some(path) = self.system_file(provider) else {
            return Ok(None);
        };
        if provider == AccountProvider::Devin {
            use std::io::Read;
            store::reject_link(&path)?;
            let file = match fs::File::open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(ProviderAccountError::StoreFailed),
            };
            let mut secret = String::new();
            file.take(32769)
                .read_to_string(&mut secret)
                .map_err(|_| ProviderAccountError::StoreFailed)?;
            crate::domain::provider_accounts::validate_credential(provider, &secret)?;
            return Ok(Some(secret));
        }
        let value = store::read_json(&path)?;
        match (provider, value) {
            (AccountProvider::OpencodeGo, Some(value)) => Ok(value
                .get("opencode-go")
                .and_then(|v| v.get("key"))
                .and_then(Value::as_str)
                .map(str::to_owned)),
            (_, Some(value)) => serde_json::to_string(&value)
                .map(Some)
                .map_err(|_| ProviderAccountError::InvalidResponse),
            (_, None) => Ok(None),
        }
    }
}

impl ProviderAccountRuntime for NativeAccountRuntime {
    /// Dispatch fixed public URLs without a shell, observing launcher failure within five seconds.
    fn open_setup(&self, provider: AccountProvider) -> Result<(), ProviderAccountError> {
        use std::process::{Command, Stdio};
        use std::time::Duration;
        let url = crate::domain::provider_accounts::setup_url(provider);
        let mut command = if cfg!(target_os = "macos") {
            Command::new("/usr/bin/open")
        } else if cfg!(windows) {
            let mut command = Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        } else {
            Command::new("xdg-open")
        };
        let child = command
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ProviderAccountError::RequestFailed)?;
        wait_browser_launcher(child, Duration::from_secs(5))
    }

    /// Presence is explicitly unverified and does not launch the CLI or access the network.
    fn system_credential_present(
        &self,
        provider: AccountProvider,
    ) -> Result<bool, ProviderAccountError> {
        if self.system_file(provider).is_none() {
            return Err(ProviderAccountError::Unsupported {
                reason: AccountReason::AdapterUnsupported,
            });
        }
        let Some(secret) = self.system_secret(provider)? else {
            return Ok(false);
        };
        if provider == AccountProvider::OpencodeGo {
            return Ok(!secret.is_empty());
        }
        Ok(crate::domain::provider_accounts::validate_credential(provider, &secret).is_ok())
    }

    /// Materialize independent config and clear inherited authentication overrides in the child.
    fn environment(
        &self,
        account: &ProviderAccount,
        credential: &str,
    ) -> Result<AccountLaunchEnvironment, ProviderAccountError> {
        validate_account(account)?;
        if !matches!(account.host, AccountHost::Local) {
            return Err(ProviderAccountError::Unsupported {
                reason: AccountReason::WslUnsupported,
            });
        }
        if !(cfg!(unix) || cfg!(windows))
            || (account.provider == AccountProvider::Claude
                && !(cfg!(target_os = "linux") || cfg!(windows)))
        {
            return Err(ProviderAccountError::Unsupported {
                reason: AccountReason::PrivateFilesUnsupported,
            });
        }
        if !matches!(
            account.provider,
            AccountProvider::Codex
                | AccountProvider::Claude
                | AccountProvider::Opencode
                | AccountProvider::Devin
        ) {
            return Err(ProviderAccountError::Unsupported {
                reason: AccountReason::AdapterUnsupported,
            });
        }
        let mut env = AccountLaunchEnvironment {
            identity: format!("{:?}:{}:{}", account.provider, account.id, account.revision),
            ..Default::default()
        };
        store::directory(&self.root)?;
        let account_root = self.root.join(&account.id);
        store::directory(&account_root)?;
        let root = account_root.join(account.revision.to_string());
        store::directory(&root)?;
        env.set
            .insert("HOME".into(), root.to_string_lossy().into_owned());
        #[cfg(windows)]
        {
            env.set
                .insert("USERPROFILE".into(), root.to_string_lossy().into_owned());
            for (key, subdir) in [
                ("APPDATA", "AppData/Roaming"),
                ("LOCALAPPDATA", "AppData/Local"),
            ] {
                let private = root.join(subdir);
                store::directory(&private)?;
                env.set
                    .insert(key.into(), private.to_string_lossy().into_owned());
            }
        }
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if name.ends_with("_API_KEY")
                || name.ends_with("_ACCESS_TOKEN")
                || name.ends_with("_AUTH_TOKEN")
            {
                env.remove.push(name.into_owned());
            }
        }
        match account.provider {
            AccountProvider::Codex => {
                private_file(&root.join("auth.json"), credential.as_bytes())?;
                private_file(
                    &root.join("config.toml"),
                    b"cli_auth_credentials_store = \"file\"\n",
                )?;
                env.set
                    .insert("CODEX_HOME".into(), root.to_string_lossy().into_owned());
                env.remove.extend(
                    [
                        "OPENAI_API_KEY",
                        "CODEX_API_KEY",
                        "OPENAI_BASE_URL",
                        "OPENAI_ORG_ID",
                        "OPENAI_ORGANIZATION",
                        "OPENAI_PROJECT_ID",
                    ]
                    .map(str::to_owned),
                );
            }
            AccountProvider::Devin => {
                let data = if cfg!(windows) {
                    root.join("AppData/Roaming")
                } else {
                    root.join("data")
                };
                private_file(&data.join("devin/credentials.toml"), credential.as_bytes())?;
                store::directory(&root.join("config"))?;
                env.set
                    .insert("XDG_DATA_HOME".into(), data.to_string_lossy().into_owned());
                env.set.insert(
                    "XDG_CONFIG_HOME".into(),
                    root.join("config").to_string_lossy().into_owned(),
                );
                env.remove.push("DEVIN_API_KEY".into());
            }
            AccountProvider::Claude => {
                private_file(&root.join(".credentials.json"), credential.as_bytes())?;
                env.set.insert(
                    "CLAUDE_CONFIG_DIR".into(),
                    root.to_string_lossy().into_owned(),
                );
                env.remove.extend(
                    [
                        "ANTHROPIC_API_KEY",
                        "ANTHROPIC_AUTH_TOKEN",
                        "CLAUDE_CODE_OAUTH_TOKEN",
                        "ANTHROPIC_BASE_URL",
                        "CLAUDE_CODE_USE_BEDROCK",
                        "CLAUDE_CODE_USE_VERTEX",
                        "CLAUDE_CODE_USE_FOUNDRY",
                    ]
                    .map(str::to_owned),
                );
            }
            AccountProvider::Opencode => {
                private_file(&root.join("data/opencode/auth.json"), credential.as_bytes())?;
                store::directory(&root.join("config"))?;
                store::directory(&root.join("state"))?;
                store::directory(&root.join("cache"))?;
                for (key, subdir) in [
                    ("XDG_DATA_HOME", "data"),
                    ("XDG_CONFIG_HOME", "config"),
                    ("XDG_STATE_HOME", "state"),
                    ("XDG_CACHE_HOME", "cache"),
                ] {
                    env.set
                        .insert(key.into(), root.join(subdir).to_string_lossy().into_owned());
                }
                env.remove.extend(
                    [
                        "OPENCODE_AUTH_CONTENT",
                        "OPENCODE_CONFIG",
                        "OPENCODE_CONFIG_CONTENT",
                        "OPENCODE_CONFIG_DIR",
                        "OPENCODE_API_KEY",
                        "OPENAI_API_KEY",
                        "ANTHROPIC_API_KEY",
                        "ANTHROPIC_AUTH_TOKEN",
                        "GOOGLE_API_KEY",
                        "GEMINI_API_KEY",
                        "AWS_PROFILE",
                        "AWS_ACCESS_KEY_ID",
                        "AWS_SECRET_ACCESS_KEY",
                        "AWS_SESSION_TOKEN",
                        "GOOGLE_APPLICATION_CREDENTIALS",
                    ]
                    .map(str::to_owned),
                );
            }
            _ => unreachable!(),
        }
        Ok(env)
    }

    /// Delete a validated managed subtree, refusing a linked account directory.
    fn remove(&self, id: &str) -> Result<(), ProviderAccountError> {
        if !valid_id(id) {
            return Err(ProviderAccountError::InvalidSettings);
        }
        store::reject_link(&self.root)?;
        let dir = self.root.join(id);
        store::reject_link(&dir)?;
        match fs::remove_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ProviderAccountError::StoreFailed),
        }
    }

    /// Delegate bounded read-only requests; no login, prompt or subprocess except Codex account RPC.
    fn usage(
        &self,
        provider: AccountProvider,
        account: Option<ProviderAccount>,
        credential: Option<String>,
    ) -> AccountFuture<'_> {
        Box::pin(usage::read(self, provider, account, credential))
    }
}

#[cfg(all(test, unix))]
mod browser_tests {
    use super::*;
    /// Spawn a POSIX shell script without relying on PATH-resolved helper binaries.
    fn shell_script(script: &str) -> std::process::Child {
        use std::process::{Command, Stdio};
        Command::new("/bin/sh")
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("POSIX /bin/sh must exist for browser launcher test")
    }
    #[test]
    /// Synthetic launchers report failure without opening a browser or terminating a long-lived app.
    fn browser_dispatch_is_bounded_and_reports_failure() {
        use std::time::{Duration, Instant};
        assert!(wait_browser_launcher(shell_script("exit 0"), Duration::from_secs(1)).is_ok());
        assert_eq!(
            wait_browser_launcher(shell_script("exit 1"), Duration::from_secs(1)),
            Err(ProviderAccountError::RequestFailed)
        );
        let started = Instant::now();
        assert!(wait_browser_launcher(shell_script("sleep 2"), Duration::from_millis(1)).is_ok());
        assert!(started.elapsed() < Duration::from_millis(150));
    }
}
