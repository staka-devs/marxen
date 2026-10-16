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
            AccountProvider::Grok => value
                .get("accessToken")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty()),
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
