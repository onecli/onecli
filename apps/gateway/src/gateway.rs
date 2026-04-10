//! HTTP gateway server: connection handling, MITM interception, and tunneling.
//!
//! This module owns the `GatewayServer` struct and the core request flow:
//! accept → authenticate → resolve (via [`connect`]) → MITM or tunnel.
//!
//! Axum handles normal HTTP routes (/healthz). CONNECT requests are intercepted
//! before reaching the router via a `tower::service_fn` wrapper, following the
//! official Axum http-proxy example pattern.
//!
//! Sub-modules handle specific stages of the proxy pipeline:
//! - [`forward`]: request forwarding, header filtering, unconnected app interception
//! - [`mitm`]: TLS interception with generated leaf certificates
//! - [`tunnel`]: direct TCP tunneling for non-intercepted domains
//! - [`response`]: pre-built gateway error responses

pub(crate) mod forward;
mod mitm;
mod response;
mod tunnel;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::State;
use axum::Router;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};

use crate::approval::{ApprovalDecision, ApprovalStore, APPROVAL_TIMEOUT_SECS};
use crate::apps;
use crate::auth::AuthUser;
use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::connect::{self, ConnectError, PolicyEngine};
use crate::inject;
use crate::vault;

// ── GatewayState ───────────────────────────────────────────────────────

/// Context for a proxied request, resolved at CONNECT time.
/// Wrapped in `Arc` and shared across all requests within a MITM session.
#[derive(Debug)]
pub(crate) struct ProxyContext {
    pub account_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub agent_identifier: Option<String>,
    pub agent_token: Option<String>,
}

/// Shared state for the gateway, passed to all request handlers.
#[derive(Clone)]
pub(crate) struct GatewayState {
    pub ca: Arc<CertificateAuthority>,
    /// Standard upstream client — validates TLS certificates.
    pub http_client: reqwest::Client,
    /// No-verify upstream client — skips TLS certificate validation.
    /// Selected for hosts matched by `skip_verify_hosts`.
    pub http_client_no_verify: reqwest::Client,
    /// Hostname patterns for which TLS certificate validation is skipped.
    /// Supports exact match (`internal.corp`) and wildcard prefix (`*.internal.corp`).
    /// Populated from `GATEWAY_SKIP_VERIFY_HOSTS` (comma-separated).
    pub skip_verify_hosts: Arc<Vec<String>>,
    pub policy_engine: Arc<PolicyEngine>,
    pub cache: Arc<dyn CacheStore>,
    /// Provider-agnostic vault service for credential fetching.
    pub vault_service: Arc<vault::VaultService>,
    /// Manual approval store for held requests.
    pub approval_store: Arc<dyn ApprovalStore>,
}

// ── GatewayServer ───────────────────────────────────────────────────────

pub struct GatewayServer {
    state: GatewayState,
    port: u16,
}

/// Build the HTTP client used for upstream requests.
///
/// - Redirects are disabled so 3xx responses are forwarded to the client as-is.
/// - `accept_invalid_certs` skips TLS certificate validation for upstream connections.
fn build_http_client(accept_invalid_certs: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .expect("build HTTP client")
}

/// Parse `GATEWAY_SKIP_VERIFY_HOSTS` into a list of hostname patterns.
///
/// Patterns support:
/// - Exact match: `internal.corp`
/// - Wildcard subdomain prefix: `*.internal.corp`
///
/// Falls back to empty (no hosts skip verification) if the variable is unset.
fn parse_skip_verify_hosts() -> Vec<String> {
    std::env::var("GATEWAY_SKIP_VERIFY_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Returns true if `host` matches any pattern in `patterns`.
///
/// - `*.example.com` matches `sub.example.com` but NOT `example.com` itself.
/// - `example.com` matches only `example.com`.
///
/// Patterns are pre-lowercased by `parse_skip_verify_hosts`.
fn host_matches_skip_verify(host: &str, patterns: &[String]) -> bool {
    let host = host.to_lowercase();
    patterns.iter().any(|pattern| {
        if let Some(suffix) = pattern.strip_prefix('*') {
            // "*.example.com" → suffix = ".example.com"
            host.ends_with(suffix) && host.len() > suffix.len()
        } else {
            host == *pattern
        }
    })
}

impl GatewayServer {
    pub fn new(
        ca: CertificateAuthority,
        port: u16,
        policy_engine: Arc<PolicyEngine>,
        vault_service: Arc<vault::VaultService>,
        cache: Arc<dyn CacheStore>,
        approval_store: Arc<dyn ApprovalStore>,
    ) -> Self {
        let global_skip = std::env::var("GATEWAY_DANGER_ACCEPT_INVALID_CERTS").is_ok();
        let skip_verify_hosts = Arc::new(parse_skip_verify_hosts());

        if global_skip {
            warn!("GATEWAY_DANGER_ACCEPT_INVALID_CERTS is set: TLS verification disabled for ALL upstream hosts");
        } else if !skip_verify_hosts.is_empty() {
            info!(hosts = ?skip_verify_hosts.as_ref(), "TLS verification disabled for matched hosts (GATEWAY_SKIP_VERIFY_HOSTS)");
        }

        let state = GatewayState {
            ca: Arc::new(ca),
            http_client: build_http_client(global_skip),
            http_client_no_verify: build_http_client(true),
            skip_verify_hosts,
            policy_engine,
            cache,
            vault_service,
            approval_store,
        };

        Self { state, port }
    }

    /// Start the gateway TCP listener. Runs forever.
    pub async fn run(&self) -> Result<()> {
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let listener = TcpListener::bind(addr)
            .await
            .context("binding TCP listener")?;

        info!(addr = %addr, "listening for connections");

        // CORS configuration for browser → gateway requests.
        // credentials: true requires explicit headers/methods (not wildcard *).
        let cors_layer = CorsLayer::new()
            .allow_origin(tower_http::cors::AllowOrigin::mirror_request())
            .allow_headers([
                hyper::header::CONTENT_TYPE,
                hyper::header::AUTHORIZATION,
                hyper::header::ACCEPT,
            ])
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_credentials(true);

        // Build the Axum router for non-CONNECT routes.
        // The fallback returns 400 Bad Request for anything other than defined routes.
        let axum_router = Router::new()
            .route("/healthz", axum::routing::get(healthz))
            .route("/me", axum::routing::get(me))
            .route(
                "/api/vault/{provider}/pair",
                axum::routing::post(vault::api::vault_pair),
            )
            .route(
                "/api/vault/{provider}/status",
                axum::routing::get(vault::api::vault_status),
            )
            .route(
                "/api/vault/{provider}/pair",
                axum::routing::delete(vault::api::vault_disconnect),
            )
            .route(
                "/api/cache/invalidate",
                axum::routing::post(invalidate_cache),
            )
            .route(
                "/api/approvals/pending",
                axum::routing::get(get_pending_approvals),
            )
            .route(
                "/api/approvals/{id}/decision",
                axum::routing::post(submit_approval_decision),
            )
            .layer(cors_layer)
            .fallback(fallback)
            .with_state(self.state.clone());

        loop {
            let (stream, peer_addr) = listener.accept().await?;
            let state = self.state.clone();
            let router = axum_router.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_connection(stream, peer_addr, state, router).await {
                    warn!(peer = %peer_addr, error = %e, "connection error");
                }
            });
        }
    }
}

// ── Axum route handlers ─────────────────────────────────────────────────

async fn healthz() -> StatusCode {
    StatusCode::OK
}

/// Protected: returns the authenticated user's ID.
async fn me(auth: AuthUser) -> String {
    auth.user_id
}

/// Invalidate all cached CONNECT responses for the authenticated account.
/// Called by the web app after secret/rule mutations so agents pick up
/// changes immediately instead of waiting for the 60-second TTL.
async fn invalidate_cache(
    auth: AuthUser,
    State(state): State<GatewayState>,
) -> impl axum::response::IntoResponse {
    let prefix = format!("connect:{}:", auth.account_id);
    state.cache.del_by_prefix(&prefix).await;
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "invalidated": true })),
    )
}

/// Query parameters for the pending approvals endpoint.
#[derive(serde::Deserialize)]
struct PendingParams {
    /// Comma-separated approval IDs to exclude (already being processed by the SDK).
    /// Allows the server to enter long-poll when all pending approvals are in-flight.
    #[serde(default)]
    exclude: String,
}

/// Long-poll for pending manual approval requests.
/// Returns immediately if new (non-excluded) approvals exist, otherwise waits up to 30s.
async fn get_pending_approvals(
    auth: AuthUser,
    State(state): State<GatewayState>,
    axum::extract::Query(params): axum::extract::Query<PendingParams>,
) -> impl axum::response::IntoResponse {
    let exclude: std::collections::HashSet<&str> = params
        .exclude
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let mut pending = state.approval_store.list_pending(&auth.account_id).await;
    pending.retain(|a| !exclude.contains(a.id.as_str()));

    if pending.is_empty() {
        let got_new = state
            .approval_store
            .wait_for_new(&auth.account_id, std::time::Duration::from_secs(30))
            .await;
        if got_new {
            let mut fresh = state.approval_store.list_pending(&auth.account_id).await;
            fresh.retain(|a| !exclude.contains(a.id.as_str()));
            pending = fresh;
        }
    }

    axum::Json(serde_json::json!({
        "requests": pending.iter().map(|a| serde_json::json!({
            "id": a.id,
            "method": a.method,
            "url": format!("{}://{}{}", a.scheme, a.host, a.path),
            "host": a.host,
            "path": a.path,
            "headers": a.headers,
            "bodyPreview": a.body_preview,
            "agent": { "id": a.agent_id, "name": a.agent_name, "externalId": a.agent_identifier },
            "createdAt": format_unix_ts(a.created_at),
            "expiresAt": format_unix_ts(a.expires_at),
        })).collect::<Vec<_>>(),
        "timeoutSeconds": APPROVAL_TIMEOUT_SECS,
    }))
}

/// Submit a decision for a pending manual approval request.
async fn submit_approval_decision(
    auth: AuthUser,
    State(state): State<GatewayState>,
    axum::extract::Path(approval_id): axum::extract::Path<String>,
    axum::Json(body): axum::Json<DecisionBody>,
) -> impl axum::response::IntoResponse {
    // O(1) lookup — verify approval exists and belongs to this account.
    match state.approval_store.get_pending(&approval_id).await {
        Some(a) if a.account_id == auth.account_id => {}
        _ => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({ "error": "approval_not_found" })),
            );
        }
    }

    let delivered = state
        .approval_store
        .submit_decision(&approval_id, body.decision)
        .await;

    if delivered {
        (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "success": true })),
        )
    } else {
        (
            StatusCode::GONE,
            axum::Json(serde_json::json!({ "error": "approval_expired" })),
        )
    }
}

/// Request body for the approval decision endpoint.
/// Deserializes directly into the enum — Axum returns 422 on invalid values.
#[derive(serde::Deserialize)]
struct DecisionBody {
    decision: ApprovalDecision,
}

/// Reject non-proxy, non-CONNECT requests to unknown routes with 400 Bad Request.
async fn fallback() -> StatusCode {
    StatusCode::BAD_REQUEST
}

/// An HTTP proxy request has an absolute URI with `http://` scheme
/// (RFC 7230 §5.3.2). Direct requests use origin-form (`/path`).
fn is_http_proxy_request<T>(req: &Request<T>) -> bool {
    req.uri().scheme_str() == Some("http")
}

// ── Connection handling ─────────────────────────────────────────────────

/// Handle a single client connection.
///
/// Uses a `service_fn` wrapper that intercepts CONNECT requests before they reach
/// the Axum router (CONNECT URIs like `host:port` don't match Axum's path-based routing).
/// All other HTTP routes (vault API, healthz, etc.) go through the Axum router.
async fn handle_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    state: GatewayState,
    router: Router,
) -> Result<()> {
    let io = TokioIo::new(stream);

    http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req: Request<Incoming>| {
                let state = state.clone();
                let router = router.clone();
                async move {
                    if req.method() == Method::CONNECT {
                        handle_connect(req, peer_addr, state).await
                    } else if is_http_proxy_request(&req) {
                        handle_http_proxy(req, peer_addr, state).await
                    } else {
                        // Axum handles all non-proxy routes (healthz, vault API, fallback)
                        let resp: Response<axum::body::Body> = router
                            .oneshot(req)
                            .await
                            .expect("axum router is infallible");
                        Ok(resp)
                    }
                }
            }),
        )
        .with_upgrades()
        .await
        .context("serving HTTP connection")
}

// ── CONNECT handling ────────────────────────────────────────────────────

/// Handle a CONNECT request: authenticate, resolve policy, then MITM or tunnel.
async fn handle_connect(
    req: Request<Incoming>,
    peer_addr: SocketAddr,
    state: GatewayState,
) -> Result<Response<axum::body::Body>, anyhow::Error> {
    let host = req
        .uri()
        .authority()
        .context("CONNECT request missing host:port")?
        .to_string();

    let hostname = strip_port(&host).to_string();

    // Extract agent token from Proxy-Authorization header.
    let agent_token = inject::extract_agent_token(&req).filter(|t| !t.is_empty());

    let (
        mut intercept,
        mut injection_rules,
        policy_rules,
        account_id,
        agent_id,
        agent_name,
        agent_identifier,
    ) = if let Some(ref token) = agent_token {
        match connect::resolve(token, &hostname, &state.policy_engine, &*state.cache).await {
            Ok(resp) => (
                resp.intercept,
                resp.injection_rules,
                resp.policy_rules,
                resp.account_id,
                resp.agent_id,
                resp.agent_name,
                resp.agent_identifier,
            ),
            Err(ConnectError::InvalidToken) => {
                warn!(peer = %peer_addr, host = %host, "CONNECT rejected: invalid agent token");
                return Ok(response::proxy_auth_required());
            }
            Err(ConnectError::Internal(e)) => {
                warn!(peer = %peer_addr, host = %host, error = %e, "CONNECT rejected: internal error");
                let mut resp = Response::new(axum::body::Body::empty());
                *resp.status_mut() = StatusCode::BAD_GATEWAY;
                return Ok(resp);
            }
        }
    } else {
        // No auth — plain tunnel (no MITM, no injection)
        (false, vec![], vec![], None, None, None, None)
    };

    // Vault fallback: if no DB secrets matched, try vault providers for this user.
    if !intercept {
        if let Some(ref aid) = account_id {
            if let Some(cred) = state.vault_service.request_credential(aid, &hostname).await {
                let vault_rules = inject::vault_credential_to_rules(&hostname, &cred);
                if !vault_rules.is_empty() {
                    intercept = true;
                    injection_rules = vault_rules;
                    info!(
                        host = %hostname,
                        account_id = %aid,
                        "using vault credential"
                    );
                }
            }
        }
    }

    // App-not-connected fallback: if an authenticated agent has no credentials
    // for a known app host, force MITM so forward_request can detect 401/403
    // and return an actionable error instead of tunneling blindly.
    if !intercept && agent_token.is_some() && apps::provider_for_host(&hostname).is_some() {
        intercept = true;
        info!(host = %hostname, "forcing MITM for known app (no credentials)");
    }

    info!(
        peer = %peer_addr,
        host = %host,
        mode = if intercept { "mitm" } else { "tunnel" },
        injection_count = injection_rules.len(),
        policy_count = policy_rules.len(),
        "CONNECT"
    );

    let ca = Arc::clone(&state.ca);
    let skip_verify = host_matches_skip_verify(&hostname, &state.skip_verify_hosts);
    let http_client = if skip_verify {
        info!(host = %hostname, "TLS verification skipped (GATEWAY_SKIP_VERIFY_HOSTS)");
        state.http_client_no_verify.clone()
    } else {
        state.http_client.clone()
    };
    let cache = Arc::clone(&state.cache);
    let approval_store = Arc::clone(&state.approval_store);
    let proxy_ctx = Arc::new(ProxyContext {
        account_id,
        agent_id,
        agent_name,
        agent_identifier,
        agent_token: agent_token.clone(),
    });

    tokio::spawn(async move {
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let result = if intercept {
                    mitm::mitm(
                        upgraded,
                        &host,
                        &ca,
                        http_client,
                        injection_rules,
                        policy_rules,
                        cache,
                        proxy_ctx,
                        approval_store,
                    )
                    .await
                } else {
                    tunnel::tunnel(upgraded, &host).await
                };
                if let Err(e) = result {
                    warn!(host = %host, error = %e, "connection error");
                }
            }
            Err(e) => {
                warn!(host = %host, error = %e, "upgrade failed");
            }
        }
    });

    // 200 tells the client the tunnel is established.
    Ok(Response::new(axum::body::Body::empty()))
}

// ── HTTP proxy handling ─────────────────────────────────────────────────

/// Handle a plain HTTP proxy request (absolute URI like `GET http://host/path`).
///
/// Unlike CONNECT, there is no tunnel upgrade or TLS — the gateway reads the
/// request directly, applies credential injection, and forwards upstream over HTTP.
async fn handle_http_proxy(
    req: Request<Incoming>,
    peer_addr: SocketAddr,
    state: GatewayState,
) -> Result<Response<axum::body::Body>, anyhow::Error> {
    let authority = req
        .uri()
        .authority()
        .context("HTTP proxy request missing authority")?
        .to_string();
    let hostname = strip_port(&authority).to_string();

    let agent_token = inject::extract_agent_token(&req).filter(|t| !t.is_empty());

    let (mut injection_rules, policy_rules, account_id, agent_id, agent_name, agent_identifier) =
        if let Some(ref token) = agent_token {
            match connect::resolve(token, &hostname, &state.policy_engine, &*state.cache).await {
                Ok(resp) => (
                    resp.injection_rules,
                    resp.policy_rules,
                    resp.account_id,
                    resp.agent_id,
                    resp.agent_name,
                    resp.agent_identifier,
                ),
                Err(ConnectError::InvalidToken) => {
                    warn!(peer = %peer_addr, host = %authority, "HTTP proxy rejected: invalid agent token");
                    return Ok(response::proxy_auth_required());
                }
                Err(ConnectError::Internal(e)) => {
                    warn!(peer = %peer_addr, host = %authority, error = %e, "HTTP proxy rejected: internal error");
                    let mut resp = Response::new(axum::body::Body::empty());
                    *resp.status_mut() = StatusCode::BAD_GATEWAY;
                    return Ok(resp);
                }
            }
        } else {
            (vec![], vec![], None, None, None, None)
        };

    // Vault fallback
    if injection_rules.is_empty() {
        if let Some(ref aid) = account_id {
            if let Some(cred) = state.vault_service.request_credential(aid, &hostname).await {
                let vault_rules = inject::vault_credential_to_rules(&hostname, &cred);
                if !vault_rules.is_empty() {
                    injection_rules = vault_rules;
                    info!(host = %hostname, account_id = %aid, "http_proxy: using vault credential");
                }
            }
        }
    }

    info!(
        peer = %peer_addr,
        host = %authority,
        injection_count = injection_rules.len(),
        policy_count = policy_rules.len(),
        "HTTP_PROXY"
    );

    let proxy_ctx = ProxyContext {
        account_id,
        agent_id,
        agent_name,
        agent_identifier,
        agent_token: agent_token.clone(),
    };

    let resp = forward::forward_request(
        req,
        &authority,
        "http",
        state.http_client.clone(),
        &injection_rules,
        &policy_rules,
        &*state.cache,
        &proxy_ctx,
        &state.approval_store,
    )
    .await?;

    // Convert the response body type to match the axum::body::Body return type
    Ok(resp.map(axum::body::Body::new))
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Format a unix timestamp (seconds) as an ISO 8601 UTC string.
/// Falls back to epoch if the timestamp is invalid.
fn format_unix_ts(secs: u64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let dt = UNIX_EPOCH + Duration::from_secs(secs);
    // time crate is already a dependency (for certificate validity)
    let odt = time::OffsetDateTime::from(dt);
    odt.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Strip port from a `host:port` string, returning just the hostname.
pub(crate) fn strip_port(host: &str) -> &str {
    host.split(':').next().unwrap_or(host)
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Verify that the production HTTP client does not follow redirects.
    /// A proxy must forward 3xx responses to the client so the client's HTTP
    /// library can see the full redirect chain (intermediate headers, etc.).
    #[tokio::test]
    async fn http_client_does_not_follow_redirects() {
        // Arrange: spin up a tiny server that always returns 302.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");

        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let resp = "HTTP/1.1 302 Found\r\n\
                            Location: http://example.com/other\r\n\
                            X-Repo-Commit: abc123\r\n\
                            Content-Length: 0\r\n\r\n";
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        // Act: use the same client the gateway uses in production.
        let client = build_http_client(false);
        let resp = client
            .get(format!("http://{addr}/test"))
            .send()
            .await
            .expect("send request");

        // Assert: 302 is returned as-is, not followed.
        assert_eq!(resp.status(), 302, "proxy client must not follow redirects");
        assert_eq!(
            resp.headers().get("location").and_then(|v| v.to_str().ok()),
            Some("http://example.com/other"),
        );
        // Intermediate headers like X-Repo-Commit must be visible to the client.
        assert_eq!(
            resp.headers()
                .get("x-repo-commit")
                .and_then(|v| v.to_str().ok()),
            Some("abc123"),
        );
    }

    // ── strip_port ──────────────────────────────────────────────────────

    #[test]
    fn strip_port_removes_port() {
        assert_eq!(strip_port("example.com:443"), "example.com");
        assert_eq!(strip_port("api.anthropic.com:8080"), "api.anthropic.com");
    }

    #[test]
    fn strip_port_handles_bare_hostname() {
        assert_eq!(strip_port("example.com"), "example.com");
        assert_eq!(strip_port("localhost"), "localhost");
    }

    #[test]
    fn strip_port_handles_ipv6_no_brackets() {
        // IPv6 with port typically uses brackets, but strip_port just splits on ':'
        // For bracket-wrapped IPv6 like [::1]:443, it returns "[" — this is acceptable
        // since hyper always sends host:port format for CONNECT
        assert_eq!(strip_port("[::1]:443"), "[");
    }

    #[test]
    fn strip_port_handles_empty() {
        assert_eq!(strip_port(""), "");
    }

    // ── host_matches_skip_verify ─────────────────────────────────────────

    #[test]
    fn skip_verify_exact_match() {
        let patterns = vec!["internal.corp".to_string()];
        assert!(host_matches_skip_verify("internal.corp", &patterns));
        assert!(!host_matches_skip_verify("other.corp", &patterns));
        assert!(!host_matches_skip_verify("sub.internal.corp", &patterns));
    }

    #[test]
    fn skip_verify_wildcard_matches_subdomains_only() {
        let patterns = vec!["*.internal.corp".to_string()];
        assert!(host_matches_skip_verify("foo.internal.corp", &patterns));
        assert!(host_matches_skip_verify("a.b.internal.corp", &patterns));
        assert!(!host_matches_skip_verify("internal.corp", &patterns));
        assert!(!host_matches_skip_verify("notinternal.corp", &patterns));
        assert!(!host_matches_skip_verify("evil-internal.corp", &patterns));
    }

    #[test]
    fn skip_verify_case_insensitive_host() {
        // Patterns are pre-lowercased by parse_skip_verify_hosts.
        // The match function lowercases the host input.
        let patterns = vec!["internal.corp".to_string()];
        assert!(host_matches_skip_verify("INTERNAL.CORP", &patterns));
        assert!(host_matches_skip_verify("Internal.Corp", &patterns));
        assert!(host_matches_skip_verify("internal.corp", &patterns));
    }

    #[test]
    fn skip_verify_empty_patterns_never_matches() {
        assert!(!host_matches_skip_verify("anything.com", &[]));
    }

    // ── parse_skip_verify_patterns ─────────────────────────────────────

    /// Helper: parse a raw comma-separated string the same way `parse_skip_verify_hosts` does.
    fn parse_patterns(input: &str) -> Vec<String> {
        input
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    }

    #[test]
    fn parse_skip_verify_splits_and_trims() {
        let hosts = parse_patterns(" foo.com , *.bar.com , baz.io ");
        assert_eq!(hosts, vec!["foo.com", "*.bar.com", "baz.io"]);
    }

    #[test]
    fn parse_skip_verify_empty_input() {
        assert!(parse_patterns("").is_empty());
    }

    // ── is_http_proxy_request ──────────────────────────────────────────

    #[test]
    fn http_proxy_detected_for_absolute_uri() {
        let req = Request::builder()
            .uri("http://api.local:8080/v1/data")
            .body(())
            .unwrap();
        assert!(is_http_proxy_request(&req));
    }

    #[test]
    fn http_proxy_not_detected_for_relative_uri() {
        let req = Request::builder().uri("/healthz").body(()).unwrap();
        assert!(!is_http_proxy_request(&req));
    }

    #[test]
    fn http_proxy_not_detected_for_https_uri() {
        // HTTPS absolute URIs shouldn't match — those use CONNECT
        let req = Request::builder()
            .uri("https://api.example.com/data")
            .body(())
            .unwrap();
        assert!(!is_http_proxy_request(&req));
    }
}
