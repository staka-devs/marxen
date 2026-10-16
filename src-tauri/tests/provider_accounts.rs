//! Synthetic fixtures never read host credential values or run installed provider CLIs.
use marxen_lib::{
    application::provider_accounts::*, contracts::provider_accounts::*,
    domain::provider_accounts::*, infrastructure::provider_accounts::*,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

#[derive(Default)]
struct MemoryStore {
    settings: Mutex<AccountSettings>,
    fail: AtomicBool,
    next: AtomicU64,
}
impl ProviderAccountStore for MemoryStore {
    /// Clone only fixture metadata.
    fn load(&self) -> Result<AccountSettings, ProviderAccountError> {
        Ok(self.settings.lock().unwrap().clone())
    }
    /// Simulate durable-write failure before replacing fixture metadata.
    fn save(&self, value: &AccountSettings) -> Result<(), ProviderAccountError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(ProviderAccountError::StoreFailed);
        }
        *self.settings.lock().unwrap() = value.clone();
        Ok(())
    }
    /// Deterministic IDs keep fixture assertions independent of host randomness.
    fn issue_id(&self) -> Result<String, ProviderAccountError> {
        Ok(format!(
            "{:032x}",
            self.next.fetch_add(1, Ordering::SeqCst) + 1
        ))
    }
}
#[derive(Default)]
struct Secrets {
    values: Mutex<HashMap<String, String>>,
    fail: AtomicBool,
}
impl ProviderAccountCredentials for Secrets {
    /// Read only fixture secrets, never the OS store.
    fn get(&self, id: &str) -> Result<Option<String>, ProviderAccountError> {
        Ok(self.values.lock().unwrap().get(id).cloned())
    }
    /// Fail before mutation when testing the credential-store boundary.
    fn set(&self, id: &str, secret: &str) -> Result<(), ProviderAccountError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(ProviderAccountError::CredentialStoreFailed);
        }
        self.values.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    /// Delete just the requested fixture slot.
    fn delete(&self, id: &str) -> Result<(), ProviderAccountError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(ProviderAccountError::CredentialStoreFailed);
        }
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}

/// Construct isolated real metadata/config paths with an in-memory secret store.
fn fixture() -> (
    tempfile::TempDir,
    ProviderAccountService,
    Arc<MemoryStore>,
    Arc<Secrets>,
) {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    let secrets = Arc::new(Secrets::default());
    let service = ProviderAccountService {
        store: store.clone(),
        credentials: secrets.clone(),
        runtime: Arc::new(NativeAccountRuntime {
            root: temp.path().join("managed"),
            home: temp.path().join("host-home"),
        }),
        mutation: Mutex::new(()),
    };
    (temp, service, store, secrets)
}

/// Build an unsaved account with a trusted endpoint, preserving its explicit host scope.
fn account(provider: AccountProvider, host: AccountHost) -> ProviderAccount {
    ProviderAccount {
        id: String::new(),
        revision: 0,
        provider,
        host,
        name: "work".into(),
        endpoint: endpoints(provider)[0].into(),
        project: String::new(),
    }
}

/// Supply provider-shaped synthetic secrets without any actual account or token.
fn credential(provider: AccountProvider) -> String {
    match provider {
        AccountProvider::Codex => {
            json!({"tokens":{"access_token":"fixture-codex-secret"}}).to_string()
        }
        AccountProvider::Claude => {
            json!({"claudeAiOauth":{"accessToken":"fixture-claude-secret"}}).to_string()
        }
        AccountProvider::Opencode => {
            json!({"openai":{"type":"api","key":"fixture-opencode-secret"}}).to_string()
        }
        AccountProvider::Gemini => json!({"access_token":"fixture-gemini-secret"}).to_string(),
        AccountProvider::Grok => {
            json!({"accessToken":"fixture-grok-secret","userId":"fixture-user"}).to_string()
        }
        AccountProvider::Devin | AccountProvider::Antigravity => {
            json!({"token":"fixture-secret"}).to_string()
        }
        _ => "fixture-secret".into(),
    }
}

#[test]
/// Every provider has independent secret slots, persisted selection and scoped deletion.
fn all_provider_accounts_save_select_delete_without_leaking_secrets() {
    let (_temp, service, _store, secrets) = fixture();
    for provider in PROVIDERS {
        service
            .save(
                account(provider, AccountHost::Local),
                Some(credential(provider)),
            )
            .unwrap();
        let first = service
            .snapshot()
            .unwrap()
            .accounts
            .into_iter()
            .find(|a| a.account.provider == provider)
            .unwrap();
        assert!(first.has_credential);
        service
            .select(AccountSelection {
                provider,
                host: AccountHost::Local,
                account_id: Some(first.account.id.clone()),
            })
            .unwrap();
    }
    let snapshot = service.snapshot().unwrap();
    assert_eq!(snapshot.accounts.len(), 11);
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialized.contains("fixture-"));
    let deleted = &snapshot.accounts[0].account;
    service.delete(&deleted.id).unwrap();
    assert_eq!(service.snapshot().unwrap().accounts.len(), 10);
    assert_eq!(secrets.values.lock().unwrap().len(), 10);
    assert!(service
        .snapshot()
        .unwrap()
        .selections
        .iter()
        .find(|s| s.provider == deleted.provider)
        .unwrap()
        .account_id
        .is_none());
}

#[test]
/// Cross-provider and cross-host selections cannot leak into a local launch.
fn host_and_provider_selection_are_strict() {
    let (_temp, service, _store, _secrets) = fixture();
    let wsl = AccountHost::Wsl {
        distribution: "Ubuntu-24.04".into(),
    };
    service
        .save(
            account(AccountProvider::Codex, wsl.clone()),
            Some(credential(AccountProvider::Codex)),
        )
        .unwrap();
    let id = service.snapshot().unwrap().accounts[0].account.id.clone();
    for (provider, host) in [
        (AccountProvider::Claude, wsl.clone()),
        (AccountProvider::Codex, AccountHost::Local),
    ] {
        assert!(service
            .select(AccountSelection {
                provider,
                host,
                account_id: Some(id.clone())
            })
            .is_err());
    }
    service
        .select(AccountSelection {
            provider: AccountProvider::Codex,
            host: wsl.clone(),
            account_id: Some(id),
        })
        .unwrap();
    assert!(service
        .launch_environment(AccountProvider::Codex, &AccountHost::Local)
        .unwrap()
        .set
        .is_empty());
    assert!(matches!(
        service.launch_environment(AccountProvider::Codex, &wsl),
        Err(ProviderAccountError::Unsupported {
            reason: AccountReason::WslUnsupported
        })
    ));
}

#[test]
/// Metadata failures restore prior secrets; OS-store failures never publish records.
fn failures_keep_records_and_credentials_consistent() {
    let (_temp, service, store, secrets) = fixture();
    store.fail.store(true, Ordering::SeqCst);
    assert!(service
        .save(
            account(AccountProvider::Cursor, AccountHost::Local),
            Some("fixture-old".into())
        )
        .is_err());
    assert!(secrets.values.lock().unwrap().is_empty());
    store.fail.store(false, Ordering::SeqCst);
    service
        .save(
            account(AccountProvider::Cursor, AccountHost::Local),
            Some("fixture-old".into()),
        )
        .unwrap();
    let saved = service.snapshot().unwrap().accounts[0].account.clone();
    store.fail.store(true, Ordering::SeqCst);
    assert!(service
        .save(saved.clone(), Some("fixture-new".into()))
        .is_err());
    assert_eq!(
        secrets.get(&saved.id).unwrap().as_deref(),
        Some("fixture-old")
    );
    assert!(service.delete(&saved.id).is_err());
    assert_eq!(
        secrets.get(&saved.id).unwrap().as_deref(),
        Some("fixture-old")
    );
    assert_eq!(service.snapshot().unwrap().accounts.len(), 1);
    store.fail.store(false, Ordering::SeqCst);
    secrets.fail.store(true, Ordering::SeqCst);
    assert!(service
        .save(
            account(AccountProvider::Minimax, AccountHost::Local),
            Some("fixture-key".into())
        )
        .is_err());
    assert_eq!(service.snapshot().unwrap().accounts.len(), 1);
}

#[test]
/// Missing managed credentials are a failure, never an implicit system-account fallback.
fn missing_credential_and_unknown_accounts_do_not_fallback() {
    let (_temp, service, _store, _secrets) = fixture();
    service
        .save(account(AccountProvider::Codex, AccountHost::Local), None)
        .unwrap();
    let saved = service.snapshot().unwrap().accounts[0].account.clone();
    service
        .select(AccountSelection {
            provider: saved.provider,
            host: saved.host.clone(),
            account_id: Some(saved.id),
        })
        .unwrap();
    assert!(matches!(
        service.launch_environment(saved.provider, &saved.host),
        Err(ProviderAccountError::Unsupported {
            reason: AccountReason::MissingCredential
        })
    ));
    let mut invented = account(AccountProvider::Codex, AccountHost::Local);
    invented.id = "a".repeat(32);
    assert_eq!(
        service.save(invented, None),
        Err(ProviderAccountError::NotFound)
    );
}

#[test]
/// Private CLI files cannot overwrite defaults; revisions discriminate subsequent sessions.
#[cfg(unix)]
fn isolated_launch_files_are_private_and_revision_bound() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, service, _store, _secrets) = fixture();
    let host = temp.path().join("host-home");
    std::fs::create_dir_all(host.join(".codex")).unwrap();
    std::fs::write(host.join(".codex/auth.json"), "host-default-sentinel").unwrap();
    for provider in [
        AccountProvider::Codex,
        AccountProvider::Claude,
        AccountProvider::Opencode,
    ] {
        if provider == AccountProvider::Claude && !cfg!(target_os = "linux") {
            continue;
        }
        service
            .save(
                account(provider, AccountHost::Local),
                Some(credential(provider)),
            )
            .unwrap();
        let saved = service
            .snapshot()
            .unwrap()
            .accounts
            .into_iter()
            .find(|a| a.account.provider == provider)
            .unwrap()
            .account;
        service
            .select(AccountSelection {
                provider,
                host: AccountHost::Local,
                account_id: Some(saved.id.clone()),
            })
            .unwrap();
        let env = service
            .launch_environment(provider, &AccountHost::Local)
            .unwrap();
        let root = std::path::Path::new(env.set.get("HOME").unwrap());
        assert!(root.starts_with(temp.path().join("managed")));
        assert_ne!(root, host);
        let path = root.join(match provider {
            AccountProvider::Codex => "auth.json",
            AccountProvider::Claude => ".credentials.json",
            _ => "data/opencode/auth.json",
        });
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            credential(provider)
        );
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(env
            .remove
            .iter()
            .any(|k| k == "OPENAI_API_KEY" || k == "ANTHROPIC_API_KEY"));
        service.save(saved.clone(), None).unwrap();
        let next = service
            .launch_environment(provider, &AccountHost::Local)
            .unwrap();
        assert_ne!(env.identity, next.identity);
        service
            .select(AccountSelection {
                provider,
                host: AccountHost::Local,
                account_id: None,
            })
            .unwrap();
        let system = service
            .launch_environment(provider, &AccountHost::Local)
            .unwrap();
        assert!(system.set.is_empty());
        assert!(system.remove.is_empty());
        service.delete(&saved.id).unwrap();
        assert!(!root.exists());
    }
    assert_eq!(
        std::fs::read_to_string(host.join(".codex/auth.json")).unwrap(),
        "host-default-sentinel"
    );
}

#[test]
/// Real atomic storage rejects corrupt documents and never persists secret contents.
fn native_metadata_roundtrip_and_corruption_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let store = NativeAccountStore {
        root: temp.path().join("accounts"),
    };
    assert!(store.load().unwrap().accounts.is_empty());
    let mut saved = account(AccountProvider::Minimax, AccountHost::Local);
    saved.id = store.issue_id().unwrap();
    saved.revision = 1;
    let settings = AccountSettings {
        accounts: vec![saved],
        selections: vec![],
    };
    store.save(&settings).unwrap();
    assert_eq!(store.load().unwrap(), settings);
    std::fs::write(store.root.join("settings.json"), b"broken JSON secret").unwrap();
    assert_eq!(store.load(), Err(ProviderAccountError::InvalidResponse));
}

#[test]
/// Each supported adapter parses measured fixture values and preserves missing reset times.
fn usage_fixtures_preserve_provider_measurements() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/provider-accounts/usage.json"
    ))
    .unwrap();
    for (provider, key, count, first) in [
        (AccountProvider::Claude, "claude", 2, 0.0),
        (AccountProvider::Gemini, "gemini", 2, 25.0),
        (AccountProvider::OpencodeGo, "opencode_go", 3, 12.0),
        (AccountProvider::Minimax, "minimax", 2, 20.0),
        (AccountProvider::Grok, "grok", 1, 18.0),
        (AccountProvider::Cursor, "cursor", 2, 23.5),
        (AccountProvider::Glm, "glm", 2, 12.5),
    ] {
        let parsed = parse_usage(provider, &fixtures[key]);
        assert_eq!(parsed.len(), count, "{key}");
        assert_eq!(parsed[0].used_percent, first, "{key}");
        assert!(!parsed[0].label.is_empty());
    }
    assert!(parse_usage(AccountProvider::Claude, &fixtures["claude"])[1]
        .resets_at
        .is_none());
    for provider in PROVIDERS {
        assert!(parse_usage(provider, &json!({"input_tokens":10,"output_tokens":20})).is_empty());
    }
    assert!(parse_usage(
        AccountProvider::Gemini,
        &json!({"buckets":[{"remainingFraction":2}]})
    )
    .is_empty());
    assert!(parse_usage(
        AccountProvider::Cursor,
        &json!({"individualUsage":{"plan":{"totalPercentUsed":-1}}})
    )
    .is_empty());
    assert!(parse_usage(AccountProvider::Minimax,&json!({"base_resp":{"status_code":1004},"model_remains":fixtures["minimax"]["model_remains"]})).is_empty());
}

#[test]
/// Untrusted endpoints, identifiers and malformed credentials fail before storage or networking.
fn rejects_untrusted_configuration_without_echoing_input() {
    let (_temp, service, _store, secrets) = fixture();
    for endpoint in [
        "https://api.z.ai.evil.test",
        "http://api.z.ai",
        "https://user:fixture-secret@api.z.ai",
        "https://api.z.ai:8443",
        "https://api.z.ai?key=fixture-secret",
    ] {
        let mut bad = account(AccountProvider::Glm, AccountHost::Local);
        bad.endpoint = endpoint.into();
        let error = service
            .save(bad, Some("fixture-secret".into()))
            .unwrap_err();
        assert_eq!(error, ProviderAccountError::InvalidSettings);
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("fixture-secret"));
    }
    for provider in PROVIDERS {
        assert!(validate_credential(provider, "").is_err());
    }
    assert!(validate_credential(AccountProvider::Codex, "{\"bad\":\"fixture-secret\"}").is_err());
    assert!(validate_credential(
        AccountProvider::Cursor,
        "Cookie: fixture\r\nHeader: injected"
    )
    .is_err());
    assert!(secrets.values.lock().unwrap().is_empty());
}

#[test]
/// Linked runtime directories cannot write credentials into another account or host path.
#[cfg(unix)]
fn rejects_symlink_runtime_escape() {
    let (temp, service, _store, _secrets) = fixture();
    service
        .save(
            account(AccountProvider::Codex, AccountHost::Local),
            Some(credential(AccountProvider::Codex)),
        )
        .unwrap();
    let saved = service.snapshot().unwrap().accounts[0].account.clone();
    service
        .select(AccountSelection {
            provider: saved.provider,
            host: saved.host.clone(),
            account_id: Some(saved.id.clone()),
        })
        .unwrap();
    let root = temp.path().join("managed");
    std::fs::create_dir(&root).unwrap();
    let outside = temp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(saved.id)).unwrap();
    assert!(service
        .launch_environment(saved.provider, &saved.host)
        .is_err());
    assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
}

#[tokio::test]
/// Unsupported adapters return reasons without launching providers or making network requests.
async fn unsupported_usage_is_truthful_without_live_accounts() {
    let (_temp, service, _store, _secrets) = fixture();
    for provider in [
        AccountProvider::Devin,
        AccountProvider::Antigravity,
        AccountProvider::Opencode,
    ] {
        let usage = service.usage(provider, &AccountHost::Local).await.unwrap();
        assert!(usage.quotas.is_empty());
        assert_eq!(
            usage.unavailable_reason,
            Some(AccountReason::AdapterUnsupported)
        );
    }
    let wsl = AccountHost::Wsl {
        distribution: "Ubuntu".into(),
    };
    assert!(service.usage(AccountProvider::Claude, &wsl).await.is_err());
}

#[test]
#[cfg(unix)]
/// Two accounts of one provider keep distinct credentials, environments and deletion scope.
fn same_provider_accounts_keep_independent_credentials() {
    let (temp, service, _store, _secrets) = fixture();
    let mut ids = Vec::new();
    for marker in ["fixture-first", "fixture-second"] {
        let mut draft = account(AccountProvider::Codex, AccountHost::Local);
        draft.name = marker.into();
        service
            .save(
                draft,
                Some(json!({"tokens":{"access_token":marker}}).to_string()),
            )
            .unwrap();
        let saved = service
            .snapshot()
            .unwrap()
            .accounts
            .into_iter()
            .find(|a| a.account.name == marker)
            .unwrap()
            .account;
        service
            .select(AccountSelection {
                provider: saved.provider,
                host: saved.host.clone(),
                account_id: Some(saved.id.clone()),
            })
            .unwrap();
        let env = service
            .launch_environment(saved.provider, &saved.host)
            .unwrap();
        let auth = std::path::Path::new(env.set.get("CODEX_HOME").unwrap()).join("auth.json");
        let data: Value = serde_json::from_slice(&std::fs::read(auth).unwrap()).unwrap();
        assert_eq!(data["tokens"]["access_token"], marker);
        ids.push(saved.id);
    }
    service.delete(&ids[0]).unwrap();
    let state = service.snapshot().unwrap();
    assert_eq!(state.accounts.len(), 1);
    assert_eq!(
        state.selections[0].account_id.as_deref(),
        Some(ids[1].as_str())
    );
    assert!(!temp.path().join("managed").join(&ids[0]).exists());
    assert!(temp.path().join("managed").join(&ids[1]).exists());
}

#[test]
#[cfg(unix)]
/// The existing Codex RPC reader applies the chosen child environment without a real Codex process.
fn codex_account_rpc_receives_only_the_chosen_private_home() {
    use marxen_lib::{
        contracts::ai::AcpArgv, infrastructure::ai::account_usage::read_codex_with_environment,
    };
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("mock account.sh");
    let record = temp.path().join("account-home.txt");
    std::fs::write(&script,r#"printf '%s' "$CODEX_HOME" > "$1"
while IFS= read -r message; do
 case "$message" in
  *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
  *'account/rateLimits/read'*) printf '%s\n' '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":17}}}}' ;;
 esac
done
"#).unwrap();
    let mut environment = AccountLaunchEnvironment::default();
    environment
        .set
        .insert("CODEX_HOME".into(), "fixture-private-home".into());
    let argv = AcpArgv {
        command: "/bin/sh".into(),
        args: vec![
            script.to_string_lossy().into_owned(),
            record.to_string_lossy().into_owned(),
        ],
    };
    let quotas =
        read_codex_with_environment(&argv, std::time::Duration::from_secs(3), Some(&environment))
            .unwrap();
    assert_eq!(quotas[0].primary.as_ref().unwrap().used_percent, 17.0);
    assert_eq!(
        std::fs::read_to_string(record).unwrap(),
        "fixture-private-home"
    );
}

#[test]
#[cfg(unix)]
/// An intermediate symlink cannot redirect an OpenCode credential write outside its private home.
fn rejects_nested_symlink_runtime_escape() {
    let (temp, service, _store, _secrets) = fixture();
    service
        .save(
            account(AccountProvider::Opencode, AccountHost::Local),
            Some(credential(AccountProvider::Opencode)),
        )
        .unwrap();
    let saved = service.snapshot().unwrap().accounts[0].account.clone();
    service
        .select(AccountSelection {
            provider: saved.provider,
            host: saved.host.clone(),
            account_id: Some(saved.id.clone()),
        })
        .unwrap();
    let revision = temp.path().join("managed").join(&saved.id).join("1");
    std::fs::create_dir_all(&revision).unwrap();
    let outside = temp.path().join("host-default");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, revision.join("data")).unwrap();
    assert!(service
        .launch_environment(saved.provider, &saved.host)
        .is_err());
    assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
}
