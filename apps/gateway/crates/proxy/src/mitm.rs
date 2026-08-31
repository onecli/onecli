//! MITM TLS interception: terminate TLS with the client using a generated
//! leaf certificate, then forward HTTP requests to the real upstream server.
//!
//! Rules (injection + policy) are re-resolved from cache on each HTTP request
//! so that changes (e.g., adding a secret) take effect immediately without
//! requiring the agent to reconnect.

use std::sync::Arc;

use anyhow::{Context, Result};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use std::fmt;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tracing::{debug, warn};

use crate::connect::PolicyEngineExt as _;
use crate::connect::{self, AppConnectionResult, ConnectionChoice, PolicyEngine};
use approval::ApprovalStore;
use ca::CertificateAuthority;
use cache::CacheStore;
use inject::InjectionRule;

use super::forward;
use super::response;
use context::ProxyContext;

/// Cap on the client-side TLS handshake inside a tunnel.
const TLS_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Typed error context for TLS handshake failures with the client.
#[derive(Debug)]
struct TlsHandshakeWithClient;

impl fmt::Display for TlsHandshakeWithClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TLS handshake with client")
    }
}

impl std::error::Error for TlsHandshakeWithClient {}

/// Terminate TLS with the client, then forward each HTTP request through
/// [`forward::forward_request`] with freshly resolved rules from cache.
#[allow(clippy::too_many_arguments)]
pub async fn mitm(
    upgraded: hyper::upgrade::Upgraded,
    host: &str,
    ca: &CertificateAuthority,
    http_client: reqwest::Client,
    // Upstream TLS for the WebSocket leg, already resolved against the
    // operator's skip-verify configuration at CONNECT time.
    ws_connector: TlsConnector,
    vault_injection_rules: Vec<InjectionRule>,
    cache: Arc<dyn CacheStore>,
    proxy_ctx: Arc<ProxyContext>,
    approval_store: Arc<dyn ApprovalStore>,
    policy_engine: Arc<PolicyEngine>,
) -> Result<()> {
    let hostname = common::util::strip_port(host);

    let server_config = ca.server_config_for_host(hostname)?;
    let acceptor = TlsAcceptor::from(server_config);

    let client_io = TokioIo::new(upgraded);
    // Bounded because a client that opens a tunnel and then never speaks would
    // otherwise hold this task forever — and, once the drain is waiting on it,
    // hold the whole shutdown to its deadline.
    let tls_stream = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(client_io))
        .await
        .context("TLS handshake with client timed out")?
        .context(TlsHandshakeWithClient)?;
    debug!(host = %hostname, "TLS handshake with client succeeded");

    let host_owned = host.to_string();
    let vault_injection_rules = Arc::new(vault_injection_rules);
    let io = TokioIo::new(tls_stream);

    let conn = http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let host = host_owned.clone();
                let client = http_client.clone();
                let ws_tls = ws_connector.clone();
                let cache = Arc::clone(&cache);
                let ctx = Arc::clone(&proxy_ctx);
                let approvals = Arc::clone(&approval_store);
                let engine = Arc::clone(&policy_engine);
                let vault_rules = Arc::clone(&vault_injection_rules);
                async move {
                    let is_ws = super::websocket::is_websocket_upgrade(&req);
                    let connection_id = connect::extract_connection_id(req.headers());
                    let request_path = req.uri().path_and_query().map(|pq| pq.to_string());

                    // Re-resolve rules from cache on each request so that
                    // secret/rule changes take effect without a reconnect.
                    let hostname = common::util::strip_port(&host);
                    match resolve_rules(
                        &ctx,
                        hostname,
                        &engine,
                        &*cache,
                        &vault_rules,
                        connection_id.as_deref(),
                        request_path.as_deref(),
                    )
                    .await
                    {
                        Ok(ResolveResult::Resolved {
                            rules,
                            app_connections,
                        }) => {
                            let effective_host = rules.rewrite_host.as_deref().unwrap_or(&host);
                            if is_ws {
                                match super::websocket::handle_websocket(
                                    req,
                                    effective_host, // forward target (may be host-rewritten)
                                    hostname, // policy_host: pre-rewrite host the rules match
                                    &rules,
                                    &*cache,
                                    &engine,
                                    &ctx,
                                    &ws_tls,
                                )
                                .await
                                {
                                    Ok(mut resp) => {
                                        connect::inject_connections_header(
                                            &mut resp,
                                            &app_connections,
                                        );
                                        Ok(resp)
                                    }
                                    Err(e) => {
                                        warn!(host = %host, error = ?e, "WebSocket handler failed");
                                        Ok(response::resolution_failed())
                                    }
                                }
                            } else {
                                match forward::forward_request(
                                    req,
                                    effective_host, // forward target (may be host-rewritten)
                                    hostname, // policy_host: pre-rewrite host the rules were assembled from
                                    "https",
                                    client,
                                    &rules,
                                    &*cache,
                                    &ctx,
                                    &approvals,
                                    &engine,
                                )
                                .await
                                {
                                    Ok(mut resp) => {
                                        connect::inject_connections_header(
                                            &mut resp,
                                            &app_connections,
                                        );
                                        Ok(resp)
                                    }
                                    Err(e) => {
                                        warn!(host = %host, error = ?e, "request forwarding failed");
                                        Ok::<_, anyhow::Error>(response::resolution_failed())
                                    }
                                }
                            }
                        }
                        Ok(ResolveResult::Ambiguous(connections)) => {
                            Ok(response::multiple_connections(&connections))
                        }
                        Ok(ResolveResult::MultipleProviders(connections)) => {
                            Ok(response::multiple_providers(&connections))
                        }
                        Ok(ResolveResult::NotFound {
                            connection_id: cid,
                            connections,
                        }) => Ok(response::connection_not_found(&cid, &connections)),
                        Err(e) => {
                            warn!(host = %host, error = ?e, "rule resolution failed mid-session");
                            Ok(response::resolution_failed())
                        }
                    }
                }
            }),
        )
        .with_upgrades();
    tokio::pin!(conn);

    let mut shutdown_signal = shutdown::subscribe();

    // The tunnel carries real HTTP, so it drains like any other connection:
    // the request in flight when the signal lands still gets its response.
    tokio::select! {
        result = conn.as_mut() => result.context("serving MITM connection"),
        _ = shutdown_signal.wait() => {
            conn.as_mut().graceful_shutdown();
            conn.await.context("draining MITM connection")
        }
    }
}

/// Pre-computed data for token endpoint interception responses.
#[derive(Debug)]
pub struct InterceptToken {
    pub access_token: String,
    pub expires_in: i64,
}

/// Per-request resolved rules, bundled for passing to `forward_request`.
#[derive(Debug)]
pub struct ResolvedRules {
    pub injection_rules: Vec<InjectionRule>,
    /// Connections whose credential is minted only after the request is
    /// allowed (`connect::PendingInjection`). Their rules are NOT yet in
    /// `injection_rules`, so use [`Self::injects`] — never
    /// `injection_rules.is_empty()` — to ask whether a credential is in play.
    pub pending_injections: Vec<crate::connect::PendingInjection>,
    pub access_restricted: bool,
    /// Ready-to-use interception data when the resolved connection has a
    /// cached token that should be served instead of forwarding.
    pub intercept_token: Option<InterceptToken>,
    /// Normalized plan name for quota enforcement ("free", "pro", "team").
    pub plan: String,
    /// Rewritten upstream host (e.g., Datadog us5 → api.us5.datadoghq.com).
    pub rewrite_host: Option<String>,
    /// Display label of the app connection used (e.g., email address for OAuth accounts).
    pub connection_label: Option<String>,
    /// Provider-specific request finalizer resolved from the app connection.
    /// When set, takes precedence over the host-based finalizer lookup.
    pub finalizer: Option<apps::RequestFinalizer>,
    /// Provider-specific body transform resolved from the app connection.
    /// The handler decides per-request whether to act.
    pub body_transform: Option<apps::BodyTransform>,
    /// Per-agent resource policy (e.g. Dropbox folder allowlist) for the
    /// connection serving this host. Consumed by the cloud request guard to
    /// enforce granular access; `None` in the common, unrestricted case.
    pub session_policy: Option<serde_json::Value>,
    /// Id of the app connection that won injection for this request; `None`
    /// when no connection serves it (secret/vault/uncredentialed traffic, the
    /// non-serving wipe, or a swallowed escalation). Same attribution law as
    /// `session_policy`. `Target::Connection` policy decisions bind to it.
    pub winning_connection_id: Option<String>,
    /// Cloud-only: spend budgets governing the effective credential for this host
    /// (0/1 in practice).
    pub budget_bindings: Vec<ee::budget::BudgetBinding>,
    /// The published new-model policy rules for this connection (from
    /// `ConnectResponse`), passed to the enforce seam. Empty when the
    /// engine is off, or before the org is backfilled.
    pub policy_rules_v2: db::PolicyV2Rules,
    /// The apps this connection's workspace may reach (from `ConnectResponse`), for
    /// the per-request availability pre-check. Unrestricted (all available) in
    /// OSS, when the org is "open", or when enforcement is off.
    pub available_apps: db::AvailableApps,
}

impl ResolvedRules {
    /// Whether a credential will be injected into this request — including one
    /// still waiting to be minted.
    ///
    /// This is the enforce-deny carve's input: answering "no" makes the traffic
    /// unmanaged and exempts it from deny-defaults, so a deferred credential
    /// that read as "none" would quietly let blocked requests through.
    pub fn injects(&self) -> bool {
        !self.injection_rules.is_empty() || !self.pending_injections.is_empty()
    }
}

/// Result of per-request rule resolution including app connection disambiguation.
// `Resolved` is the large, common variant; this value is built once per request
// and consumed immediately, so boxing it would only add a hot-path allocation.
#[allow(clippy::large_enum_variant)]
enum ResolveResult {
    /// Rules resolved successfully, with the raw app connections for the response header.
    Resolved {
        /// Boxed: `ResolvedRules` is large, so inlining it makes this variant
        /// dwarf the others (`clippy::large_enum_variant`). `Deref` keeps the box
        /// transparent at the use sites.
        rules: Box<ResolvedRules>,
        app_connections: Vec<db::AppConnectionRow>,
    },
    /// Multiple connections exist and no header was provided.
    Ambiguous(Vec<ConnectionChoice>),
    /// Multiple providers match the same request path.
    MultipleProviders(Vec<ConnectionChoice>),
    /// The requested connection ID was not found.
    NotFound {
        connection_id: String,
        connections: Vec<ConnectionChoice>,
    },
}

/// Resolve injection + policy rules from cache, with per-request app connection
/// disambiguation. Secret and app-connection rules are both path-scoped and are
/// merged per request (`inject::merge_injection_rules`); vault rules fill in
/// only when neither source yields any.
async fn resolve_rules(
    ctx: &ProxyContext,
    hostname: &str,
    engine: &PolicyEngine,
    cache: &dyn CacheStore,
    vault_rules: &[InjectionRule],
    connection_id: Option<&str>,
    request_path: Option<&str>,
) -> Result<ResolveResult, crate::connect::ConnectError> {
    let workspace_id = ctx.workspace_id.as_deref().ok_or_else(|| {
        crate::connect::ConnectError::Internal("MITM session missing workspace_id".to_string())
    })?;
    let organization_id = ctx.organization_id.as_deref().ok_or_else(|| {
        crate::connect::ConnectError::Internal("MITM session missing organization_id".to_string())
    })?;
    let resp = connect::resolve_from_cache(
        organization_id,
        workspace_id,
        &ctx.agent_token,
        hostname,
        engine,
        cache,
    )
    .await?;

    let secret_rules = resp.injection_rules; // from secrets (path-scoped)
    let mut app_rules: Vec<InjectionRule> = Vec::new();
    let mut pending_injections: Vec<crate::connect::PendingInjection> = Vec::new();
    let mut token_expires_at: Option<i64> = None;
    let mut rewrite_host: Option<String> = None;
    let mut connection_label: Option<String> = None;
    let mut finalizer: Option<apps::RequestFinalizer> = None;
    let mut body_transform: Option<apps::BodyTransform> = None;
    // Granular-access policy of the connection that wins injection (if any).
    let mut session_policy: Option<serde_json::Value> = None;
    // Id of the connection that wins injection (if any) — rides with
    // `session_policy` under the same attribution law.
    let mut winning_connection_id: Option<String> = None;

    // Resolve app connections whenever any exist and MERGE their rules with
    // the secret rules. A shared host (e.g. www.googleapis.com) can carry
    // both an API-key secret (/youtube/*) and OAuth app connections
    // (/calendar/*, /drive/*); both rule sets are path-scoped and coexist —
    // a secret must not preempt the apps (#428). When the secret rules
    // already serve this request's path, app-side escalations (ambiguity,
    // stale connection id, resolution errors) are best-effort no-ops rather
    // than failures of a request the secret alone satisfies.
    if !resp.app_connections.is_empty() {
        let secrets_serve = inject::rules_serve_path(&secret_rules, request_path);
        match engine
            .resolve_app_injection_for_request(
                &resp.app_connections,
                hostname,
                request_path,
                connection_id,
                organization_id,
                workspace_id,
                cache,
            )
            .await
        {
            Ok(AppConnectionResult::Rules {
                rules,
                provider: _,
                token_expires_at: exp,
                rewrite_host: rh,
                connection_label: cl,
                finalizer: f,
                body_transform: bt,
                session_policy: sp,
                connection_id: cid,
                pending,
            }) => {
                app_rules = rules;
                pending_injections = pending;
                token_expires_at = exp;
                rewrite_host = rh;
                connection_label = cl;
                finalizer = f;
                body_transform = bt;
                session_policy = sp;
                winning_connection_id = cid;
            }
            Ok(AppConnectionResult::Ambiguous { connections }) => {
                if !secrets_serve {
                    return Ok(ResolveResult::Ambiguous(connections));
                }
                debug!(host = %hostname, "app connections ambiguous; secret rules serve this path");
            }
            Ok(AppConnectionResult::MultipleProviders { connections }) => {
                if !secrets_serve {
                    return Ok(ResolveResult::MultipleProviders(connections));
                }
                debug!(host = %hostname, "multiple providers match; secret rules serve this path");
            }
            Ok(AppConnectionResult::NotFound { connections }) => {
                if !secrets_serve {
                    return Ok(ResolveResult::NotFound {
                        connection_id: connection_id.unwrap_or("").to_string(),
                        connections,
                    });
                }
                debug!(host = %hostname, "requested connection not found; secret rules serve this path");
            }
            Ok(AppConnectionResult::NoConnections) => {}
            Err(e) => {
                if !secrets_serve {
                    return Err(e);
                }
                warn!(host = %hostname, error = ?e, "app resolution failed; proceeding with secret rules");
            }
        }
    }

    // Build the intercept token only for providers that have intercept rules.
    // Scan the APP rules only: the intercept exists to answer token-refresh
    // POSTs for app connections (vertex-ai on oauth2.googleapis.com), so a
    // Bearer-shaped secret or vault credential on the same host must not
    // donate the token.
    let intercept_token = if apps::host_has_intercept_rules(hostname) {
        app_rules
            .iter()
            .find_map(|rule| {
                rule.injections.iter().find_map(|inj| match inj {
                    inject::Injection::SetHeader { name, value } if name == "authorization" => {
                        value.strip_prefix("Bearer ").map(|t| t.to_string())
                    }
                    _ => None,
                })
            })
            .map(|access_token| {
                let expires_in = token_expires_at
                    .map(|exp| {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .expect("system clock")
                            .as_secs() as i64;
                        (exp - now).max(0)
                    })
                    .unwrap_or(3600);
                InterceptToken {
                    access_token,
                    expires_in,
                }
            })
    } else {
        None
    };

    let mut injection_rules = inject::merge_injection_rules(app_rules, secret_rules);

    // Vault fallback — only when neither secrets nor apps yielded any rules. A
    // connection awaiting its credential counts as "apps yielded rules": it
    // will inject once allowed, and adopting a vault credential alongside it
    // would apply two credentials to the same host.
    if injection_rules.is_empty() && pending_injections.is_empty() && !vault_rules.is_empty() {
        injection_rules = vault_rules.to_vec();
    }

    Ok(ResolveResult::Resolved {
        rules: Box::new(ResolvedRules {
            injection_rules,
            pending_injections,
            policy_rules_v2: resp.policy_rules_v2,
            available_apps: resp.available_apps,
            access_restricted: resp.access_restricted,
            intercept_token,
            plan: resp.plan,
            rewrite_host,
            connection_label,
            finalizer,
            body_transform,
            session_policy,
            winning_connection_id,
            budget_bindings: resp.budget_bindings,
        }),
        app_connections: resp.app_connections,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::connect::{seed_app_injection_cache, ConnectResponse};
    use inject::{apply_injections, Injection};

    const HOST: &str = "www.googleapis.com";

    fn ctx() -> ProxyContext {
        ProxyContext {
            workspace_id: Some("p1".to_string()),
            organization_id: Some("o1".to_string()),
            agent_id: None,
            agent_name: None,
            agent_identifier: None,
            agent_token: "tok".to_string(),
        }
    }

    fn app_conn(id: &str, provider: &str) -> db::AppConnectionRow {
        db::AppConnectionRow {
            id: id.to_string(),
            provider: provider.to_string(),
            scope: "workspace".to_string(),
            credentials: None,
            label: None,
            metadata: None,
            session_policy: None,
        }
    }

    fn header_rule(pattern: &str, value: &str) -> InjectionRule {
        InjectionRule {
            path_pattern: pattern.to_string(),
            injections: vec![Injection::SetHeader {
                name: "authorization".to_string(),
                value: value.to_string(),
            }],
        }
    }

    fn param_rule(pattern: &str, name: &str, value: &str) -> InjectionRule {
        InjectionRule {
            path_pattern: pattern.to_string(),
            injections: vec![Injection::SetParam {
                name: name.to_string(),
                value: value.to_string(),
            }],
        }
    }

    async fn seed_connect(
        store: &Arc<dyn CacheStore>,
        hostname: &str,
        secrets: Vec<InjectionRule>,
        connections: Vec<db::AppConnectionRow>,
    ) {
        let resp = ConnectResponse {
            injection_rules: secrets,
            app_connections: connections,
            workspace_id: Some("p1".to_string()),
            organization_id: Some("o1".to_string()),
            ..Default::default()
        };
        let key = format!("connect:o1:p1:tok:{hostname}");
        store.set(&key, &resp, 60).await;
    }

    /// Seed the app-injection cache for a fixture connection (no
    /// session_policy → no cache-key suffix), labeled "Conn".
    async fn seed_app_injection(
        store: &Arc<dyn CacheStore>,
        conn_id: &str,
        provider: &str,
        hostname: &str,
        rules: Vec<InjectionRule>,
    ) {
        seed_app_injection_cache(
            store,
            "o1",
            "p1",
            &app_conn(conn_id, provider),
            hostname,
            rules,
            None,
            Some("Conn"),
        )
        .await;
    }

    fn applied_auth(path: &str, rules: &[InjectionRule]) -> (Option<String>, String) {
        let mut headers = hyper::HeaderMap::new();
        let mut request_path = path.to_string();
        apply_injections(&mut headers, &mut request_path, rules);
        let auth = headers
            .get("authorization")
            .map(|v| v.to_str().unwrap().to_string());
        (auth, request_path)
    }

    #[tokio::test]
    async fn coexisting_secret_and_app_rules_merge() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        seed_connect(
            &store,
            HOST,
            vec![param_rule("/youtube/*", "key", "yt-key")],
            vec![app_conn("c1", "google-calendar")],
        )
        .await;
        seed_app_injection(
            &store,
            "c1",
            "google-calendar",
            HOST,
            vec![header_rule("/calendar/*", "Bearer cal")],
        )
        .await;

        // A calendar request gets the OAuth Bearer (the #428 fix)…
        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &[],
            None,
            Some("/calendar/v3/users/me/calendarList"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let (auth, path) =
            applied_auth("/calendar/v3/users/me/calendarList", &rules.injection_rules);
        assert_eq!(auth.as_deref(), Some("Bearer cal"));
        assert!(!path.contains("key=yt-key"));
        // …and the serving connection's label is attributed.
        assert_eq!(rules.connection_label.as_deref(), Some("Conn"));

        // A youtube request still gets the API key and no app metadata.
        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &[],
            None,
            Some("/youtube/v3/search"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let (auth, path) = applied_auth("/youtube/v3/search", &rules.injection_rules);
        assert_eq!(auth, None);
        assert!(path.contains("key=yt-key"));
        assert!(rules.connection_label.is_none());
        assert!(rules.session_policy.is_none());
    }

    #[tokio::test]
    async fn ambiguity_swallowed_when_secrets_serve_the_path() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        // Two same-provider connections make /gmail requests ambiguous.
        seed_connect(
            &store,
            HOST,
            vec![header_rule("/gmail/*", "ApiKey gmail-secret")],
            vec![app_conn("c1", "gmail"), app_conn("c2", "gmail")],
        )
        .await;

        // The secret serves /gmail — the ambiguity is a best-effort no-op.
        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &[],
            None,
            Some("/gmail/v1/users/me"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let (auth, _) = applied_auth("/gmail/v1/users/me", &rules.injection_rules);
        assert_eq!(auth.as_deref(), Some("ApiKey gmail-secret"));

        // With a secret that does NOT serve the path, ambiguity still escalates.
        seed_connect(
            &store,
            HOST,
            vec![param_rule("/youtube/*", "key", "yt-key")],
            vec![app_conn("c1", "gmail"), app_conn("c2", "gmail")],
        )
        .await;
        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &[],
            None,
            Some("/gmail/v1/users/me"),
        )
        .await
        .unwrap();
        assert!(matches!(res, ResolveResult::Ambiguous(_)));
    }

    #[tokio::test]
    async fn stale_connection_id_swallowed_when_secrets_serve_the_path() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        seed_connect(
            &store,
            HOST,
            vec![param_rule("/youtube/*", "key", "yt-key")],
            vec![app_conn("c1", "google-calendar")],
        )
        .await;

        // Stale explicit id on a secret-served path → proceed with the secret.
        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &[],
            Some("gone"),
            Some("/youtube/v3/search"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let (_, path) = applied_auth("/youtube/v3/search", &rules.injection_rules);
        assert!(path.contains("key=yt-key"));

        // On a path the secret does not serve, NotFound still escalates.
        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &[],
            Some("gone"),
            Some("/calendar/v3/events"),
        )
        .await
        .unwrap();
        assert!(matches!(res, ResolveResult::NotFound { .. }));
    }

    #[tokio::test]
    async fn intercept_token_comes_from_app_rules_only() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        let host = "oauth2.googleapis.com";
        // A Bearer-shaped catch-all secret coexists with the vertex-ai app
        // connection on the intercept host; the intercepted token must be the
        // app's, not the secret's.
        seed_connect(
            &store,
            host,
            vec![header_rule("*", "Bearer secret-tok")],
            vec![app_conn("c1", "vertex-ai")],
        )
        .await;
        seed_app_injection(
            &store,
            "c1",
            "vertex-ai",
            host,
            vec![header_rule("/token*", "Bearer app-tok")],
        )
        .await;

        let res = resolve_rules(&ctx(), host, &engine, &*store, &[], None, Some("/token"))
            .await
            .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let token = rules.intercept_token.expect("intercept token");
        assert_eq!(token.access_token, "app-tok");
    }

    #[tokio::test]
    async fn app_only_host_behavior_unchanged() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        seed_connect(
            &store,
            HOST,
            vec![],
            vec![app_conn("c1", "google-calendar")],
        )
        .await;
        seed_app_injection(
            &store,
            "c1",
            "google-calendar",
            HOST,
            vec![header_rule("/calendar/*", "Bearer cal")],
        )
        .await;

        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &[],
            None,
            Some("/calendar/v3/events"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let (auth, _) = applied_auth("/calendar/v3/events", &rules.injection_rules);
        assert_eq!(auth.as_deref(), Some("Bearer cal"));
        assert_eq!(rules.connection_label.as_deref(), Some("Conn"));
    }

    #[tokio::test]
    async fn secret_only_resolution_keeps_rule_order() {
        // No app connections: resolution must not reorder the secrets — the
        // last-listed catch-all keeps winning overlaps exactly as before.
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        seed_connect(
            &store,
            HOST,
            vec![
                header_rule("/v1/*", "specific"),
                header_rule("*", "catch-all"),
            ],
            vec![],
        )
        .await;

        let res = resolve_rules(&ctx(), HOST, &engine, &*store, &[], None, Some("/v1/x"))
            .await
            .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let (auth, _) = applied_auth("/v1/x", &rules.injection_rules);
        assert_eq!(auth.as_deref(), Some("catch-all"));
    }

    #[tokio::test]
    async fn vault_fallback_when_no_secret_or_app_rules() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        seed_connect(&store, HOST, vec![], vec![]).await;
        let vault_rules = vec![header_rule("*", "Basic vault-cred")];

        let res = resolve_rules(
            &ctx(),
            HOST,
            &engine,
            &*store,
            &vault_rules,
            None,
            Some("/anything"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        let (auth, _) = applied_auth("/anything", &rules.injection_rules);
        assert_eq!(auth.as_deref(), Some("Basic vault-cred"));
    }
}
