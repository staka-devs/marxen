//! Account identity, trusted destinations and response validation are pure policy.
use crate::contracts::provider_accounts::*;
use serde_json::Value;

pub const PROVIDERS: [AccountProvider; 11] = [
    AccountProvider::Codex,
    AccountProvider::Claude,
    AccountProvider::Opencode,
    AccountProvider::Devin,
    AccountProvider::Gemini,
    AccountProvider::Antigravity,
    AccountProvider::OpencodeGo,
    AccountProvider::Minimax,
    AccountProvider::Grok,
    AccountProvider::Cursor,
    AccountProvider::Glm,
];

/// Permit only stable account identifiers issued by Rust, never paths or keyring selectors.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Keep metadata bounded and prevent control characters or hidden multiline configuration.
fn text(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.chars().any(char::is_control)
}

/// WSL names are stored as data; no local adapter resolves or executes them.
pub fn validate_host(host: &AccountHost) -> Result<(), ProviderAccountError> {
    if let AccountHost::Wsl { distribution } = host {
        if distribution.is_empty() || !text(distribution, 128) || distribution.starts_with('-') {
            return Err(ProviderAccountError::InvalidSettings);
        }
    }
    Ok(())
}

/// Open only the provider's fixed public setup page, never a user-supplied URL or credential.
pub fn setup_url(provider: AccountProvider) -> &'static str {
    match provider {
        AccountProvider::Codex => "https://developers.openai.com/codex/auth/",
        AccountProvider::Claude => "https://code.claude.com/docs/en/authentication",
        AccountProvider::Opencode => "https://opencode.ai/docs/providers/",
        AccountProvider::Devin => "https://docs.devin.ai/cli/enterprise/devin-auth",
        AccountProvider::Gemini => "https://geminicli.com/docs/get-started/authentication/",
        AccountProvider::Antigravity => "https://antigravity.google/docs/home",
        AccountProvider::OpencodeGo => "https://opencode.ai/docs/go/",
        AccountProvider::Minimax => "https://platform.minimax.io/docs/token-plan/faq",
        AccountProvider::Grok => "https://grok.com/",
        AccountProvider::Cursor => "https://cursor.com/dashboard",
        AccountProvider::Glm => "https://docs.z.ai/devpack/overview",
    }
}

/// Enumerate fixed destinations for usage and refresh credentials, including regional plans.
pub fn endpoints(provider: AccountProvider) -> &'static [&'static str] {
    match provider {
        AccountProvider::Codex => &["https://chatgpt.com"],
        AccountProvider::Claude => &["https://api.anthropic.com"],
        AccountProvider::Opencode | AccountProvider::OpencodeGo => &["https://opencode.ai"],
        AccountProvider::Devin => &["https://api.devin.ai"],
        AccountProvider::Gemini => &["https://cloudcode-pa.googleapis.com"],
        AccountProvider::Antigravity => &["https://antigravity.google"],
        AccountProvider::Minimax => &["https://www.minimax.io", "https://www.minimaxi.com"],
        AccountProvider::Grok => &["https://cli-chat-proxy.grok.com"],
        AccountProvider::Cursor => &["https://cursor.com"],
        AccountProvider::Glm => &[
            "https://api.z.ai",
            "https://open.bigmodel.cn",
            "https://dev.bigmodel.cn",
        ],
    }
}

/// Validate all persisted fields before a secret is read, replaced or deleted.
pub fn validate_account(account: &ProviderAccount) -> Result<(), ProviderAccountError> {
    validate_host(&account.host)?;
    if account.revision == 0
        || !valid_id(&account.id)
        || account.name.trim().is_empty()
        || !text(&account.name, 100)
        || !text(&account.project, 200)
        || !endpoints(account.provider).contains(&account.endpoint.as_str())
    {
        return Err(ProviderAccountError::InvalidSettings);
    }
    if !account
        .project
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-_:./".contains(&b))
    {
        return Err(ProviderAccountError::InvalidSettings);
    }
    if !text(&account.group_id, 128)
        || !account
            .group_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        || (!account.workspace_id.is_empty() && !valid_workspace(&account.workspace_id))
        || account.models.len() > 32
        || account
            .models
            .iter()
            .any(|model| model.is_empty() || !text(model, 160))
    {
        return Err(ProviderAccountError::InvalidSettings);
    }
    Ok(())
}

/// Reject corrupt settings rather than silently replacing accounts or changing selection.
pub fn validate_settings(settings: &AccountSettings) -> Result<(), ProviderAccountError> {
    if settings.accounts.len() > 128 || settings.selections.len() > 128 {
        return Err(ProviderAccountError::InvalidSettings);
    }
    for (i, account) in settings.accounts.iter().enumerate() {
        validate_account(account)?;
        if settings.accounts[..i]
            .iter()
            .any(|other| other.id == account.id)
        {
            return Err(ProviderAccountError::InvalidSettings);
        }
    }
    for (i, selection) in settings.selections.iter().enumerate() {
        validate_host(&selection.host)?;
        if settings.selections[..i]
            .iter()
            .any(|other| other.provider == selection.provider && other.host == selection.host)
            || selection.account_id.as_ref().is_some_and(|id| {
                !settings.accounts.iter().any(|a| {
                    a.id == *id && a.provider == selection.provider && a.host == selection.host
                })
            })
        {
            return Err(ProviderAccountError::InvalidSettings);
        }
    }
    Ok(())
}

/// Validate user-supplied authentication without including its content in an error.
pub fn validate_credential(
    provider: AccountProvider,
    secret: &str,
) -> Result<(), ProviderAccountError> {
    if secret.is_empty() || secret.len() > 32768 || secret.contains('\0') {
        return Err(ProviderAccountError::InvalidSettings);
    }
    // The CLI owns TOML parsing; keep the bounded credentials file byte-for-byte.
    if provider == AccountProvider::Devin {
        return if secret.trim().is_empty() {
            Err(ProviderAccountError::InvalidSettings)
        } else {
            Ok(())
        };
    }
    if matches!(
        provider,
        AccountProvider::Minimax | AccountProvider::OpencodeGo
    ) {
        let value = web_secret(provider, secret)?;
        return if value.api_key.is_empty() && value.cookie.is_empty() {
            Err(ProviderAccountError::InvalidSettings)
        } else {
            Ok(())
        };
    }
    let json_required = matches!(
        provider,
        AccountProvider::Codex
            | AccountProvider::Claude
            | AccountProvider::Opencode
            | AccountProvider::Gemini
            | AccountProvider::Antigravity
            | AccountProvider::Grok
    );
    if json_required {
        let value: Value =
            serde_json::from_str(secret).map_err(|_| ProviderAccountError::InvalidSettings)?;
        if !value.is_object() || value.as_object().is_none_or(|o| o.is_empty()) {
            return Err(ProviderAccountError::InvalidSettings);
        }
        let valid = match provider {
            AccountProvider::Codex => {
                value
                    .get("OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                    || value
                        .pointer("/tokens/access_token")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
            }
            AccountProvider::Claude => value
                .pointer("/claudeAiOauth/accessToken")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty()),
            AccountProvider::Gemini => {
                value
                    .get("access_token")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                    || value
                        .get("refresh_token")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
            }
            AccountProvider::Grok => grok_login(&value)?.is_some(),
            _ => true,
        };
        if !valid {
            return Err(ProviderAccountError::InvalidSettings);
        }
    } else if secret.chars().any(char::is_control) {
        return Err(ProviderAccountError::InvalidSettings);
    }
    Ok(())
}

/// Add only finite measured percentages; invalid and absent values remain absent.
fn quota(quotas: &mut Vec<AccountQuota>, label: &str, percent: Option<f64>, reset: Option<&Value>) {
    if let Some(used_percent) = percent.filter(|p| p.is_finite() && (0.0..=100.0).contains(p)) {
        if label.is_empty() || !text(label, 160) {
            return;
        }
        let resets_at = reset
            .and_then(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .or_else(|| v.as_u64().map(|n| n.to_string()))
            })
            .filter(|s| text(s, 80));
        quotas.push(AccountQuota {
            label: label.into(),
            used_percent,
            resets_at,
        });
    }
}

/// Read a nonnegative finite measurement without coercing missing values to zero.
fn number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

/// Divide reported counts only when the provider reported a positive limit.
fn percent(used: Option<&Value>, limit: Option<&Value>) -> Option<f64> {
    let (used, limit) = (number(used)?, number(limit)?);
    (limit > 0.0).then_some(used / limit * 100.0)
}

/// Normalize each provider's actual response shape without treating tokens as account limits.
pub fn parse_usage(provider: AccountProvider, value: &Value) -> Vec<AccountQuota> {
    let mut quotas = Vec::new();
    match provider {
        AccountProvider::Claude => {
            for key in [
                "five_hour",
                "seven_day",
                "seven_day_sonnet",
                "seven_day_opus",
            ] {
                if let Some(v) = value.get(key) {
                    quota(
                        &mut quotas,
                        key,
                        number(v.get("utilization")),
                        v.get("resets_at"),
                    );
                }
            }
        }
        AccountProvider::Gemini => {
            if let Some(rows) = value.get("buckets").and_then(Value::as_array) {
                for row in rows.iter().take(64) {
                    quota(
                        &mut quotas,
                        row.get("modelId")
                            .and_then(Value::as_str)
                            .unwrap_or("quota"),
                        number(row.get("remainingFraction")).map(|p| (1.0 - p) * 100.0),
                        row.get("resetTime"),
                    );
                }
            }
        }
        AccountProvider::OpencodeGo => {
            for key in ["fiveHour", "week", "month"] {
                if let Some(row) = value.pointer("/access/meters").and_then(|v| v.get(key)) {
                    let amount = row
                        .get("usedMicroCents")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<u64>().ok());
                    let limit = row
                        .get("limitMicroCents")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<u64>().ok());
                    let p = amount.zip(limit).and_then(|(used, limit)| {
                        (limit > 0 && used <= limit).then_some(used as f64 / limit as f64 * 100.0)
                    });
                    quota(&mut quotas, key, p, row.get("resetsAt"));
                }
            }
            for key in ["rolling", "weekly", "monthly"] {
                if let Some(row) = value.get("usage").and_then(|v| v.get(key)) {
                    quota(
                        &mut quotas,
                        key,
                        number(row.get("percent")),
                        row.get("resetsAt"),
                    );
                }
            }
        }
        AccountProvider::Minimax => {
            if value
                .pointer("/base_resp/status_code")
                .and_then(Value::as_u64)
                .is_some_and(|code| code != 0)
            {
                return quotas;
            }
            if let Some(rows) = value.get("model_remains").and_then(Value::as_array) {
                for row in rows.iter().take(32) {
                    let name = row
                        .get("model_name")
                        .and_then(Value::as_str)
                        .unwrap_or("model");
                    for (field, window, reset) in [
                        ("current_interval_remaining_percent", "interval", "end_time"),
                        (
                            "current_weekly_remaining_percent",
                            "weekly",
                            "weekly_end_time",
                        ),
                    ] {
                        quota(
                            &mut quotas,
                            &format!("{name} / {window}"),
                            number(row.get(field)).map(|p| 100.0 - p),
                            row.get(reset),
                        );
                    }
                }
            }
        }
        AccountProvider::Glm => {
            if value.get("success").and_then(Value::as_bool) == Some(false) {
                return quotas;
            }
            if let Some(rows) = value.pointer("/data/limits").and_then(Value::as_array) {
                for row in rows.iter().take(32) {
                    let p = percent(row.get("currentValue"), row.get("usage"))
                        .or_else(|| number(row.get("percentage")));
                    let label = format!(
                        "{} / {} × {}",
                        row.get("type").and_then(Value::as_str).unwrap_or("quota"),
                        row.get("number").unwrap_or(&Value::Null),
                        row.get("unit").unwrap_or(&Value::Null)
                    );
                    quota(&mut quotas, &label, p, row.get("nextResetTime"));
                }
            }
        }
        AccountProvider::Grok => {
            let row = value.get("config").unwrap_or(value);
            quota(
                &mut quotas,
                "credits",
                number(row.get("creditUsagePercent")),
                row.pointer("/currentPeriod/end")
                    .or_else(|| row.get("billingPeriodEnd")),
            );
        }
        AccountProvider::Cursor => {
            if let Some(plan) = value.pointer("/individualUsage/plan") {
                quota(
                    &mut quotas,
                    "plan",
                    number(plan.get("totalPercentUsed"))
                        .or_else(|| percent(plan.get("used"), plan.get("limit"))),
                    value.get("billingCycleEnd"),
                );
            }
            if let Some(row) = value.pointer("/individualUsage/onDemand") {
                quota(
                    &mut quotas,
                    "onDemand",
                    percent(row.get("used"), row.get("limit")),
                    value.get("billingCycleEnd"),
                );
            }
        }
        _ => {}
    }
    quotas
}

/// Secrets remain an OS-store-only envelope and have no Debug or IPC response representation.
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebAccountSecret {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub cookie: String,
}

/// Restrict workspace selectors to the provider's established identifier formats.
pub fn valid_workspace(value: &str) -> bool {
    let Some((prefix, id)) = value.split_once('_') else {
        return false;
    };
    matches!(prefix, "org" | "wrk" | "wk")
        && !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Normalize a full Cookie header while preserving every cookie name and its exact value.
pub fn cookie_header(value: &str) -> Result<String, ProviderAccountError> {
    let value = value.trim();
    let value = if value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cookie:"))
    {
        &value[7..]
    } else {
        value
    };
    let value = value.trim();
    if value.is_empty()
        || value.len() > 24576
        || !value.bytes().all(|b| (32..127).contains(&b))
        || value.split(';').any(|pair| {
            let Some((name, value)) = pair.trim().split_once('=') else {
                return true;
            };
            name.is_empty()
                || value.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        })
    {
        return Err(ProviderAccountError::InvalidSettings);
    }
    Ok(value.to_owned())
}

/// Read the strict OS-store envelope; raw API-key and arbitrary JSON formats are rejected.
pub fn web_secret(
    provider: AccountProvider,
    secret: &str,
) -> Result<WebAccountSecret, ProviderAccountError> {
    let value: WebAccountSecret =
        serde_json::from_str(secret).map_err(|_| ProviderAccountError::InvalidSettings)?;
    if value.api_key.len() > 8192 || value.api_key.chars().any(char::is_control) {
        return Err(ProviderAccountError::InvalidSettings);
    }
    if !value.cookie.is_empty() {
        let cookie = cookie_header(&value.cookie)?;
        if provider == AccountProvider::OpencodeGo
            && !cookie.split(';').any(|pair| {
                pair.trim().split_once('=').is_some_and(|(name, _)| {
                    matches!(name, "auth" | "__Host-auth" | "__Host-console_session")
                })
            })
        {
            return Err(ProviderAccountError::InvalidSettings);
        }
    }
    Ok(value)
}

/// Merge write-only input in Rust so replacing one secret never clears its untouched sibling.
pub fn merge_web_secret(
    provider: AccountProvider,
    old: Option<&str>,
    patch: AccountCredentialPatch,
) -> Result<Option<String>, ProviderAccountError> {
    if patch.secret.is_some()
        || !matches!(
            provider,
            AccountProvider::Minimax | AccountProvider::OpencodeGo
        )
    {
        return Err(ProviderAccountError::InvalidSettings);
    }
    let mut value = old
        .map(|s| web_secret(provider, s))
        .transpose()?
        .unwrap_or_default();
    if let Some(api_key) = patch.api_key {
        value.api_key = api_key;
    }
    if let Some(cookie) = patch.cookie {
        value.cookie = if cookie.is_empty() {
            String::new()
        } else {
            cookie_header(&cookie)?
        };
    }
    if value.api_key.is_empty() && value.cookie.is_empty() {
        return Ok(None);
    }
    let encoded =
        serde_json::to_string(&value).map_err(|_| ProviderAccountError::InvalidSettings)?;
    if encoded.len() > 32768 {
        return Err(ProviderAccountError::InvalidSettings);
    }
    web_secret(provider, &encoded)?;
    Ok(Some(encoded))
}

/// Read only first-party Grok access-token records; unrelated IdP credentials never reach xAI.
pub fn grok_login(value: &Value) -> Result<Option<Value>, ProviderAccountError> {
    let Some(records) = value.as_object() else {
        return Err(ProviderAccountError::InvalidResponse);
    };
    let scopes = std::iter::once("https://auth.x.ai").chain(
        records
            .keys()
            .map(String::as_str)
            .filter(|key| key.starts_with("https://auth.x.ai::")),
    );
    for scope in scopes {
        let Some(record) = records.get(scope) else {
            continue;
        };
        if record.get("auth_mode").and_then(Value::as_str) == Some("api_key")
            || record
                .get("oidc_issuer")
                .and_then(Value::as_str)
                .is_some_and(|issuer| issuer != "https://auth.x.ai")
        {
            continue;
        }
        let key = record
            .get("key")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 32768 && !s.chars().any(char::is_control))
            .ok_or(ProviderAccountError::InvalidResponse)?;
        let user = record
            .get("user_id")
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 256 && !s.chars().any(char::is_control));
        return Ok(Some(serde_json::json!({"accessToken":key,"userId":user})));
    }
    Ok(None)
}

/// Form the verified Cursor session cookie from a CLI/IDE JWT without claiming signature validation.
pub fn cursor_cookie(access: &str, now_seconds: f64) -> Result<String, ProviderAccountError> {
    use base64::Engine;
    if access.len() > 32768
        || !access
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.=".contains(&b))
    {
        return Err(ProviderAccountError::InvalidResponse);
    }
    let mut parts = access.split('.');
    let _header = parts.next();
    let payload = parts.next().ok_or(ProviderAccountError::InvalidResponse)?;
    if parts.next().is_none() || parts.next().is_some() {
        return Err(ProviderAccountError::InvalidResponse);
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| ProviderAccountError::InvalidResponse)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| ProviderAccountError::InvalidResponse)?;
    let subject = value
        .get("sub")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        .ok_or(ProviderAccountError::InvalidResponse)?;
    if value.get("exp").is_some_and(|v| {
        v.as_f64()
            .is_none_or(|exp| !exp.is_finite() || exp <= now_seconds)
    }) {
        return Err(ProviderAccountError::Unauthorized);
    }
    let subject = subject
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<Vec<_>>()
        .join("");
    Ok(format!("WorkosCursorSessionToken={subject}%3A%3A{access}"))
}

/// Apply exactly one typed credential shape per provider without retaining a superseded save API.
pub fn merge_account_secret(
    provider: AccountProvider,
    old: Option<&str>,
    patch: AccountCredentialPatch,
) -> Result<Option<String>, ProviderAccountError> {
    if matches!(
        provider,
        AccountProvider::Minimax | AccountProvider::OpencodeGo
    ) {
        return merge_web_secret(provider, old, patch);
    }
    if patch.api_key.is_some() || patch.cookie.is_some() {
        return Err(ProviderAccountError::InvalidSettings);
    }
    match patch.secret {
        None => Ok(old.map(str::to_owned)),
        Some(value) if value.is_empty() => Ok(None),
        Some(value) => {
            validate_credential(provider, &value)?;
            Ok(Some(value))
        }
    }
}

/// Extract bounded workspace IDs from authenticated console SSR records or workspace links.
pub fn console_workspaces(body: &str) -> Vec<String> {
    let pattern=regex::Regex::new(r#"(?:\bid["']?\s*:\s*["']|/(?:console|workspace)/)((?:org|wrk|wk)_[A-Za-z0-9]+)(?:["'/\s?>]|$)"#).expect("fixed workspace expression");
    let mut ids = Vec::new();
    for capture in pattern.captures_iter(body) {
        let id = capture[1].to_owned();
        if valid_workspace(&id) && !ids.contains(&id) {
            ids.push(id);
            if ids.len() == 8 {
                break;
            }
        }
    }
    ids
}
