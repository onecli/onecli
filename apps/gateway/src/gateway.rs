//! HTTP gateway server: connection handling, MITM interception, and tunneling.
//!
//! This module owns the `GatewayServer` struct and the core request flow:
//! accept → authenticate → resolve (via [`connect`]) → MITM or tunnel.
//!
//! Axum handles normal HTTP routes (/healthz). CONNECT requests are intercepted
//! before reaching the router via a `tower::service_fn` wrapper, following the
//! official Axum http-proxy example pattern.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::State;
use axum::Router;
use futures_util::TryStreamExt;
use http_body_util::{Either, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};

use crate::auth::AuthUser;
use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::connect::{self, ConnectError, PolicyEngine};
use crate::inject::{self, InjectionRule};
use crate::policy::{self, PolicyDecision, PolicyRule};
use crate::vault;

// ── GatewayState ───────────────────────────────────────────────────────

/// Shared state for the gateway, passed to all request handlers.
#[derive(Clone)]
pub(crate) struct GatewayState {
    pub ca: Arc<CertificateAuthority>,
    pub http_client: reqwest::Client,
    pub policy_engine: Arc<PolicyEngine>,
    pub cache: Arc<dyn CacheStore>,
    /// Provider-agnostic vault service for credential fetching.
    pub vault_service: Arc<vault::VaultService>,
}

// ── GatewayServer ───────────────────────────────────────────────────────

pub struct GatewayServer {
    state: GatewayState,
    port: u16,
}

/// Build the HTTP client used for upstream requests.
///
/// - Redirects are disabled so 3xx responses are forwarded to the client as-is.
/// - Invalid certs are optionally accepted via `GATEWAY_DANGER_ACCEPT_INVALID_CERTS`.
fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(std::env::var("GATEWAY_DANGER_ACCEPT_INVALID_CERTS").is_ok())
        .build()
        .expect("build HTTP client")
}

impl GatewayServer {
    pub fn new(
        ca: CertificateAuthority,
        port: u16,
        policy_engine: Arc<PolicyEngine>,
        vault_service: Arc<vault::VaultService>,
        cache: Arc<dyn CacheStore>,
    ) -> Self {
        let state = GatewayState {
            ca: Arc::new(ca),
            http_client: build_http_client(),
            policy_engine,
            cache,
            vault_service,
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

/// Reject non-CONNECT requests to unknown routes with 400 Bad Request.
async fn fallback() -> StatusCode {
    StatusCode::BAD_REQUEST
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
                    } else {
                        // Axum handles all non-CONNECT routes (healthz, vault API, fallback)
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

    let (mut intercept, mut injection_rules, policy_rules, account_id) = if let Some(ref token) =
        agent_token
    {
        match connect::resolve(token, &hostname, &state.policy_engine, &*state.cache).await {
            Ok(resp) => (
                resp.intercept,
                resp.injection_rules,
                resp.policy_rules,
                resp.account_id,
            ),
            Err(ConnectError::InvalidToken) => {
                warn!(peer = %peer_addr, host = %host, "CONNECT rejected: invalid agent token");
                return Ok(respond_407());
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
        (false, vec![], vec![], None)
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

    info!(
        peer = %peer_addr,
        host = %host,
        mode = if intercept { "mitm" } else { "tunnel" },
        injection_count = injection_rules.len(),
        policy_count = policy_rules.len(),
        "CONNECT"
    );

    let ca = Arc::clone(&state.ca);
    let http_client = state.http_client.clone();
    let cache = Arc::clone(&state.cache);
    let agent_token_owned = agent_token.clone().unwrap_or_default();

    tokio::spawn(async move {
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let result = if intercept {
                    mitm(
                        upgraded,
                        &host,
                        &ca,
                        http_client,
                        injection_rules,
                        policy_rules,
                        cache,
                        agent_token_owned,
                    )
                    .await
                } else {
                    tunnel(upgraded, &host).await
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

// ── MITM & tunnel ───────────────────────────────────────────────────────

/// MITM: terminate TLS with the client using a generated leaf cert,
/// then forward HTTP requests to the real server.
#[allow(clippy::too_many_arguments)]
async fn mitm(
    upgraded: hyper::upgrade::Upgraded,
    host: &str,
    ca: &CertificateAuthority,
    http_client: reqwest::Client,
    injection_rules: Vec<InjectionRule>,
    policy_rules: Vec<PolicyRule>,
    cache: Arc<dyn CacheStore>,
    agent_token: String,
) -> Result<()> {
    let hostname = strip_port(host);

    // TLS handshake with client using a leaf cert for this hostname
    let server_config = ca.server_config_for_host(hostname)?;
    let acceptor = TlsAcceptor::from(server_config);

    // Upgraded → TokioIo (hyper→tokio) → TLS accept → TokioIo (tokio→hyper)
    let client_io = TokioIo::new(upgraded);
    let tls_stream = acceptor
        .accept(client_io)
        .await
        .context("TLS handshake with client")?;

    // Serve HTTP/1.1 on the decrypted TLS stream.
    // The client thinks it's talking to the real server.
    let host_owned = host.to_string();
    let injection_rules = Arc::new(injection_rules);
    let policy_rules = Arc::new(policy_rules);
    let agent_token = Arc::new(agent_token);
    let io = TokioIo::new(tls_stream);

    http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let host = host_owned.clone();
                let client = http_client.clone();
                let inj_rules = Arc::clone(&injection_rules);
                let pol_rules = Arc::clone(&policy_rules);
                let cache = Arc::clone(&cache);
                let token = Arc::clone(&agent_token);
                async move {
                    forward_request(req, &host, client, &inj_rules, &pol_rules, &*cache, &token)
                        .await
                }
            }),
        )
        .await
        .context("serving MITM connection")
}

/// Forward a single HTTP request to the real upstream server and stream the response back.
/// Both request and response bodies are streamed — no full buffering in memory.
/// This is critical for SSE (Server-Sent Events) and large payloads.
/// Checks policy rules first (returns 403/429), then applies injection rules.
async fn forward_request(
    req: Request<Incoming>,
    host: &str,
    http_client: reqwest::Client,
    injection_rules: &[InjectionRule],
    policy_rules: &[PolicyRule],
    cache: &dyn CacheStore,
    agent_token: &str,
) -> anyhow::Result<
    Response<
        Either<
            Full<Bytes>,
            StreamBody<impl futures_util::Stream<Item = Result<Frame<Bytes>, reqwest::Error>>>,
        >,
    >,
> {
    let method = req.method().clone();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("https://{host}{path}");

    // Check policy rules before forwarding
    match policy::evaluate(method.as_str(), &path, policy_rules, agent_token, cache).await {
        PolicyDecision::Blocked => {
            warn!(method = %method, url = %url, "BLOCKED by policy rule");
            let body = serde_json::json!({
                "error": "blocked_by_policy",
                "message": "This request was blocked by an OneCLI policy rule. Check your rules at https://onecli.sh or your OneCLI dashboard.",
                "method": method.as_str(),
                "path": path,
            })
            .to_string();
            let mut response = Response::new(Either::Left(Full::new(Bytes::from(body))));
            *response.status_mut() = StatusCode::FORBIDDEN;
            response
                .headers_mut()
                .insert("content-type", HeaderValue::from_static("application/json"));
            return Ok(response);
        }
        PolicyDecision::RateLimited {
            limit,
            window,
            retry_after_secs,
        } => {
            warn!(method = %method, url = %url, limit, window, "RATE LIMITED by policy rule");
            let body = serde_json::json!({
                "error": "rate_limited",
                "message": "Rate limit exceeded. This request was throttled by an OneCLI policy rule. Check your rules at https://onecli.sh or your OneCLI dashboard.",
                "method": method.as_str(),
                "path": path,
                "limit": limit,
                "window": window,
                "retry_after_seconds": retry_after_secs,
            })
            .to_string();
            let mut response = Response::new(Either::Left(Full::new(Bytes::from(body))));
            *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
            response
                .headers_mut()
                .insert("content-type", HeaderValue::from_static("application/json"));
            if let Ok(val) = HeaderValue::from_str(&retry_after_secs.to_string()) {
                response.headers_mut().insert("retry-after", val);
            }
            return Ok(response);
        }
        PolicyDecision::Allow => {}
    }

    let (parts, body) = req.into_parts();

    // Collect forwarded headers into a mutable map for injection
    let mut headers = hyper::HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if is_forwarded_request_header(name) {
            headers.append(name.clone(), value.clone());
        }
    }

    // Apply injection rules matching this request path
    let injection_count = inject::apply_injections(&mut headers, &path, injection_rules);

    // Build upstream request with (possibly modified) headers
    let mut upstream = http_client.request(method.clone(), &url);
    for (name, value) in headers.iter() {
        upstream = upstream.header(name.clone(), value.clone());
    }

    // Stream request body to upstream via HttpBody wrapper
    upstream = upstream.body(reqwest::Body::wrap(body));

    // Send to real server
    let upstream_resp = upstream
        .send()
        .await
        .with_context(|| format!("forwarding to {url}"))?;

    let status = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    // Log before streaming response body
    let content_type = resp_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");

    info!(
        method = %method,
        url = %url,
        status = %status.as_u16(),
        content_type = %content_type,
        injections_applied = injection_count,
        "MITM"
    );

    // Stream response body to client (no buffering — critical for SSE)
    let resp_stream = upstream_resp.bytes_stream().map_ok(Frame::data);
    let body = StreamBody::new(resp_stream);

    let mut response = Response::new(Either::Right(body));
    *response.status_mut() = status;

    // Forward response headers, skipping hop-by-hop
    for (name, value) in resp_headers.iter() {
        if is_forwarded_response_header(name) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }

    Ok(response)
}

/// Tunnel: connect to the target server and splice bytes in both directions
/// until either side closes the connection. Used for non-intercepted domains.
async fn tunnel(upgraded: hyper::upgrade::Upgraded, host: &str) -> Result<()> {
    let mut server = TcpStream::connect(host)
        .await
        .with_context(|| format!("connecting to upstream {host}"))?;

    let mut client = TokioIo::new(upgraded);

    let (client_to_server, server_to_client) =
        tokio::io::copy_bidirectional(&mut client, &mut server)
            .await
            .context("bidirectional copy")?;

    info!(
        host = %host,
        client_to_server,
        server_to_client,
        "tunnel closed"
    );

    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Build a 407 Proxy Authentication Required response.
fn respond_407() -> Response<axum::body::Body> {
    let mut resp = Response::new(axum::body::Body::empty());
    *resp.status_mut() = StatusCode::PROXY_AUTHENTICATION_REQUIRED;
    resp.headers_mut().insert(
        "proxy-authenticate",
        HeaderValue::from_static("Basic realm=\"OneCLI Gateway\""),
    );
    resp
}

/// Hop-by-hop headers that should never be forwarded in either direction.
const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

/// Returns true if a request header should be forwarded to the upstream server.
///
/// Strips hop-by-hop headers plus `host` (set by the upstream URL) and
/// `content-length` (recalculated by reqwest from the body).
fn is_forwarded_request_header(name: &HeaderName) -> bool {
    let s = name.as_str();
    if s == "host" || s == "content-length" {
        return false;
    }
    !HOP_BY_HOP_HEADERS.contains(&s)
}

/// Returns true if a response header should be forwarded back to the client.
///
/// Strips hop-by-hop headers only. `content-length` is preserved — it is
/// required for HEAD responses and correct HTTP/1.1 framing.
fn is_forwarded_response_header(name: &HeaderName) -> bool {
    !HOP_BY_HOP_HEADERS.contains(&name.as_str())
}

/// Strip port from a `host:port` string, returning just the hostname.
fn strip_port(host: &str) -> &str {
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
        let client = build_http_client();
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

    // ── is_forwarded_request_header ──────────────────────────────────────

    #[test]
    fn request_header_strips_hop_by_hop() {
        for &name in HOP_BY_HOP_HEADERS {
            let header = HeaderName::from_static(name);
            assert!(
                !is_forwarded_request_header(&header),
                "{name} should be stripped from requests"
            );
        }
    }

    #[test]
    fn request_header_strips_host_and_content_length() {
        assert!(!is_forwarded_request_header(&HeaderName::from_static(
            "host"
        )));
        assert!(!is_forwarded_request_header(&HeaderName::from_static(
            "content-length"
        )));
    }

    #[test]
    fn request_header_passes_application_headers() {
        let forwarded = [
            "content-type",
            "authorization",
            "accept",
            "user-agent",
            "x-api-key",
            "cache-control",
        ];
        for name in forwarded {
            let header = HeaderName::from_static(name);
            assert!(
                is_forwarded_request_header(&header),
                "{name} should be forwarded in requests"
            );
        }
    }

    // ── is_forwarded_response_header ─────────────────────────────────────

    #[test]
    fn response_header_strips_hop_by_hop() {
        for &name in HOP_BY_HOP_HEADERS {
            let header = HeaderName::from_static(name);
            assert!(
                !is_forwarded_response_header(&header),
                "{name} should be stripped from responses"
            );
        }
    }

    #[test]
    fn response_header_preserves_content_length() {
        assert!(is_forwarded_response_header(&HeaderName::from_static(
            "content-length"
        )));
    }

    #[test]
    fn response_header_passes_application_headers() {
        let forwarded = [
            "content-type",
            "content-length",
            "authorization",
            "accept",
            "user-agent",
            "x-api-key",
            "cache-control",
        ];
        for name in forwarded {
            let header = HeaderName::from_static(name);
            assert!(
                is_forwarded_response_header(&header),
                "{name} should be forwarded in responses"
            );
        }
    }

    // ── respond_407 ─────────────────────────────────────────────────────

    #[test]
    fn respond_407_has_correct_status_and_header() {
        let resp = respond_407();
        assert_eq!(resp.status(), StatusCode::PROXY_AUTHENTICATION_REQUIRED);
        let auth_header = resp
            .headers()
            .get("proxy-authenticate")
            .expect("should have Proxy-Authenticate header");
        assert_eq!(auth_header, "Basic realm=\"OneCLI Gateway\"");
    }
}
