//! Fixed-host API-key and manual Cookie usage paths; no browser cookie import or unstable server hash.
use super::usage::{bounded_body, report, usage_request};
use crate::contracts::provider_accounts::*;
use crate::domain::provider_accounts::{
    console_workspaces, cookie_header, endpoints, parse_usage, valid_workspace, web_secret,
};
use reqwest::{Client, RequestBuilder};
use serde_json::Value;
use std::{future::Future, time::Duration};

const CONSOLE: &str = "https://opencode.ai";

/// Preserve a full Cookie header at MiniMax's exact regional console host.
pub(super) fn minimax_cookie_request(
    client: &Client,
    endpoint: &str,
    cookie: &str,
    group: &str,
) -> Result<RequestBuilder, ProviderAccountError> {
    if !endpoints(AccountProvider::Minimax).contains(&endpoint)
        || !group
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err(ProviderAccountError::InvalidSettings);
    }
    let base = if endpoint == "https://www.minimaxi.com" {
        "https://www.minimaxi.com"
    } else {
        "https://platform.minimax.io"
    };
    let referer = if endpoint == "https://www.minimaxi.com" {
        "https://platform.minimaxi.com/console/usage"
    } else {
        "https://platform.minimax.io/console/usage"
    };
    let mut request = client
        .get(format!("{base}/v1/api/openplatform/coding_plan/remains"))
        .header("Cookie", cookie_header(cookie)?)
        .header("Referer", referer)
        .header("Accept", "application/json");
    if !group.is_empty() {
        request = request.header("X-Group-Id", group);
    }
    Ok(request)
}

pub(super) struct ConsoleReply {
    pub body: String,
    pub redirect: Option<String>,
}

/// Read authenticated console text within the shared byte bound; redirects are observed, never followed.
async fn console_response(request: RequestBuilder) -> Result<ConsoleReply, ProviderAccountError> {
    let reply = request
        .send()
        .await
        .map_err(|_| ProviderAccountError::RequestFailed)?;
    match reply.status().as_u16() {
        200..=299 => {}
        301..=303 | 307 | 308 => {
            let location = reply
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() <= 2048)
                .ok_or(ProviderAccountError::InvalidResponse)?;
            return Ok(ConsoleReply {
                body: String::new(),
                redirect: Some(location.into()),
            });
        }
        401 | 403 => return Err(ProviderAccountError::Unauthorized),
        429 => return Err(ProviderAccountError::RateLimited),
        _ => return Err(ProviderAccountError::RequestFailed),
    }
    let body = String::from_utf8(bounded_body(reply).await?)
        .map_err(|_| ProviderAccountError::InvalidResponse)?;
    Ok(ConsoleReply {
        body,
        redirect: None,
    })
}

/// Accept only same-origin workspace redirects; external login/redirect targets never receive cookies.
fn redirected_workspace(location: &str) -> Result<Vec<String>, ProviderAccountError> {
    let base = reqwest::Url::parse(CONSOLE).expect("fixed console URL");
    let url = base
        .join(location)
        .map_err(|_| ProviderAccountError::InvalidResponse)?;
    if url.scheme() != "https"
        || url.host_str() != Some("opencode.ai")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ProviderAccountError::Unauthorized);
    }
    Ok(console_workspaces(url.path()))
}

/// Detect SSR workspace IDs or use the explicit selector, then request reported subscription meters.
async fn console_usage<F, Fut>(
    client: &Client,
    cookie: &str,
    workspace: &str,
    fetch: F,
) -> Result<(Value, String), ProviderAccountError>
where
    F: Fn(RequestBuilder) -> Fut,
    Fut: Future<Output = Result<ConsoleReply, ProviderAccountError>>,
{
    let cookie = cookie_header(cookie)?;
    let workspaces = if workspace.is_empty() {
        let reply = fetch(
            client
                .get(format!("{CONSOLE}/console"))
                .header("Cookie", &cookie)
                .header("Accept", "text/html, application/json"),
        )
        .await?;
        match reply.redirect {
            Some(location) => redirected_workspace(&location)?,
            None => console_workspaces(&reply.body),
        }
    } else if valid_workspace(workspace) {
        vec![workspace.to_owned()]
    } else {
        return Err(ProviderAccountError::InvalidSettings);
    };
    if workspaces.is_empty() {
        return Err(ProviderAccountError::Unsupported {
            reason: AccountReason::MissingWorkspace,
        });
    }
    let mut last_error = ProviderAccountError::InvalidResponse;
    for workspace in workspaces.into_iter().take(4) {
        let request = client
            .get(format!("{CONSOLE}/console/api/go/status"))
            .header("Cookie", &cookie)
            .header("Accept", "application/json")
            .header("Origin", CONSOLE)
            .header("Referer", format!("{CONSOLE}/console/{workspace}/go"))
            .header("x-org-id", &workspace);
        match fetch(request).await {
            Ok(reply) if reply.redirect.is_none() => {
                let value: Value = serde_json::from_str(&reply.body)
                    .map_err(|_| ProviderAccountError::InvalidResponse)?;
                if !parse_usage(AccountProvider::OpencodeGo, &value).is_empty() {
                    return Ok((value, workspace));
                }
            }
            Ok(_) => last_error = ProviderAccountError::Unauthorized,
            Err(ProviderAccountError::RateLimited) => {
                return Err(ProviderAccountError::RateLimited)
            }
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// Reject redirects and malformed JSON without echoing authenticated console contents.
fn json_reply(reply: ConsoleReply) -> Result<Value, ProviderAccountError> {
    if reply.redirect.is_some() {
        return Err(ProviderAccountError::Unauthorized);
    }
    serde_json::from_str(&reply.body).map_err(|_| ProviderAccountError::InvalidResponse)
}

/// Prefer a saved API key without silently trying a different credential when that key is rejected.
pub(super) async fn read(
    client: &Client,
    provider: AccountProvider,
    account: Option<&ProviderAccount>,
    secret: &str,
) -> Result<ProviderAccountUsage, ProviderAccountError> {
    tokio::time::timeout(
        Duration::from_secs(15),
        read_with(client, provider, account, secret, console_response),
    )
    .await
    .map_err(|_| ProviderAccountError::RequestFailed)?
}

/// Exercise the same request graph with a fixture transport instead of live credentials.
async fn read_with<F, Fut>(
    client: &Client,
    provider: AccountProvider,
    account: Option<&ProviderAccount>,
    secret: &str,
    fetch: F,
) -> Result<ProviderAccountUsage, ProviderAccountError>
where
    F: Fn(RequestBuilder) -> Fut,
    Fut: Future<Output = Result<ConsoleReply, ProviderAccountError>>,
{
    let secrets = web_secret(provider, secret)?;
    let endpoint = account
        .map(|a| a.endpoint.as_str())
        .unwrap_or(endpoints(provider)[0]);
    let mut workspace = None;
    let mut value = if !secrets.api_key.is_empty() {
        json_reply(fetch(usage_request(client, provider, endpoint, &secrets.api_key)?).await?)?
    } else if secrets.cookie.is_empty() {
        return Err(ProviderAccountError::Unsupported {
            reason: AccountReason::MissingCredential,
        });
    } else if provider == AccountProvider::Minimax {
        json_reply(
            fetch(minimax_cookie_request(
                client,
                endpoint,
                &secrets.cookie,
                account.map(|a| a.group_id.as_str()).unwrap_or(""),
            )?)
            .await?,
        )?
    } else {
        let (value, id) = console_usage(
            client,
            &secrets.cookie,
            account.map(|a| a.workspace_id.as_str()).unwrap_or(""),
            &fetch,
        )
        .await?;
        workspace = Some(id);
        value
    };
    if provider == AccountProvider::Minimax {
        if let Some(models) = account
            .map(|a| &a.models)
            .filter(|models| !models.is_empty())
        {
            if let Some(rows) = value.get_mut("model_remains").and_then(Value::as_array_mut) {
                rows.retain(|row| {
                    row.get("model_name")
                        .and_then(Value::as_str)
                        .is_some_and(|model| models.iter().any(|m| m == model))
                });
            }
        }
    }
    let quotas = parse_usage(provider, &value);
    let reason = quotas.is_empty().then_some(AccountReason::InvalidResponse);
    let mut usage = report(quotas, reason);
    usage.workspace_id = workspace;
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{future::ready, sync::Mutex};

    /// Construct non-secret account metadata independently of real account storage.
    fn account(provider: AccountProvider) -> ProviderAccount {
        ProviderAccount {
            id: "a".repeat(32),
            revision: 1,
            provider,
            host: AccountHost::Local,
            name: "fixture".into(),
            endpoint: endpoints(provider)[0].into(),
            project: String::new(),
            group_id: String::new(),
            models: vec![],
            workspace_id: String::new(),
        }
    }

    /// Encode test-only secrets in the same strict OS-store envelope as the save use case.
    fn secret(key: &str, cookie: &str) -> String {
        json!({"apiKey":key,"cookie":cookie}).to_string()
    }

    /// Supply measured console meters without making any HTTP request.
    fn console_fixture() -> ConsoleReply {
        ConsoleReply {
            body: include_str!("../../../../tests/fixtures/provider-accounts/go-console.json")
                .into(),
            redirect: None,
        }
    }

    #[tokio::test]
    /// API-key precedence applies to both providers and never forwards the stored Cookie or retries it.
    async fn api_key_takes_precedence_over_cookie() {
        for provider in [AccountProvider::Minimax, AccountProvider::OpencodeGo] {
            let requests = Mutex::new(Vec::new());
            let client = Client::new();
            let account = account(provider);
            let usage=read_with(&client,provider,Some(&account),&secret("fixture-api","__Host-console_session=fixture-cookie"),|builder| {
                let request=builder.build().unwrap();assert_eq!(request.headers()["authorization"],"Bearer fixture-api");assert!(!request.headers().contains_key("cookie"));
                requests.lock().unwrap().push(request.url().to_string());
                let body=if provider==AccountProvider::Minimax {json!({"model_remains":[{"model_name":"fixture-model","current_interval_remaining_percent":75}]}).to_string()}else{json!({"usage":{"rolling":{"percent":25}}}).to_string()};
                ready(Ok(ConsoleReply {body,redirect:None}))
            }).await.unwrap();
            assert_eq!(requests.lock().unwrap().len(), 1);
            assert_eq!(usage.quotas[0].used_percent, 25.0);
            assert!(usage.workspace_id.is_none());
            let calls = Mutex::new(0);
            let error = read_with(
                &client,
                provider,
                Some(&account),
                &secret(
                    "fixture-rejected-key",
                    "__Host-console_session=fixture-cookie",
                ),
                |_| {
                    *calls.lock().unwrap() += 1;
                    ready(Err(ProviderAccountError::Unauthorized))
                },
            )
            .await
            .unwrap_err();
            assert_eq!(error, ProviderAccountError::Unauthorized);
            assert_eq!(*calls.lock().unwrap(), 1);
        }
    }

    #[tokio::test]
    /// MiniMax Cookie requests preserve region/group/model choices and use only fixed console hosts.
    async fn minimax_cookie_region_group_and_models() {
        for (endpoint, host) in [
            ("https://www.minimax.io", "platform.minimax.io"),
            ("https://www.minimaxi.com", "www.minimaxi.com"),
        ] {
            let mut account = account(AccountProvider::Minimax);
            account.endpoint = endpoint.into();
            account.group_id = "fixture-group".into();
            account.models = vec!["chosen-model".into()];
            let usage=read_with(&Client::new(),AccountProvider::Minimax,Some(&account),&secret("","_token=fixture-cookie; other=fixture-value"),|builder|{
                let request=builder.build().unwrap();assert_eq!(request.url().host_str(),Some(host));assert_eq!(request.url().path(),"/v1/api/openplatform/coding_plan/remains");assert_eq!(request.headers()["x-group-id"],"fixture-group");assert_eq!(request.headers()["cookie"],"_token=fixture-cookie; other=fixture-value");assert!(!request.headers().contains_key("authorization"));
                ready(Ok(ConsoleReply {body:json!({"model_remains":[{"model_name":"chosen-model","current_interval_remaining_percent":60},{"model_name":"other-model","current_interval_remaining_percent":20}]}).to_string(),redirect:None}))
            }).await.unwrap();
            assert_eq!(usage.quotas.len(), 1);
            assert_eq!(usage.quotas[0].used_percent, 40.0);
            assert!(usage.quotas[0].label.starts_with("chosen-model /"));
        }
    }

    #[tokio::test]
    /// Full legacy and modern console cookies retain their names and can discover a workspace.
    async fn console_cookie_and_workspace_detection() {
        for cookie in [
            "__Host-console_session=fixture-modern; auth=fixture-legacy; preference=fixture",
            "auth=fixture-legacy",
        ] {
            let calls = Mutex::new(Vec::new());
            let client = Client::new();
            let account = account(AccountProvider::OpencodeGo);
            let usage = read_with(
                &client,
                AccountProvider::OpencodeGo,
                Some(&account),
                &secret("", cookie),
                |builder| {
                    let request = builder.build().unwrap();
                    assert_eq!(request.url().host_str(), Some("opencode.ai"));
                    assert_eq!(request.headers()["cookie"], cookie);
                    assert!(!request.headers().contains_key("authorization"));
                    let reply = if request.url().path() == "/console" {
                        ConsoleReply {
                            body: include_str!(
                                "../../../../tests/fixtures/provider-accounts/console.html"
                            )
                            .into(),
                            redirect: None,
                        }
                    } else {
                        assert_eq!(request.url().path(), "/console/api/go/status");
                        assert_eq!(request.headers()["x-org-id"], "wrk_fixture");
                        console_fixture()
                    };
                    calls.lock().unwrap().push(request);
                    ready(Ok(reply))
                },
            )
            .await
            .unwrap();
            assert_eq!(usage.workspace_id.as_deref(), Some("wrk_fixture"));
            assert_eq!(usage.quotas.len(), 3);
            assert_eq!(usage.quotas[0].used_percent, 25.0);
            assert_eq!(calls.lock().unwrap().len(), 2);
        }
    }

    #[tokio::test]
    /// Explicit workspace selection skips discovery and unknown/foreign responses never create usage.
    async fn console_override_and_detection_failures_are_explicit() {
        let client = Client::new();
        let mut account = account(AccountProvider::OpencodeGo);
        account.workspace_id = "org_explicit".into();
        let usage = read_with(
            &client,
            AccountProvider::OpencodeGo,
            Some(&account),
            &secret("", "__Host-console_session=fixture"),
            |builder| {
                let request = builder.build().unwrap();
                assert_eq!(request.url().path(), "/console/api/go/status");
                assert_eq!(request.headers()["x-org-id"], "org_explicit");
                ready(Ok(console_fixture()))
            },
        )
        .await
        .unwrap();
        assert_eq!(usage.workspace_id.as_deref(), Some("org_explicit"));
        account.workspace_id.clear();
        let error = read_with(
            &client,
            AccountProvider::OpencodeGo,
            Some(&account),
            &secret("", "__Host-console_session=fixture"),
            |_| {
                ready(Ok(ConsoleReply {
                    body: "<html>no workspace</html>".into(),
                    redirect: None,
                }))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            error,
            ProviderAccountError::Unsupported {
                reason: AccountReason::MissingWorkspace
            }
        );
        let calls = Mutex::new(0);
        let error = read_with(
            &client,
            AccountProvider::OpencodeGo,
            Some(&account),
            &secret("", "__Host-console_session=fixture"),
            |_| {
                *calls.lock().unwrap() += 1;
                ready(Ok(ConsoleReply {
                    body: String::new(),
                    redirect: Some("https://evil.example/console/wrk_evil/go".into()),
                }))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, ProviderAccountError::Unauthorized);
        assert_eq!(*calls.lock().unwrap(), 1);
        assert_eq!(
            redirected_workspace("/console/wrk_detected/go").unwrap(),
            vec!["wrk_detected"]
        );
        assert!(
            redirected_workspace("https://opencode.ai.evil.example/console/wrk_evil/go").is_err()
        );
    }
}
