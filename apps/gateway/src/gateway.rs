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
#[cfg(feature = "cloud")]
#[path = "cloud/response.rs"]
mod cloud_response;
mod finalizers;
pub(crate) mod forward;
mod hints;
#[cfg(not(feature = "cloud"))]
pub(crate) mod hooks;
#[cfg(feature = "cloud")]
#[path = "cloud/hooks.rs"]
pub(crate) mod hooks;
mod mitm;
mod response;
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
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tracing::{debug, info, info_span, warn, Instrument};

use crate::approval::{ApprovalDecision, ApprovalStore, PendingApproval, APPROVAL_TIMEOUT_SECS};
use crate::auth::AuthUser;
use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::connect::{self, AppConnectionResult, ConnectError, PolicyEngine};
use crate::db;
use crate::inject;
use crate::vault;

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
    pub policy_engine: Arc<PolicyEngine>,
    pub cache: Arc<dyn CacheStore>,
    /// Provider-agnostic vault service for credential fetching.
    pub vault_service: Arc<vault::VaultService>,
    /// Manual approval store for held requests.
    pub approval_store: Arc<dyn ApprovalStore>,
    /// Recent approval-pipeline events, surfaced by the dashboard test/debug view.
    pub approval_log: Arc<crate::notify::ApprovalEventLog>,
    /// Short-lived memory of resolved decisions for idempotent/conflict-aware callbacks.
    pub resolved_decisions: Arc<crate::notify::ResolvedDecisions>,
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
            approval_log: Arc::new(crate::notify::ApprovalEventLog::default()),
            resolved_decisions: Arc::new(crate::notify::ResolvedDecisions::from_env()),
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
            // ntfy push callback — token-guarded, no session/API-key auth.
            .route(
                "/v1/approvals/{id}/approve",
                axum::routing::post(approve_via_callback),
            )
            .route(
                "/v1/approvals/{id}/deny",
                axum::routing::post(deny_via_callback),
            )
            // Dashboard debug: trigger a test approval + read the recent log.
            .route(
                "/v1/approvals/test",
                axum::routing::post(trigger_test_approval),
            )
            .route("/v1/approvals/log", axum::routing::get(get_approval_log))
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
                    warn!(peer = %peer_addr, error = ?e, "connection error");
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

        // The SDK long-poll is gated by the "onecli" approval path (default-on
        // when no row exists). When explicitly disabled, serve nothing — but
        // still pause for the poll interval so the SDK doesn't busy-loop.
        if !db::approval_channel_enabled(&state.policy_engine.pool, &auth.project_id, "onecli", true)
            .await
        {
            info!("approval poll: onecli channel disabled — returning empty");
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            return axum::Json(serde_json::json!({
                "requests": [],
                "timeoutSeconds": APPROVAL_TIMEOUT_SECS,
            }));
        }

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
            let got_new = state
                .approval_store
                .wait_for_new(&org_id, &auth.project_id, std::time::Duration::from_secs(30))
                .await;
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
            .submit_decision(&org_id, &auth.project_id, &approval_id, body.decision)
            .await;

        if delivered {
            // Remember it so a later ntfy callback for the same approval is
            // idempotent / conflict-aware rather than a bare 404.
            state.resolved_decisions.record(&approval_id, body.decision);
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

// ── ntfy approval callback ──────────────────────────────────────────────
// The Approve/Deny buttons in an ntfy notification POST here. Unlike the SDK
// decision endpoint, these are NOT session/API-key authenticated — they're
// guarded by the per-project ntfy `callbackToken`, fired from the user's phone.

/// `POST /v1/approvals/{id}/approve` — resolve a held request (ntfy Approve).
async fn approve_via_callback(
    State(state): State<GatewayState>,
    axum::extract::Path(approval_id): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> impl axum::response::IntoResponse {
    handle_callback_decision(state, approval_id, headers, ApprovalDecision::Approve).await
}

/// `POST /v1/approvals/{id}/deny` — drop a held request (ntfy Deny).
async fn deny_via_callback(
    State(state): State<GatewayState>,
    axum::extract::Path(approval_id): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> impl axum::response::IntoResponse {
    handle_callback_decision(state, approval_id, headers, ApprovalDecision::Deny).await
}

/// Shared callback logic. Fails closed on a bad token (401). Once the approval
/// is gone it is conflict-aware via the resolved-decision memory: the SAME
/// decision again → 200 `already_resolved` (idempotent, since mobile clients
/// retry and users double-tap); the OPPOSITE decision → 410 `already_decided`
/// (the window closed — you can't flip an approve to a deny); unknown or past
/// the remember-window → 408 `approval_timed_out`. None of these post-resolution
/// paths change state. Window length: `APPROVAL_RESOLVED_TTL_SECS` (default 600).
async fn handle_callback_decision(
    state: GatewayState,
    approval_id: String,
    headers: axum::http::HeaderMap,
    decision: ApprovalDecision,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    let span = info_span!("approval_callback", approval_id = %approval_id);
    async move {
        // Look up the held request (in-memory store keys only on the id).
        // Already gone ⇒ consult the resolved-decision memory so a benign retry
        // (same decision) is idempotent, while a conflicting late tap (opposite
        // decision) reports 410 Gone instead of pretending to succeed.
        let Some(pending) = state.approval_store.get_pending("", "", &approval_id).await else {
            return post_resolution_response(&state, &approval_id, decision);
        };

        // The tap reached the gateway — surface it in the dashboard log so a
        // user can confirm the callback arrived (iOS gives no inline feedback).
        state.approval_log.record(
            &pending.project_id,
            format!("callback received: {} (id={approval_id})", decision_label(decision)),
        );

        // Load this project's ntfy path (kept for the confirmation note below)
        // and verify the bearer against its callback token.
        let ntfy_row =
            match db::find_approval_path(&state.policy_engine.pool, &pending.project_id, "ntfy")
                .await
            {
                Ok(Some(row)) if row.enabled => Some(row),
                _ => None,
            };
        let expected = match &ntfy_row {
            Some(row) => callback_token_of(&state, row).await,
            None => None,
        };
        let Some(expected) = expected else {
            warn!("approval callback: no ntfy callback token configured for project");
            state
                .approval_log
                .record(&pending.project_id, "callback REJECTED: no callback token configured");
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(serde_json::json!({ "error": "unauthorized" })),
            );
        };
        let provided = headers
            .get(hyper::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| {
                s.strip_prefix("Bearer ")
                    .or_else(|| s.strip_prefix("bearer "))
            });
        if !provided.map(|p| ct_eq(p, &expected)).unwrap_or(false) {
            // Distinguish "no header" (a redirect/proxy likely stripped it) from
            // a genuine token mismatch — the two need very different fixes.
            let reason = if provided.is_none() {
                "no Authorization header (a redirect/proxy may have stripped it — use the https callback URL directly)"
            } else {
                "token mismatch (re-enter the callback token and Save)"
            };
            warn!(reason, "approval callback: rejected");
            state
                .approval_log
                .record(&pending.project_id, format!("callback REJECTED: {reason}"));
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(serde_json::json!({ "error": "unauthorized" })),
            );
        }

        let delivered = state
            .approval_store
            .submit_decision(
                &pending.organization_id,
                &pending.project_id,
                &approval_id,
                decision,
            )
            .await;

        if delivered {
            info!(decision = ?decision, "approval callback delivered");
            state.resolved_decisions.record(&approval_id, decision);
            let verb = match decision {
                ApprovalDecision::Approve => "APPROVED",
                ApprovalDecision::Deny => "DENIED",
            };
            state.approval_log.record(
                &pending.project_id,
                format!("{verb} via ntfy callback (id={approval_id})"),
            );

            // Confirmation note ("Report Selection to Topic", default on): iOS
            // action buttons give no inline feedback, and a note also surfaces
            // when someone ELSE resolved it. Off only when explicitly disabled.
            let report_selection = ntfy_row.as_ref().is_some_and(|row| {
                match row.settings.as_ref().and_then(|s| s.get("reportSelection")) {
                    Some(serde_json::Value::Bool(b)) => *b,
                    Some(serde_json::Value::String(s)) => s != "false",
                    _ => true,
                }
            });
            if let Some(ntfy_row) = ntfy_row.filter(|_| report_selection) {
                let client = state.http_client.clone();
                let crypto = Arc::clone(&state.policy_engine.crypto);
                let tags = match decision {
                    ApprovalDecision::Approve => "white_check_mark",
                    ApprovalDecision::Deny => "no_entry",
                };
                let title = format!("OneCLI: {verb}");
                let body = format!(
                    "{verb}: {}\nRequested {}",
                    pending.agent_name,
                    format_unix_ts(pending.created_at),
                );
                tokio::spawn(async move {
                    crate::notify::publish_ntfy_status(
                        &client, &crypto, &ntfy_row, &title, &body, tags,
                    )
                    .await;
                });
            }

            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "success": true })),
            )
        } else {
            // Raced with another resolver between get_pending and submit (an
            // explicit decision, another channel, or a timeout). Resolve the
            // response the same way as the already-gone path — so if it was a
            // timeout (not recorded), both buttons get 408.
            debug!("approval callback: decision not delivered (resolved meanwhile)");
            post_resolution_response(&state, &approval_id, decision)
        }
    }
    .instrument(span)
    .await
}

/// Decrypt and return the ntfy `callbackToken` from an approval-path row.
async fn callback_token_of(state: &GatewayState, row: &db::ApprovalPathRow) -> Option<String> {
    let encrypted = row.credentials.as_deref()?;
    let decrypted = state
        .policy_engine
        .crypto
        .decrypt(encrypted)
        .await
        .map_err(|e| warn!(error = %e, "failed to decrypt ntfy credentials"))
        .ok()?;
    let creds: serde_json::Value = serde_json::from_str(&decrypted).ok()?;
    creds
        .get("callbackToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Human-readable label for a decision (used in callback JSON responses).
fn decision_label(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Approve => "approve",
        ApprovalDecision::Deny => "deny",
    }
}

/// Response for a callback whose approval is no longer pending. Consults the
/// resolved-decision memory:
/// - same decision again → 200 `already_resolved` (idempotent retry)
/// - opposite decision → 410 `already_decided` (can't flip a made decision)
/// - no record (timed out, or unknown/expired) → 408 `approval_timed_out`
///
/// A timeout auto-deny is deliberately NOT recorded as a decision, so once the
/// hold window passes a late tap of EITHER button lands here as 408 — not a
/// false "already denied".
fn post_resolution_response(
    state: &GatewayState,
    approval_id: &str,
    decision: ApprovalDecision,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    match state.resolved_decisions.get(approval_id) {
        Some(prev) if prev == decision => {
            debug!("approval callback: idempotent repeat of the same decision");
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({
                    "status": "already_resolved",
                    "decision": decision_label(prev),
                })),
            )
        }
        Some(prev) => {
            debug!(
                prior = decision_label(prev),
                attempted = decision_label(decision),
                "approval callback: conflicting decision after resolution"
            );
            (
                StatusCode::GONE,
                axum::Json(serde_json::json!({
                    "status": "already_decided",
                    "decision": decision_label(prev),
                    "attempted": decision_label(decision),
                })),
            )
        }
        None => {
            debug!("approval callback: timed out / unknown — too late");
            (
                StatusCode::REQUEST_TIMEOUT,
                axum::Json(serde_json::json!({
                    "status": "approval_timed_out",
                    "rememberWindowSeconds": state.resolved_decisions.ttl_secs(),
                })),
            )
        }
    }
}

/// Constant-time string comparison for token verification.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Approval test + debug log ───────────────────────────────────────────
// Lets a user verify the ntfy connection from the dashboard without sending a
// real agent request: synthesize a held approval, publish it, and surface the
// recent approval events so the publish + Approve/Deny round-trip is visible.

/// `POST /v1/approvals/test` — publish a synthetic approval over the project's
/// enabled ntfy channel. The real callback resolves it; it auto-expires if
/// untouched. Session/API-key authenticated (a dashboard action).
async fn trigger_test_approval(
    auth: AuthUser,
    State(state): State<GatewayState>,
) -> impl axum::response::IntoResponse {
    let span = info_span!("approval_test", project_id = %auth.project_id);
    async move {
        let project_id = auth.project_id.clone();

        let ntfy = match db::find_approval_path(&state.policy_engine.pool, &project_id, "ntfy").await
        {
            Ok(Some(row)) if row.enabled => row,
            _ => {
                state
                    .approval_log
                    .record(&project_id, "test approval skipped: ntfy channel not enabled");
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({ "error": "ntfy_not_enabled" })),
                );
            }
        };

        let org_id =
            db::find_organization_id_by_project(&state.policy_engine.pool, &project_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();

        let hold_secs = forward::approval_path_timeout(&ntfy).unwrap_or(APPROVAL_TIMEOUT_SECS);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let approval_id = uuid::Uuid::new_v4().to_string();

        // Describe the test against the real callback host (from the configured
        // callbackBaseUrl) rather than a fake "onecli.test", so the notification
        // shows a recognizable URL.
        let callback_base = ntfy
            .settings
            .as_ref()
            .and_then(|s| s.get("callbackBaseUrl"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let (test_scheme, test_host) = match callback_base.split_once("://") {
            Some((scheme, rest)) => (
                scheme.to_string(),
                rest.trim_end_matches('/').to_string(),
            ),
            None if !callback_base.is_empty() => {
                ("https".to_string(), callback_base.trim_end_matches('/').to_string())
            }
            None => ("https".to_string(), "onecli".to_string()),
        };

        let approval = PendingApproval {
            id: approval_id.clone(),
            organization_id: org_id.clone(),
            project_id: project_id.clone(),
            agent_id: "approval-path-test".to_string(),
            agent_name: "Approval Path Test".to_string(),
            agent_identifier: None,
            method: "POST".to_string(),
            scheme: test_scheme,
            host: test_host,
            path: "/v1/approvals/test".to_string(),
            headers: std::collections::HashMap::new(),
            body_preview: Some(
                "Test approval from OneCLI → Settings → Approval Paths. Approve or Deny to confirm the callback works.".to_string(),
            ),
            created_at: now,
            expires_at: now + hold_secs,
        };

        // prepare_wait before store (store() contract); no waiter here — the
        // callback's submit_decision resolves it, or cleanup expires it.
        let _ = state
            .approval_store
            .prepare_wait(&org_id, &project_id, &approval_id)
            .await;
        if let Err(e) = state.approval_store.store(&approval).await {
            warn!(error = ?e, "failed to store test approval");
            state
                .approval_log
                .record(&project_id, "test approval failed: store unavailable");
            return (
                StatusCode::BAD_GATEWAY,
                axum::Json(serde_json::json!({ "error": "store_unavailable" })),
            );
        }

        state
            .approval_log
            .record(&project_id, format!("test approval created (id={approval_id})"));
        crate::notify::publish_ntfy_approval(
            &state.http_client,
            &state.policy_engine.crypto,
            &state.approval_log,
            &ntfy,
            &approval,
        )
        .await;

        (
            StatusCode::OK,
            axum::Json(serde_json::json!({
                "approvalId": approval_id,
                "expiresInSeconds": hold_secs,
            })),
        )
    }
    .instrument(span)
    .await
}

/// Query params for the approval debug log.
#[derive(serde::Deserialize)]
struct ApprovalLogParams {
    #[serde(default)]
    limit: Option<usize>,
}

/// `GET /v1/approvals/log` — recent approval-pipeline events for this project.
async fn get_approval_log(
    auth: AuthUser,
    State(state): State<GatewayState>,
    axum::extract::Query(params): axum::extract::Query<ApprovalLogParams>,
) -> impl axum::response::IntoResponse {
    let limit = params.limit.unwrap_or(3).clamp(1, 50);
    let entries = state.approval_log.recent(&auth.project_id, limit);
    axum::Json(serde_json::json!({ "entries": entries }))
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
    let http_client = if skip_verify {
        info!(parent: &session_span, "TLS verification skipped (GATEWAY_SKIP_VERIFY_HOSTS)");
        state.http_client_no_verify.clone()
    } else {
        state.http_client.clone()
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

    tokio::spawn(
        async move {
            match hyper::upgrade::on(req).await {
                Ok(upgraded) => {
                    let result = if intercept {
                        mitm::mitm(
                            upgraded,
                            &host,
                            &ca,
                            http_client,
                            vault_injection_rules,
                            cache,
                            proxy_ctx,
                            approval_store,
                            Arc::clone(&state.policy_engine),
                            Arc::clone(&state.approval_log),
                        )
                        .await
                    } else {
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

    // Per-request app connection disambiguation
    let mut resolved_finalizer: Option<crate::apps::RequestFinalizer> = None;
    let mut resolved_body_transform: Option<crate::apps::BodyTransform> = None;
    // Granular-access policy of the connection that wins injection (if any).
    let mut resolved_session_policy: Option<serde_json::Value> = None;
    if resolved.injection_rules.is_empty() && !resolved.app_connections.is_empty() {
        let oid = resolved.organization_id.as_deref().unwrap_or("");
        let pid = resolved.project_id.as_deref().unwrap_or("");
        let request_path = req.uri().path_and_query().map(|pq| pq.as_str());
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
                ..
            }) => {
                resolved.injection_rules = rules;
                resolved_finalizer = finalizer;
                resolved_body_transform = body_transform;
                resolved_session_policy = session_policy;
            }
            Ok(AppConnectionResult::Ambiguous { connections }) => {
                return Ok(response::multiple_connections_axum(&connections));
            }
            Ok(AppConnectionResult::MultipleProviders { connections }) => {
                return Ok(response::multiple_providers_axum(&connections));
            }
            Ok(AppConnectionResult::NotFound { connections }) => {
                let cid = connection_id.as_deref().unwrap_or("");
                return Ok(response::connection_not_found_axum(cid, &connections));
            }
            Ok(AppConnectionResult::NoConnections) => {}
            Err(e) => {
                warn!(peer = %peer_addr, host = %authority, error = ?e, "HTTP proxy: app connection resolution failed");
                return Ok(response::bad_gateway());
            }
        }
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
        policy_count = resolved.policy_rules.len(),
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
        policy_rules: resolved.policy_rules,
        access_restricted: resolved.access_restricted,
        intercept_token: None,
        plan: resolved.plan,
        rewrite_host: None,
        connection_label: None,
        finalizer: resolved_finalizer,
        body_transform: resolved_body_transform,
        policy_mode: resolved.policy_mode,
        claim_token: resolved.claim_token,
        session_policy: resolved_session_policy,
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
            &authority,
            scheme,
            http_client,
            &rules,
            &*state.cache,
            &proxy_ctx,
            &state.approval_store,
            &state.policy_engine.pool,
            &state.policy_engine.crypto,
            &state.approval_log,
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
