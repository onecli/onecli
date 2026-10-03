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
                    // Kept for a transport failure, which answers after `req`
                    // has been consumed by the forward.
                    let failed = FailedRequest {
                        method: req.method().clone(),
                        path: request_path.clone().unwrap_or_else(|| "/".to_string()),
                        start: std::time::Instant::now(),
                    };

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
                                        Ok(transport_failure_response(&rules, &ctx, hostname, &failed, &e))
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
                                        Ok::<_, anyhow::Error>(transport_failure_response(&rules, &ctx, hostname, &failed, &e))
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

/// What a transport-failure answer needs to know about the request it
/// answers, captured before the forward consumes it.
struct FailedRequest {
    method: hyper::Method,
    path: String,
    start: std::time::Instant,
}

/// The response for a request that could not be delivered upstream at all
/// (DNS, connect, TLS, or an in-flight transport error).
///
/// When the request went to a host none of the agent's granted host-gated
/// connections is bound to, THAT is the explanation the agent needs — the
/// #1137 shape is a placeholder hostname that does not resolve — so answer
/// with the bound host(s), and record it in the activity feed like every
/// other guidance answer. Otherwise, a failure to reach the upstream says so
/// (`upstream_unreachable`); anything else keeps the generic 502.
fn transport_failure_response<S>(
    rules: &ResolvedRules,
    proxy_ctx: &ProxyContext,
    hostname: &str,
    request: &FailedRequest,
    error: &anyhow::Error,
) -> hyper::Response<response::ForwardBody<S>> {
    match rules.host_mismatch.as_deref() {
        Some(connections) => {
            super::hooks::record_host_mismatch_failure(
                proxy_ctx,
                hostname,
                request.method.as_str(),
                &request.path,
                request.start,
            );
            response::connection_host_mismatch(hostname, &request.path, connections)
        }
        None if is_upstream_send_failure(error) => response::upstream_unreachable(hostname),
        None => response::resolution_failed(),
    }
}

/// Whether `error` is the upstream client failing to deliver the request
/// (the `reqwest` send), as opposed to a local failure before it (buffering
/// the request body, preparing a condition match).
fn is_upstream_send_failure(error: &anyhow::Error) -> bool {
    error.chain().any(|e| e.is::<reqwest::Error>())
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
    /// The kind of credential the workspace holds for this host but this agent
    /// was not granted (`ConnectResponse::access_restricted`).
    pub access_restricted: Option<crate::connect::RestrictedCredential>,
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
    /// Granted host-gated connections that refused THIS request because it
    /// went to a host other than their bound one (`AppConnectionResult::
    /// HostMismatch`), each annotated with that host. Set only when nothing
    /// else injected. Informational: the request still forwards; when it then
    /// fails in a way the mismatch explains (transport failure, an auth-class
    /// upstream response), the failure is answered with these choices instead
    /// of a misleading generic error (#1137).
    pub host_mismatch: Option<Vec<crate::connect::ConnectionChoice>>,
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
    let mut host_mismatch: Option<Vec<crate::connect::ConnectionChoice>> = None;

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
            // Nothing injects, exactly as `NoConnections`; the choices ride
            // along so a downstream failure can be explained (#1137).
            Ok(AppConnectionResult::HostMismatch { connections }) => {
                host_mismatch = Some(connections);
            }
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

    // A non-injecting alias host (login.salesforce.com): nothing can inject,
    // but the agent's connection of the owning provider tells it where it
    // SHOULD have gone.
    let host_mismatch =
        host_mismatch.or_else(|| connect::alias_host_choices(&resp.alias_connections));

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
            host_mismatch,
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

    // ── host mismatch (#1137) ─────────────────────────────────────────────

    use response::test_support::{body_json, TestBody};

    /// A connection row with real encrypted credentials bound to another host.
    async fn gated_app_conn(
        engine: &PolicyEngine,
        id: &str,
        provider: &str,
        creds: serde_json::Value,
    ) -> db::AppConnectionRow {
        let mut row = app_conn(id, provider);
        row.credentials = Some(
            engine
                .crypto
                .encrypt(&creds.to_string())
                .await
                .expect("encrypt"),
        );
        row
    }

    /// The mismatch is SOFT at resolution: the request still resolves (no
    /// injection, exactly as before), and the choices ride on `ResolvedRules`
    /// for the failure paths to explain what happened.
    #[tokio::test]
    async fn host_mismatch_resolves_uncredentialed_and_records_the_choices() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        let host = "your-domain.my.salesforce.com";
        let conn = gated_app_conn(
            &engine,
            "sf1",
            "salesforce",
            serde_json::json!({ "access_token": "t", "instance_host": "acme.my.salesforce.com" }),
        )
        .await;
        seed_connect(&store, host, vec![], vec![conn]).await;

        let res = resolve_rules(
            &ctx(),
            host,
            &engine,
            &*store,
            &[],
            None,
            Some("/services/data/v60.0/sobjects/Opportunity"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        assert!(!rules.injects(), "a mismatched host must inject nothing");
        let choices = rules.host_mismatch.as_deref().expect("mismatch recorded");
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].id, "sf1");
        assert_eq!(choices[0].host.as_deref(), Some("acme.my.salesforce.com"));

        // And the transport-failure answer for these rules is the 421, not
        // the opaque 502 — the #1137 shape (placeholder host, DNS failure).
        let resp: hyper::Response<TestBody> = transport_failure_response(
            &rules,
            &ctx(),
            host,
            &failed_get("/services/data/v60.0/sobjects/Opportunity"),
            &anyhow::anyhow!("dns error"),
        );
        assert_eq!(resp.status(), hyper::StatusCode::MISDIRECTED_REQUEST);
    }

    fn failed_get(path: &str) -> FailedRequest {
        FailedRequest {
            method: hyper::Method::GET,
            path: path.to_string(),
            start: std::time::Instant::now(),
        }
    }

    /// Without a recorded mismatch, a local failure keeps the generic
    /// `resolution_failed`, and a failed upstream send says the host could
    /// not be reached — never "failed to resolve rules".
    #[tokio::test]
    async fn transport_failure_without_mismatch_names_what_failed() {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        seed_connect(&store, HOST, vec![], vec![]).await;
        let res = resolve_rules(&ctx(), HOST, &engine, &*store, &[], None, Some("/x"))
            .await
            .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        assert!(rules.host_mismatch.is_none());

        let local = anyhow::anyhow!("buffering request body");
        let resp: hyper::Response<TestBody> =
            transport_failure_response(&rules, &ctx(), HOST, &failed_get("/x"), &local);
        assert_eq!(resp.status(), hyper::StatusCode::BAD_GATEWAY);
        assert_eq!(body_json(resp).await["error"], "resolution_failed");

        // A real reqwest send failure: nothing listens on the discard port.
        let send_err = reqwest::Client::new()
            .get("http://127.0.0.1:9/")
            .send()
            .await
            .expect_err("nothing listens on :9");
        let wrapped = anyhow::Error::new(send_err).context("forwarding to http://127.0.0.1:9/");
        assert!(is_upstream_send_failure(&wrapped));
        let resp: hyper::Response<TestBody> =
            transport_failure_response(&rules, &ctx(), HOST, &failed_get("/x"), &wrapped);
        assert_eq!(resp.status(), hyper::StatusCode::BAD_GATEWAY);
        let json = body_json(resp).await;
        assert_eq!(json["error"], "upstream_unreachable");
        assert_eq!(json["host"], HOST);
    }

    fn alias_conn(id: &str, instance_host: Option<&str>) -> db::AppConnectionRow {
        db::AppConnectionRow {
            id: id.to_string(),
            provider: "salesforce".to_string(),
            scope: "workspace".to_string(),
            credentials: None,
            label: Some("jane@acme.com".to_string()),
            metadata: instance_host.map(|h| serde_json::json!({ "bound_host": h })),
            session_policy: None,
        }
    }

    async fn resolve_alias(
        host: &str,
        alias_connections: Vec<db::AppConnectionRow>,
    ) -> Box<ResolvedRules> {
        let engine = PolicyEngine::test_stub();
        let store = cache::in_memory();
        let resp = ConnectResponse {
            workspace_id: Some("p1".to_string()),
            organization_id: Some("o1".to_string()),
            alias_connections,
            ..Default::default()
        };
        store
            .set(&format!("connect:o1:p1:tok:{host}"), &resp, 60)
            .await;
        let res = resolve_rules(
            &ctx(),
            host,
            &engine,
            &*store,
            &[],
            None,
            Some("/services/oauth2/userinfo"),
        )
        .await
        .unwrap();
        let ResolveResult::Resolved { rules, .. } = res else {
            panic!("expected Resolved");
        };
        rules
    }

    /// The prod incident: an agent with a connected Salesforce org calls
    /// `login.salesforce.com`. Nothing may inject there, but the request must
    /// carry the bound host so the failure is answered with it.
    #[tokio::test]
    async fn alias_host_records_the_bound_host_without_injecting() {
        let rules = resolve_alias(
            "login.salesforce.com",
            vec![alias_conn("sf1", Some("acme.my.salesforce.com"))],
        )
        .await;
        assert!(!rules.injects(), "an alias host must never inject");
        let choices = rules.host_mismatch.as_deref().expect("mismatch recorded");
        assert_eq!(choices[0].id, "sf1");
        assert_eq!(choices[0].host.as_deref(), Some("acme.my.salesforce.com"));
    }

    /// A stored host outside the provider's zone is never vouched for.
    #[tokio::test]
    async fn alias_host_never_vouches_for_an_out_of_zone_bound_host() {
        let rules = resolve_alias(
            "login.salesforce.com",
            vec![alias_conn("sf1", Some("evil.test"))],
        )
        .await;
        let choices = rules.host_mismatch.as_deref().expect("mismatch recorded");
        assert_eq!(choices[0].host, None);
    }

    /// No connection of the owning provider → no mismatch; the failure path
    /// falls through to the native connect link.
    #[tokio::test]
    async fn alias_host_without_connections_records_nothing() {
        let rules = resolve_alias("login.salesforce.com", vec![]).await;
        assert!(rules.host_mismatch.is_none());
    }
}
