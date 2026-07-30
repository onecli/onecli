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

mod body;
#[cfg(edition_cloud)]
#[path = "ee/response.rs"]
mod ee_response;
mod finalizers;
pub(crate) mod forward;
mod hints;
#[cfg(edition_oss)]
pub(crate) mod hooks;
#[cfg(any(edition_onprem_slim, edition_onprem_full))]
#[path = "ee/onprem/hooks.rs"]
pub(crate) mod hooks;
#[cfg(edition_cloud)]
#[path = "ee/hooks.rs"]
pub(crate) mod hooks;
mod mitm;
// `pub(crate)` so `main` can report at startup whether dashboard links will be
// built from a configured APP_URL or from the fallback.
pub(crate) mod response;
mod transforms;
mod tunnel;
mod websocket;

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
use tokio_rustls::TlsConnector;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tracing::{debug, info, info_span, warn, Instrument};

use crate::approval::{ApprovalDecision, ApprovalStore, APPROVAL_TIMEOUT_SECS};
use crate::auth::AuthUser;
use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::connect::{self, AppConnectionResult, ConnectError, PolicyEngine};
use crate::db;
use crate::inject;
use crate::vault;

/// Pause before retrying a failed `accept`, so a persistent error (a truly
/// exhausted fd table) cannot spin the loop at full tilt.
const ACCEPT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);

// ── GatewayState ───────────────────────────────────────────────────────

/// Context for a proxied request, resolved at CONNECT time.
/// Wrapped in `Arc` and shared across all requests within a MITM session.
#[derive(Debug)]
pub(crate) struct ProxyContext {
    pub project_id: Option<String>,
    pub organization_id: Option<String>,
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
    /// Standard upstream connector for the WebSocket leg, which reqwest does
    /// not serve — validates TLS certificates.
    pub ws_connector: TlsConnector,
    /// No-verify WebSocket connector — skips TLS certificate validation.
    /// Selected for hosts matched by `skip_verify_hosts`, exactly as
    /// `http_client_no_verify` is.
    pub ws_connector_no_verify: TlsConnector,
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

/// Accepts any server certificate, for the hosts an operator has explicitly
/// exempted from verification.
///
/// This is deliberately the same posture `reqwest`'s `danger_accept_invalid_certs`
/// gives the HTTP path: chain, hostname *and* handshake signature all go
/// unchecked. Parity is the point — an operator who exempts an internal host
/// expects it to work over both protocols, and the appliances that need the
/// exemption at all are exactly the ones with certificates and signature
/// algorithms nothing modern will accept.
#[derive(Debug)]
struct AcceptAnyServerCert;

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    // Both signature paths must be stubbed: rustls calls exactly one depending
    // on the negotiated version, and TLS 1.2 is still reachable here.
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    /// This list is load-bearing, not decoration: it becomes the ClientHello's
    /// `signature_algorithms`. Return nothing and the server finds no acceptable
    /// scheme and aborts *before sending a certificate* — the verifier above
    /// never runs, and skipping verification manifests as an unexplained
    /// handshake failure.
    ///
    /// Copied from reqwest so the two paths advertise the same thing. It
    /// deliberately includes schemes our own provider cannot verify (SHA-1,
    /// Ed448) — harmless, because nothing here verifies anything, and it is
    /// what lets a legacy appliance find something it can sign with.
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        use rustls::SignatureScheme;
        vec![
            SignatureScheme::RSA_PKCS1_SHA1,
            SignatureScheme::ECDSA_SHA1_Legacy,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
            SignatureScheme::ED448,
        ]
    }
}

/// Build the TLS config used to dial upstream WebSocket servers.
///
/// The sibling of [`build_http_client`], and built the same way for the same
/// reason: the WebSocket leg dials the same upstreams as the HTTP leg, so it
/// has to honor the same verification exemptions. Built once at startup rather
/// than per upgrade — a rustls config is expensive to assemble.
///
/// # Panics
///
/// Requires the process-default [`rustls::crypto::CryptoProvider`] that `main`
/// installs at startup: with both `ring` and `aws_lc_rs` compiled in, rustls
/// cannot choose one itself and `ClientConfig::builder()` panics.
fn build_ws_tls_config(accept_invalid_certs: bool) -> Arc<rustls::ClientConfig> {
    let mut config = if accept_invalid_certs {
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert))
            .with_no_client_auth()
    } else {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth()
    };
    // The upstream leg speaks HTTP/1.1 — an upgrade cannot ride h2 here.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
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
            ws_connector: TlsConnector::from(build_ws_tls_config(global_skip)),
            ws_connector_no_verify: TlsConnector::from(build_ws_tls_config(true)),
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

        // Report what we actually bound rather than what we asked for: with
        // `--port 0` the OS assigns the port, and the requested address would
        // report `:0` — leaving no way to discover where the gateway is listening.
        let bound_addr = listener.local_addr().context("reading bound address")?;

        info!(addr = %bound_addr, "listening for connections");

        // CORS configuration for browser → gateway requests.
        // credentials: true requires explicit headers/methods (not wildcard *).
        let cors_layer = CorsLayer::new()
            .allow_origin(tower_http::cors::AllowOrigin::mirror_request())
            .allow_headers([
                hyper::header::CONTENT_TYPE,
                hyper::header::AUTHORIZATION,
                hyper::header::ACCEPT,
                // Cloud scopes browser → gateway vault calls to the active
                // project via this header; it must be allow-listed or the CORS
                // preflight blocks the request. (OSS never sends it.)
                hyper::header::HeaderName::from_static("x-project-id"),
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
            // /v1 routes
            .route(
                "/v1/vault/{provider}/pair",
                axum::routing::post(vault::api::vault_pair),
            )
            .route(
                "/v1/vault/{provider}/status",
                axum::routing::get(vault::api::vault_status),
            )
            .route(
                "/v1/vault/{provider}/pair",
                axum::routing::delete(vault::api::vault_disconnect),
            )
            // 1Password value picker (browse vaults → items → fields)
            .route(
                "/v1/vault/onepassword/vaults",
                axum::routing::get(vault::api::vault_op_vaults),
            )
            .route(
                "/v1/vault/onepassword/vaults/{vaultId}/items",
                axum::routing::get(vault::api::vault_op_items),
            )
            .route(
                "/v1/vault/onepassword/items/{vaultId}/{itemId}/fields",
                axum::routing::get(vault::api::vault_op_fields),
            )
            .route(
                "/v1/cache/invalidate",
                axum::routing::post(invalidate_cache),
            )
            .route(
                "/v1/approvals/pending",
                axum::routing::get(get_pending_approvals),
            )
            .route(
                "/v1/approvals/{id}/decision",
                axum::routing::post(submit_approval_decision),
            )
            // /api legacy routes (backwards compatibility)
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
            // 1Password value picker (legacy /api alias)
            .route(
                "/api/vault/onepassword/vaults",
                axum::routing::get(vault::api::vault_op_vaults),
            )
            .route(
                "/api/vault/onepassword/vaults/{vaultId}/items",
                axum::routing::get(vault::api::vault_op_items),
            )
            .route(
                "/api/vault/onepassword/items/{vaultId}/{itemId}/fields",
                axum::routing::get(vault::api::vault_op_fields),
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
            );

        // Org-scoped routes are mounted via an edition-swapped seam
        // (`ee/org_routes.rs` for cloud + onprem, an identity stub for OSS — see
        // `main.rs`), so the org handler never reaches the OSS build.
        let axum_router = crate::org_routes::mount(axum_router)
            .layer(cors_layer)
            .fallback(fallback)
            .with_state(self.state.clone());

        let mut shutdown_signal = crate::shutdown::subscribe();

        loop {
            let (stream, peer_addr) = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok(conn) => conn,
                    Err(e) => {
                        // Accept failures are almost always transient and
                        // self-healing (EMFILE clears as connections close,
                        // ECONNABORTED is a client that gave up mid-handshake).
                        // Propagating one would tear down every healthy
                        // connection this proxy is carrying.
                        warn!(error = %e, "accept failed; retrying");
                        tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                        continue;
                    }
                },
                _ = shutdown_signal.wait() => break,
            };

            let state = self.state.clone();
            let router = axum_router.clone();
            let guard = crate::shutdown::task_guard();

            tokio::spawn(async move {
                let _guard = guard;
                if let Err(e) = handle_connection(stream, peer_addr, state, router).await {
                    warn!(peer = %peer_addr, error = ?e, "connection error");
                }
            });
        }

        // Closing the port is what stops new work: anything that connects from
        // here on is refused rather than accepted into a process on its way
        // out. Dropped explicitly rather than at the end of the scope so the
        // port is provably shut before the line below claims it is.
        drop(listener);
        info!("listener closed — draining connections");
        Ok(())
    }
}

// ── Axum route handlers ─────────────────────────────────────────────────

async fn healthz() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "status": "ok",
        "version": crate::version::app_version(),
    }))
}

/// Protected: returns the authenticated user's ID.
async fn me(auth: AuthUser) -> String {
    auth.user_id
}

/// Invalidate all cached CONNECT responses for the authenticated project.
/// Called by the web app after secret/rule mutations so agents pick up
/// changes immediately instead of waiting for the 60-second TTL.
async fn invalidate_cache(
    auth: AuthUser,
    State(state): State<GatewayState>,
) -> impl axum::response::IntoResponse {
    let span = info_span!("cache_invalidate",
        project_id = %auth.project_id,
        user_id = %auth.user_id,
        auth_method = %auth.auth_method,
    );
    async move {
        let org_id =
            match db::find_organization_id_by_project(&state.policy_engine.pool, &auth.project_id)
                .await
            {
                Ok(Some(oid)) => oid,
                other => {
                    warn!(
                        error = ?other.err(),
                        "cache invalidation: failed to resolve org_id; using broad prefix"
                    );
                    String::new()
                }
            };

        state
            .cache
            .del_by_prefix(&format!("app_injection:{org_id}:{}:", auth.project_id))
            .await;
        state
            .cache
            .del_by_prefix(&format!("connect:{org_id}:{}:", auth.project_id))
            .await;
        info!("cache invalidated");
        (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "invalidated": true })),
        )
    }
    .instrument(span)
    .await
}

/// Query parameters for the pending approvals endpoint.
/// `pub(crate)` so the org route in `org_routes` can reuse the same shape.
#[derive(serde::Deserialize)]
pub(crate) struct PendingParams {
    /// Comma-separated approval IDs to exclude (already being processed by the SDK).
    /// Allows the server to enter long-poll when all pending approvals are in-flight.
    #[serde(default)]
    pub(crate) exclude: String,
}

/// Long-poll for pending manual approval requests.
/// Returns immediately if new (non-excluded) approvals exist, otherwise waits up to 30s.
async fn get_pending_approvals(
    auth: AuthUser,
    State(state): State<GatewayState>,
    axum::extract::Query(params): axum::extract::Query<PendingParams>,
) -> impl axum::response::IntoResponse {
    let span = info_span!("approval_poll",
        project_id = %auth.project_id,
        user_id = %auth.user_id,
        auth_method = %auth.auth_method,
    );
    async move {
        let org_id = db::find_organization_id_by_project(&state.policy_engine.pool, &auth.project_id)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();

        let exclude: std::collections::HashSet<&str> = params
            .exclude
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        info!(exclude_count = exclude.len(), "approval poll started");

        let mut pending = state.approval_store.list_pending(&org_id, &auth.project_id).await;
        pending.retain(|a| !exclude.contains(a.id.as_str()));

        let mut long_polled = false;
        if pending.is_empty() {
            long_polled = true;
            let mut shutdown_signal = crate::shutdown::subscribe();
            // A poller holding a connection open for 30 seconds would pin the
            // drain for its whole window. Answer "nothing pending" at once and
            // let the SDK re-poll against the replacement instance.
            let got_new = tokio::select! {
                got_new = state.approval_store.wait_for_new(
                    &org_id,
                    &auth.project_id,
                    std::time::Duration::from_secs(30),
                ) => got_new,
                _ = shutdown_signal.wait() => false,
            };
            if got_new {
                let mut fresh = state.approval_store.list_pending(&org_id, &auth.project_id).await;
                fresh.retain(|a| !exclude.contains(a.id.as_str()));
                pending = fresh;
            }
        }

        info!(count = pending.len(), long_polled, "approval poll completed");

        axum::Json(serde_json::json!({
            "requests": pending.iter().map(|a| serde_json::json!({
                "id": a.id,
                "projectId": a.project_id,
                "method": a.method,
                "url": format!("{}://{}{}", a.scheme, a.host, a.path),
                "host": a.host,
                "path": a.path,
                "headers": a.headers,
                "bodyPreview": a.body_preview,
                "summary": a.summary,
                "agent": { "id": a.agent_id, "name": a.agent_name, "externalId": a.agent_identifier },
                "createdAt": format_unix_ts(a.created_at),
                "expiresAt": format_unix_ts(a.expires_at),
            })).collect::<Vec<_>>(),
            "timeoutSeconds": APPROVAL_TIMEOUT_SECS,
        }))
    }
    .instrument(span)
    .await
}

/// Submit a decision for a pending manual approval request.
async fn submit_approval_decision(
    auth: AuthUser,
    State(state): State<GatewayState>,
    axum::extract::Path(approval_id): axum::extract::Path<String>,
    axum::Json(body): axum::Json<DecisionBody>,
) -> impl axum::response::IntoResponse {
    let span = info_span!("approval_decision",
        project_id = %auth.project_id,
        user_id = %auth.user_id,
        auth_method = %auth.auth_method,
        approval_id = %approval_id,
    );
    async move {
        let org_id =
            db::find_organization_id_by_project(&state.policy_engine.pool, &auth.project_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();

        // O(1) lookup — verify approval exists and belongs to this project.
        match state
            .approval_store
            .get_pending(&org_id, &auth.project_id, &approval_id)
            .await
        {
            Some(a) if a.project_id == auth.project_id => {}
            _ => {
                warn!("approval decision rejected: not found or wrong project");
                return (
                    StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({ "error": "approval_not_found" })),
                );
            }
        }

        let decision_str = match body.decision {
            ApprovalDecision::Approve => "approve",
            ApprovalDecision::Deny => "deny",
        };

        info!(decision = decision_str, "approval decision submitted");

        let delivered = state
            .approval_store
            .submit_decision(
                &org_id,
                &auth.project_id,
                &approval_id,
                body.decision,
                Some(auth.user_id),
            )
            .await;

        if delivered {
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "success": true })),
            )
        } else {
            warn!(
                decision = decision_str,
                "approval decision submitted but approval already expired"
            );
            (
                StatusCode::GONE,
                axum::Json(serde_json::json!({ "error": "approval_expired" })),
            )
        }
    }
    .instrument(span)
    .await
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

/// An HTTP proxy request has an absolute URI with `http://` or `https://`
/// scheme (RFC 7230 §5.3.2). Direct requests use origin-form (`/path`).
/// Also matches `https://` because some clients (axios v1.x) send absolute-form
/// HTTPS URIs to the proxy port instead of using CONNECT.
fn is_http_proxy_request<T>(req: &Request<T>) -> bool {
    matches!(req.uri().scheme_str(), Some("http" | "https"))
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

    let conn = http1::Builder::new()
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
        .with_upgrades();
    tokio::pin!(conn);

    let mut shutdown_signal = crate::shutdown::subscribe();

    // One select, no loop: the signal is monotonic, so once it fires there is
    // nothing left to race against. `graceful_shutdown` turns off keep-alive —
    // an idle connection closes at once, an in-flight request still gets its
    // response, and a CONNECT that has already upgraded is unaffected (its
    // session runs in its own task, under its own guard).
    tokio::select! {
        result = conn.as_mut() => result.context("serving HTTP connection"),
        _ = shutdown_signal.wait() => {
            conn.as_mut().graceful_shutdown();
            conn.await.context("draining HTTP connection")
        }
    }
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

    // Resolve at CONNECT time for the intercept decision and agent identity.
    // DB injection/policy rules are NOT frozen here — they're re-resolved
    // per request inside the MITM tunnel from cache (see mitm.rs).
    let (mut intercept, project_id, organization_id, agent_id, agent_name, agent_identifier) =
        if let Some(ref token) = agent_token {
            match connect::resolve(token, &hostname, &state.policy_engine, &*state.cache).await {
                Ok(resp) => (
                    resp.intercept,
                    resp.project_id,
                    resp.organization_id,
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
                    return Ok(response::bad_gateway());
                }
            }
        } else {
            (false, None, None, None, None, None)
        };

    // Vault fallback: resolved at CONNECT time and passed to mitm as a frozen
    // fallback. Vault queries are expensive (network calls to Bitwarden), so
    // they're not repeated per request. DB secrets (re-resolved per request
    // from cache) take precedence when available.
    let mut vault_injection_rules = vec![];
    if !intercept {
        if let Some(ref aid) = project_id {
            if let Some(cred) = state.vault_service.request_credential(aid, &hostname).await {
                let vault_rules = inject::vault_credential_to_rules(&hostname, &cred);
                if !vault_rules.is_empty() {
                    intercept = true;
                    vault_injection_rules = vault_rules;
                    info!(
                        host = %hostname,
                        project_id = %aid,
                        "using vault credential"
                    );
                }
            }
        }
    }

    // Force MITM for all authenticated agent requests so the gateway can
    // intercept auth errors (401/403/400) and provide actionable guidance
    // (credential_not_found, app_not_connected, access_restricted).
    if !intercept && agent_token.is_some() {
        intercept = true;
    }

    let session_span = info_span!("session",
        peer = %peer_addr,
        host = %host,
        project_id = project_id.as_deref().unwrap_or("-"),
        org_id = organization_id.as_deref().unwrap_or("-"),
        agent = agent_name.as_deref().unwrap_or("-"),
        agent_id = agent_id.as_deref().unwrap_or("-"),
    );

    info!(
        parent: &session_span,
        mode = if intercept { "mitm" } else { "tunnel" },
        "CONNECT"
    );

    let ca = Arc::clone(&state.ca);
    let skip_verify = host_matches_skip_verify(&hostname, &state.skip_verify_hosts);
    // Both legs picked in one branch, deliberately: HTTP and WebSocket dial the
    // same upstreams, so a host they disagree about would mean traffic verified
    // on one protocol and not the other. One branch makes that unrepresentable
    // rather than merely true today.
    let (http_client, ws_connector) = if skip_verify {
        info!(parent: &session_span, "TLS verification skipped (GATEWAY_SKIP_VERIFY_HOSTS)");
        (
            state.http_client_no_verify.clone(),
            state.ws_connector_no_verify.clone(),
        )
    } else {
        (state.http_client.clone(), state.ws_connector.clone())
    };
    let cache = Arc::clone(&state.cache);
    let approval_store = Arc::clone(&state.approval_store);
    let proxy_ctx = Arc::new(ProxyContext {
        project_id,
        organization_id,
        agent_id,
        agent_name,
        agent_identifier,
        agent_token: agent_token.clone(),
    });

    // Taken here, before the spawn, so the session is tracked from the moment
    // it is promised rather than from whenever the new task first runs — the
    // accept task's own guard drops as soon as the upgrade is dispatched.
    let session_guard = crate::shutdown::task_guard();

    tokio::spawn(
        async move {
            match hyper::upgrade::on(req).await {
                Ok(upgraded) => {
                    let result = if intercept {
                        // A MITM session is HTTP: the drain waits for it, and
                        // its inner connection gets its own graceful shutdown.
                        let _guard = session_guard;
                        mitm::mitm(
                            upgraded,
                            &host,
                            &ca,
                            http_client,
                            ws_connector,
                            vault_injection_rules,
                            cache,
                            proxy_ctx,
                            approval_store,
                            Arc::clone(&state.policy_engine),
                        )
                        .await
                    } else {
                        // A raw tunnel is an indefinite byte pipe with no
                        // request boundary to finish on. Waiting for one would
                        // mean every shutdown takes the full deadline, so it is
                        // deliberately untracked and cut when the process exits.
                        drop(session_guard);
                        tunnel::tunnel(upgraded, &host).await
                    };
                    if let Err(e) = result {
                        warn!(host = %host, error = ?e, "connection error");
                    }
                }
                Err(e) => {
                    warn!(host = %host, error = %e, "upgrade failed");
                }
            }
        }
        .instrument(session_span),
    );

    // 200 tells the client the tunnel is established.
    Ok(Response::new(axum::body::Body::empty()))
}

// ── HTTP proxy handling ─────────────────────────────────────────────────

/// Handle a plain HTTP proxy request (absolute URI like `GET http(s)://host/path`).
///
/// Unlike CONNECT, there is no tunnel upgrade — the gateway reads the request
/// directly, applies credential injection, and forwards upstream over the
/// original scheme (reqwest handles TLS transparently for `https://`).
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
    // Static-map to avoid borrowing from `req`, which is moved below.
    let scheme: &'static str = match req.uri().scheme_str() {
        Some("https") => "https",
        _ => "http",
    };
    let hostname = strip_port(&authority).to_string();

    let agent_token = inject::extract_agent_token(&req).filter(|t| !t.is_empty());

    let connection_id = connect::extract_connection_id(req.headers());

    let mut resolved = if let Some(ref token) = agent_token {
        match connect::resolve(token, &hostname, &state.policy_engine, &*state.cache).await {
            Ok(resp) => resp,
            Err(ConnectError::InvalidToken) => {
                warn!(peer = %peer_addr, host = %authority, "HTTP proxy rejected: invalid agent token");
                return Ok(response::proxy_auth_required());
            }
            Err(ConnectError::Internal(e)) => {
                warn!(peer = %peer_addr, host = %authority, error = %e, "HTTP proxy rejected: internal error");
                return Ok(response::bad_gateway());
            }
        }
    } else {
        connect::ConnectResponse::default()
    };

    // Per-request app connection disambiguation — app rules MERGE with the
    // secret rules (see inject::merge_injection_rules; #428). When the secret
    // rules already serve this request's path, app-side escalations are
    // best-effort no-ops rather than failures of a request the secret alone
    // satisfies.
    let mut resolved_finalizer: Option<crate::apps::RequestFinalizer> = None;
    let mut resolved_body_transform: Option<crate::apps::BodyTransform> = None;
    // Granular-access policy of the connection that wins injection (if any).
    let mut resolved_session_policy: Option<serde_json::Value> = None;
    // Id of the connection that wins injection — same attribution law as
    // `resolved_session_policy`; unlike `connection_label` below, it MUST be
    // threaded (policy decisions bind to it).
    let mut resolved_connection_id: Option<String> = None;
    if !resolved.app_connections.is_empty() {
        let oid = resolved.organization_id.as_deref().unwrap_or("");
        let pid = resolved.project_id.as_deref().unwrap_or("");
        let request_path = req.uri().path_and_query().map(|pq| pq.as_str());
        let secret_rules = std::mem::take(&mut resolved.injection_rules);
        let secrets_serve = inject::rules_serve_path(&secret_rules, request_path);
        let mut app_rules: Vec<inject::InjectionRule> = Vec::new();
        match state
            .policy_engine
            .resolve_app_injection_for_request(
                &resolved.app_connections,
                &hostname,
                request_path,
                connection_id.as_deref(),
                oid,
                pid,
                &*state.cache,
            )
            .await
        {
            Ok(AppConnectionResult::Rules {
                rules,
                finalizer,
                body_transform,
                session_policy,
                connection_id: winning_connection_id,
                ..
            }) => {
                app_rules = rules;
                resolved_finalizer = finalizer;
                resolved_body_transform = body_transform;
                resolved_session_policy = session_policy;
                resolved_connection_id = winning_connection_id;
            }
            Ok(AppConnectionResult::Ambiguous { connections }) => {
                if !secrets_serve {
                    return Ok(response::multiple_connections_axum(&connections));
                }
                debug!(host = %authority, "app connections ambiguous; secret rules serve this path");
            }
            Ok(AppConnectionResult::MultipleProviders { connections }) => {
                if !secrets_serve {
                    return Ok(response::multiple_providers_axum(&connections));
                }
                debug!(host = %authority, "multiple providers match; secret rules serve this path");
            }
            Ok(AppConnectionResult::NotFound { connections }) => {
                if !secrets_serve {
                    let cid = connection_id.as_deref().unwrap_or("");
                    return Ok(response::connection_not_found_axum(cid, &connections));
                }
                debug!(host = %authority, "requested connection not found; secret rules serve this path");
            }
            Ok(AppConnectionResult::NoConnections) => {}
            Err(e) => {
                if !secrets_serve {
                    warn!(peer = %peer_addr, host = %authority, error = ?e, "HTTP proxy: app connection resolution failed");
                    return Ok(response::bad_gateway());
                }
                warn!(peer = %peer_addr, host = %authority, error = ?e, "HTTP proxy: app resolution failed; proceeding with secret rules");
            }
        }
        resolved.injection_rules = inject::merge_injection_rules(app_rules, secret_rules);
    }

    // Vault fallback
    if resolved.injection_rules.is_empty() {
        if let Some(ref aid) = resolved.project_id {
            if let Some(cred) = state.vault_service.request_credential(aid, &hostname).await {
                let vault_rules = inject::vault_credential_to_rules(&hostname, &cred);
                if !vault_rules.is_empty() {
                    resolved.injection_rules = vault_rules;
                    info!(host = %hostname, project_id = %aid, "http_proxy: using vault credential");
                }
            }
        }
    }

    let session_span = info_span!("session",
        peer = %peer_addr,
        host = %authority,
        project_id = resolved.project_id.as_deref().unwrap_or("-"),
        org_id = resolved.organization_id.as_deref().unwrap_or("-"),
        agent = resolved.agent_name.as_deref().unwrap_or("-"),
        agent_id = resolved.agent_id.as_deref().unwrap_or("-"),
    );

    info!(
        parent: &session_span,
        scheme = %scheme,
        injection_count = resolved.injection_rules.len(),
        "HTTP_PROXY"
    );

    let proxy_ctx = ProxyContext {
        project_id: resolved.project_id,
        organization_id: resolved.organization_id,
        agent_id: resolved.agent_id,
        agent_name: resolved.agent_name,
        agent_identifier: resolved.agent_identifier,
        agent_token,
    };

    let rules = mitm::ResolvedRules {
        injection_rules: resolved.injection_rules,
        policy_rules_v2: resolved.policy_rules_v2,
        available_apps: resolved.available_apps,
        access_restricted: resolved.access_restricted,
        intercept_token: None,
        plan: resolved.plan,
        rewrite_host: None,
        connection_label: None,
        finalizer: resolved_finalizer,
        body_transform: resolved_body_transform,
        claim_token: resolved.claim_token,
        session_policy: resolved_session_policy,
        winning_connection_id: resolved_connection_id,
        budget_bindings: resolved.budget_bindings,
    };

    let http_client =
        if scheme == "https" && host_matches_skip_verify(&hostname, &state.skip_verify_hosts) {
            state.http_client_no_verify.clone()
        } else {
            state.http_client.clone()
        };

    let mut resp = async {
        forward::forward_request(
            req,
            &authority, // forward target (the HTTP-proxy path never host-rewrites)
            &hostname,  // policy_host: host the rules were assembled from
            scheme,
            http_client,
            &rules,
            &*state.cache,
            &proxy_ctx,
            &state.approval_store,
            &state.policy_engine.pool,
        )
        .await
    }
    .instrument(session_span)
    .await?;

    connect::inject_connections_header(&mut resp, &resolved.app_connections);

    // Convert the response body type to match the axum::body::Body return type
    Ok(resp.map(axum::body::Body::new))
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Format a unix timestamp (seconds) as an ISO 8601 UTC string.
/// Falls back to epoch if the timestamp is invalid.
/// `pub(crate)` so the org route in `org_routes` can render timestamps identically.
pub(crate) fn format_unix_ts(secs: u64) -> String {
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

    /// `ClientConfig::builder()` panics when no process-default provider is
    /// installed, and both `ring` and `aws_lc_rs` are compiled in, so rustls
    /// cannot pick one on its own. `main` installs it at startup; tests must.
    fn ensure_crypto_provider() {
        static INIT_CRYPTO: std::sync::Once = std::sync::Once::new();
        INIT_CRYPTO.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
    }

    /// Named for what it actually checks. An earlier version looped over both
    /// modes asserting only this, which a `build_ws_tls_config` that ignored
    /// its argument would have passed — the claim in the name has to be one
    /// the assertions can fail on. Which config a host *gets* is a behavioral
    /// claim, pinned end to end by the gateway-e2e suite against a self-signed
    /// upstream; rustls exposes no way to read a config's verifier back out.
    #[test]
    fn ws_tls_config_sets_http11_alpn() {
        ensure_crypto_provider();

        // ALPN is what makes the upstream answer HTTP/1.1 rather than
        // negotiating h2, which cannot carry an upgrade.
        let config = build_ws_tls_config(false);
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    /// The dangerous branch takes a different builder chain, so it can fail to
    /// construct on its own — and it is the branch that almost never runs.
    #[test]
    fn ws_tls_config_builds_the_no_verify_branch() {
        ensure_crypto_provider();

        let config = build_ws_tls_config(true);
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    /// The scheme list is what the ClientHello advertises. An empty one makes
    /// the server abort before it ever sends a certificate, so "skip
    /// verification" would surface as an unexplained handshake failure.
    #[test]
    fn accept_any_server_cert_advertises_signature_schemes() {
        use rustls::client::danger::ServerCertVerifier;

        let schemes = AcceptAnyServerCert.supported_verify_schemes();
        assert!(schemes.contains(&rustls::SignatureScheme::RSA_PKCS1_SHA256));
    }

    #[tokio::test]
    async fn healthz_reports_status_and_version() {
        let axum::Json(body) = healthz().await;
        assert_eq!(body["status"], "ok");
        assert!(
            body["version"].as_str().is_some_and(|v| !v.is_empty()),
            "healthz must report a non-empty version string",
        );
    }

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
    fn http_proxy_detected_for_https_absolute_uri() {
        // axios v1.x with HTTPS_PROXY sends absolute-form https:// instead of CONNECT
        let req = Request::builder()
            .uri("https://api.example.com/data")
            .body(())
            .unwrap();
        assert!(is_http_proxy_request(&req));
    }

    #[test]
    fn http_proxy_not_detected_for_other_schemes() {
        // Non-http(s) schemes (ws://, ftp://, etc.) shouldn't be treated
        // as HTTP proxy requests.
        let req = Request::builder()
            .uri("ws://api.example.com/data")
            .body(())
            .unwrap();
        assert!(!is_http_proxy_request(&req));
    }
}
