//! Provider account settings contain references and measured quotas, never stored secrets.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AccountProvider {
    Codex,
    Claude,
    Opencode,
    Devin,
    Gemini,
    Antigravity,
    OpencodeGo,
    Minimax,
    Grok,
    Cursor,
    Glm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AccountHost {
    Local,
    Wsl { distribution: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccount {
    pub id: String,
    pub revision: u32,
    pub provider: AccountProvider,
    pub host: AccountHost,
    pub name: String,
    /// Trusted provider endpoint; credentials are never sent to user-defined hosts.
    pub endpoint: String,
    /// Gemini Code Assist project, when explicitly configured.
    pub project: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountSelection {
    pub provider: AccountProvider,
    pub host: AccountHost,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountSettings {
    pub accounts: Vec<ProviderAccount>,
    pub selections: Vec<AccountSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountState {
    pub account: ProviderAccount,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountSnapshot {
    pub accounts: Vec<AccountState>,
    pub selections: Vec<AccountSelection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AccountReason {
    WslUnsupported,
    PrivateFilesUnsupported,
    AdapterUnsupported,
    MissingCredential,
    LoginRequired,
    MissingProject,
    RefreshRequired,
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ProviderAccountError {
    InvalidSettings,
    NotFound,
    StoreFailed,
    CredentialStoreFailed,
    Unsupported { reason: AccountReason },
    RequestFailed,
    Unauthorized,
    RateLimited,
    InvalidResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountQuota {
    pub label: String,
    pub used_percent: f64,
    /// Provider-reported reset value; no duration is inferred.
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccountUsage {
    pub quotas: Vec<AccountQuota>,
    pub received_ms: f64,
    pub unavailable_reason: Option<AccountReason>,
}

/// Generate the separate account IPC contract without changing the AI preset enum.
#[cfg(feature = "dev-tools")]
pub fn typescript() -> String {
    let cfg = ts_rs::Config::default();
    let declarations = [
        AccountProvider::decl(&cfg),
        AccountHost::decl(&cfg),
        ProviderAccount::decl(&cfg),
        AccountSelection::decl(&cfg),
        AccountSettings::decl(&cfg),
        AccountState::decl(&cfg),
        AccountSnapshot::decl(&cfg),
        AccountReason::decl(&cfg),
        ProviderAccountError::decl(&cfg),
        AccountQuota::decl(&cfg),
        ProviderAccountUsage::decl(&cfg),
    ];
    let mut out = "// Generated from src-tauri/src/contracts/provider_accounts.rs. Run export-provider-account-contracts.\n".to_owned();
    for declaration in declarations {
        out.push_str("export ");
        out.push_str(&declaration);
        out.push('\n');
    }
    out.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
