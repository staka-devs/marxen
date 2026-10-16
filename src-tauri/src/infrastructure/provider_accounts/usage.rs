//! Read-only usage requests use fixed trusted hosts, bounded responses and opaque errors.
use super::NativeAccountRuntime;
use crate::application::provider_accounts::ProviderAccountRuntime;
use crate::contracts::provider_accounts::*;
use crate::domain::provider_accounts::{endpoints, parse_usage};
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Stamp receipt time without exposing the account identifier or raw provider response.
pub(super) fn report(
    quotas: Vec<AccountQuota>,
    reason: Option<AccountReason>,
) -> ProviderAccountUsage {
    ProviderAccountUsage {
        quotas,
        received_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64,
        unavailable_reason: reason,
        workspace_id: None,
    }
}

/// Use the same redirect refusal and deadline for every token, cookie and quota request.
fn client() -> Result<Client, ProviderAccountError> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ProviderAccountError::RequestFailed)
}

/// Read a short header value from authentication JSON without permitting header injection.
fn token(value: &Value, path: &str) -> Option<String> {
    value
        .pointer(path)?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 32768 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}

/// Bound response size while rejecting redirects and ignoring server error bodies entirely.
pub(super) async fn response(request: RequestBuilder) -> Result<Value, ProviderAccountError> {
    let reply = request
        .send()
        .await
        .map_err(|_| ProviderAccountError::RequestFailed)?;
    match reply.status().as_u16() {
        401 | 403 => return Err(ProviderAccountError::Unauthorized),
        429 => return Err(ProviderAccountError::RateLimited),
        200..=299 => {}
        _ => return Err(ProviderAccountError::RequestFailed),
    }
    serde_json::from_slice(&bounded_body(reply).await?)
        .map_err(|_| ProviderAccountError::InvalidResponse)
}

/// Bound JSON and console HTML with the same byte budget without exposing response contents.
pub(super) async fn bounded_body(
    mut reply: reqwest::Response,
) -> Result<Vec<u8>, ProviderAccountError> {
    if reply.content_length().is_some_and(|n| n > 262144) {
        return Err(ProviderAccountError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reply
        .chunk()
        .await
        .map_err(|_| ProviderAccountError::RequestFailed)?
    {
        if bytes.len() + chunk.len() > 262144 {
            return Err(ProviderAccountError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Refresh only explicitly supplied Google OAuth client configuration at Google's fixed host.
async fn gemini_token(client: &Client, value: &Value) -> Result<String, ProviderAccountError> {
    let expired = value
        .get("expiry_date")
        .and_then(Value::as_f64)
        .is_some_and(|expiry| expiry <= report(Vec::new(), None).received_ms);
    if !expired {
        if let Some(access) = token(value, "/access_token") {
            return Ok(access);
        }
    }
    let refresh = token(value, "/refresh_token").ok_or(ProviderAccountError::Unsupported {
        reason: AccountReason::RefreshRequired,
    })?;
    let client_id = token(value, "/client_id").ok_or(ProviderAccountError::Unsupported {
        reason: AccountReason::RefreshRequired,
    })?;
    let client_secret =
        token(value, "/client_secret").ok_or(ProviderAccountError::Unsupported {
            reason: AccountReason::RefreshRequired,
        })?;
    let result = response(client.post("https://oauth2.googleapis.com/token").form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh),
        ("client_id", &client_id),
        ("client_secret", &client_secret),
    ]))
    .await?;
    token(&result, "/access_token").ok_or(ProviderAccountError::InvalidResponse)
}

/// Build provider-specific requests only after checking the endpoint against its exact allowlist.
pub(super) fn usage_request(
    client: &Client,
    provider: AccountProvider,
    endpoint: &str,
    secret: &str,
) -> Result<RequestBuilder, ProviderAccountError> {
    if !endpoints(provider).contains(&endpoint)
        || secret.is_empty()
        || secret.chars().any(char::is_control)
    {
        return Err(ProviderAccountError::InvalidSettings);
    }
    let request = match provider {
        AccountProvider::Claude => client
            .get(format!("{endpoint}/api/oauth/usage"))
            .bearer_auth(secret)
            .header("anthropic-beta", "oauth-2025-04-20"),
        AccountProvider::OpencodeGo => client
            .get("https://opencode.ai/zen/go/v1/usage")
            .bearer_auth(secret),
        AccountProvider::Minimax => client
            .get(format!("{endpoint}/v1/token_plan/remains"))
            .bearer_auth(secret),
        AccountProvider::Glm => client
            .get(format!("{endpoint}/api/monitor/usage/quota/limit"))
            .header("Authorization", secret),
        AccountProvider::Grok => client
            .get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
            .bearer_auth(secret)
            .header("X-XAI-Token-Auth", "xai-grok-cli"),
        AccountProvider::Cursor => client
            .get("https://cursor.com/api/usage-summary")
            .header("Cookie", secret)
            .header("Origin", "https://cursor.com")
            .header("Referer", "https://cursor.com/dashboard"),
        _ => {
            return Err(ProviderAccountError::Unsupported {
                reason: AccountReason::AdapterUnsupported,
            })
        }
    };
    Ok(request.header("Accept", "application/json"))
}

/// Resolve credentials and measured quota data without inference, browser import or default-login writes.
pub(super) async fn read(
    runtime: &NativeAccountRuntime,
    provider: AccountProvider,
    account: Option<ProviderAccount>,
    credential: Option<String>,
) -> Result<ProviderAccountUsage, ProviderAccountError> {
    if matches!(
        provider,
        AccountProvider::Opencode | AccountProvider::Devin | AccountProvider::Antigravity
    ) {
        return Ok(report(Vec::new(), Some(AccountReason::AdapterUnsupported)));
    }
    if provider == AccountProvider::Codex {
        let environment = match (&account, &credential) {
            (Some(account), Some(secret)) => Some(runtime.environment(account, secret)?),
            _ => None,
        };
        let buckets = tokio::task::spawn_blocking(move || {
            use crate::infrastructure::ai::account_usage::{
                codex_account_argv, read_codex_with_environment,
            };
            read_codex_with_environment(
                &codex_account_argv()?,
                Duration::from_secs(15),
                environment.as_ref(),
            )
        })
        .await
        .map_err(|_| ProviderAccountError::RequestFailed)?
        .map_err(|_| ProviderAccountError::RequestFailed)?;
        let mut quotas = Vec::new();
        for bucket in buckets {
            for (name, window) in [("primary", bucket.primary), ("secondary", bucket.secondary)] {
                if let Some(window) = window {
                    quotas.push(AccountQuota {
                        label: format!("{} / {name}", bucket.name.as_deref().unwrap_or(&bucket.id)),
                        used_percent: window.used_percent,
                        resets_at: window.resets_at.map(|r| r.to_string()),
                    });
                }
            }
        }
        let reason = quotas.is_empty().then_some(AccountReason::InvalidResponse);
        return Ok(report(quotas, reason));
    }
    let secret = match credential {
        Some(secret) => Some(secret),
        None => runtime.system_secret(provider)?,
    };
    let Some(secret) = secret else {
        return Ok(report(Vec::new(), Some(AccountReason::LoginRequired)));
    };
    let client = client()?;
    let endpoint = account
        .as_ref()
        .map(|a| a.endpoint.as_str())
        .unwrap_or(endpoints(provider)[0]);
    if matches!(
        provider,
        AccountProvider::Minimax | AccountProvider::OpencodeGo
    ) {
        return super::web_usage::read(&client, provider, account.as_ref(), &secret).await;
    }
    let mut value: Value = serde_json::from_str(&secret).unwrap_or(Value::Null);
    if provider == AccountProvider::Grok && value.get("accessToken").is_none() {
        value = crate::domain::provider_accounts::grok_login(&value)?
            .ok_or(ProviderAccountError::Unauthorized)?;
    }
    let reply = if provider == AccountProvider::Gemini {
        let access = gemini_token(&client, &value).await?;
        let mut project = account
            .as_ref()
            .map(|a| a.project.clone())
            .unwrap_or_default();
        if project.is_empty() {
            let loaded = response(
                client
                    .post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
                    .bearer_auth(&access)
                    .json(&json!({"metadata": {"ideType": "GEMINI_CLI", "pluginType": "GEMINI"}})),
            )
            .await?;
            project = loaded
                .get("cloudaicompanionProject")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    loaded
                        .pointer("/cloudaicompanionProject/id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .ok_or(ProviderAccountError::Unsupported {
                    reason: AccountReason::MissingProject,
                })?;
        }
        response(
            client
                .post("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
                .bearer_auth(access)
                .json(&json!({"project": project})),
        )
        .await?
    } else {
        let access = match provider {
            AccountProvider::Claude => token(&value, "/claudeAiOauth/accessToken").ok_or(
                ProviderAccountError::Unsupported {
                    reason: AccountReason::RefreshRequired,
                },
            )?,
            AccountProvider::Grok => {
                token(&value, "/accessToken").ok_or(ProviderAccountError::InvalidSettings)?
            }
            _ => secret,
        };
        let mut request = usage_request(&client, provider, endpoint, &access)?;
        if provider == AccountProvider::Grok {
            if let Some(user) = token(&value, "/userId") {
                request = request.header("x-userid", user);
            }
        }
        response(request).await?
    };
    let quotas = parse_usage(provider, &reply);
    let reason = quotas.is_empty().then_some(AccountReason::InvalidResponse);
    Ok(report(quotas, reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    /// All cookie/token usage destinations are fixed, with no URL/query credential transport.
    fn trusted_request_destinations_and_authentication() {
        let client = client().unwrap();
        for provider in [
            AccountProvider::Claude,
            AccountProvider::OpencodeGo,
            AccountProvider::Minimax,
            AccountProvider::Glm,
            AccountProvider::Grok,
            AccountProvider::Cursor,
        ] {
            for endpoint in endpoints(provider) {
                let request = usage_request(&client, provider, endpoint, "fixture-secret")
                    .unwrap()
                    .build()
                    .unwrap();
                assert!(request.url().as_str().starts_with(endpoint));
                assert!(!request.url().as_str().contains("fixture-secret"));
                assert!(request
                    .headers()
                    .contains_key(if provider == AccountProvider::Cursor {
                        "cookie"
                    } else {
                        "authorization"
                    }));
            }
            for untrusted in [
                "http://localhost",
                "https://evil.test",
                "https://api.z.ai.evil.test",
                "https://user:secret@api.z.ai",
            ] {
                assert!(usage_request(&client, provider, untrusted, "fixture-secret").is_err());
            }
            assert!(usage_request(
                &client,
                provider,
                endpoints(provider)[0],
                "secret\r\nInjected: bad"
            )
            .is_err());
        }
    }

    /// Serve one synthetic local HTTP response without a provider account or external connection.
    fn server(status: &str, body: &str, headers: &str) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = socket.read(&mut buf);
            let _ = socket.write_all(response.as_bytes());
        });
        (url, thread)
    }

    #[tokio::test]
    /// Provider error bodies and redirects cannot leak credentials or reach another destination.
    async fn bounded_response_failures_are_opaque() {
        let client = client().unwrap();
        for (status, expected) in [
            ("401 Unauthorized", ProviderAccountError::Unauthorized),
            ("429 Too Many Requests", ProviderAccountError::RateLimited),
            ("500 Server Error", ProviderAccountError::RequestFailed),
            ("302 Found", ProviderAccountError::RequestFailed),
        ] {
            let (url, thread) = server(
                status,
                "fixture-secret-provider-error",
                "Location: https://evil.test\r\n",
            );
            let error = response(client.get(url)).await.unwrap_err();
            thread.join().unwrap();
            assert_eq!(error, expected);
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("fixture-secret"));
        }
        let (url, thread) = server("200 OK", &"x".repeat(262145), "");
        assert_eq!(
            response(client.get(url)).await,
            Err(ProviderAccountError::InvalidResponse)
        );
        thread.join().unwrap();
        let (url, thread) = server("200 OK", "{\"measured\":0}", "");
        assert_eq!(
            response(client.get(url)).await.unwrap(),
            json!({"measured":0})
        );
        thread.join().unwrap();
    }
}
