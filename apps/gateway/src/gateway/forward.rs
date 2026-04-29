//! HTTP request forwarding: send requests upstream, apply injection/policy rules,
//! stream responses back, and intercept auth failures for unconnected apps.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures_util::{StreamExt, TryStreamExt};
use http_body_util::{Either, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::HeaderName;
use hyper::{Request, Response, StatusCode};
use tracing::{info, warn};

use crate::approval::{
    ApprovalDecision, ApprovalGuard, ApprovalStore, PendingApproval, APPROVAL_TIMEOUT_SECS,
};
use crate::apps;
use crate::cache::CacheStore;
use crate::inject;
use crate::policy::{self, PolicyDecision};

use super::mitm::ResolvedRules;
use super::response;
use super::ProxyContext;

// ── Header filtering ────────────────────────────────────────────────────

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
    if s == "host" || s == "content-length" || s == crate::connect::CONNECTION_ID_HEADER {
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

// ── Request forwarding ──────────────────────────────────────────────────

/// Forward a single HTTP request to the real upstream server and stream the response back.
///
/// Both request and response bodies are streamed — no full buffering in memory.
/// This is critical for SSE (Server-Sent Events) and large payloads.
///
/// The flow:
/// 1. Check policy rules (block/rate-limit → 403/429)
/// 2. Apply injection rules to request headers
/// 3. Send to upstream
/// 4. If no credentials were injected and upstream returns 401/403, check if the
///    host belongs to a known app → return an actionable error for the agent
/// 5. Stream response back to client
///
/// For `ManualApproval`, the gateway peeks the first 4KB of the body for a
/// preview (shown to the approver), then chains it back with the remaining
/// stream for forwarding. No full-body buffering — the body stays in the
/// TCP pipe during the approval wait.
const BODY_PREVIEW_BYTES: usize = 4096;

/// Maximum response body to buffer when checking if a 400 is auth-related.
/// Auth error messages are small JSON; no need to scan large bodies.
const AUTH_CHECK_BODY_LIMIT: usize = 8192;

#[allow(clippy::too_many_arguments)]
pub(crate) async fn forward_request(
    req: Request<Incoming>,
    host: &str,
    scheme: &str,
    http_client: reqwest::Client,
    rules: &ResolvedRules,
    cache: &dyn CacheStore,
    proxy_ctx: &ProxyContext,
    approval_store: &Arc<dyn ApprovalStore>,
) -> Result<
    Response<
        Either<
            Full<Bytes>,
            StreamBody<impl futures_util::Stream<Item = Result<Frame<Bytes>, reqwest::Error>>>,
        >,
    >,
> {
    let start = std::time::Instant::now();
    let method = req.method().clone();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("{scheme}://{host}{path}");
    let agent_token = proxy_ctx.agent_token.as_deref().unwrap_or("");

    // Token endpoint interception: when a client SDK tries to refresh its
    // own Google OAuth token through the proxy, serve the cached access
    // token from the stored app connection instead of forwarding dummy
    // credentials to Google.
    if super::strip_port(host) == "oauth2.googleapis.com"
        && path.starts_with("/token")
        && method == hyper::Method::POST
        && !rules.injection_rules.is_empty()
    {
        // Extract the Bearer token from the injection rules — it's the
        // already-refreshed access token from the app connection.
        let token = rules.injection_rules.iter().find_map(|rule| {
            rule.injections.iter().find_map(|inj| match inj {
                crate::inject::Injection::SetHeader { name, value } if name == "authorization" => {
                    value.strip_prefix("Bearer ")
                }
                _ => None,
            })
        });

        if let Some(access_token) = token {
            info!(
                method = %method,
                url = %url,
                "token endpoint intercepted — serving cached token"
            );
            let expires_in = rules
                .token_expires_at
                .map(|exp| {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .expect("system clock before UNIX epoch")
                        .as_secs() as i64;
                    (exp - now).max(0)
                })
                .unwrap_or(3600);
            let body = serde_json::json!({
                "access_token": access_token,
                "expires_in": expires_in,
                "token_type": "Bearer",
            });
            let bytes = Bytes::from(serde_json::to_vec(&body).expect("serializing JSON literal"));
            let mut resp = Response::new(Either::Left(Full::new(bytes)));
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                "content-type",
                hyper::header::HeaderValue::from_static("application/json"),
            );
            return Ok(resp);
        }
    }

    // Check policy rules before forwarding
    let decision = policy::evaluate(
        method.as_str(),
        &path,
        &rules.policy_rules,
        agent_token,
        cache,
    )
    .await;

    // ── Early return for block / rate-limit (no body needed) ─────
    match &decision {
        PolicyDecision::Blocked => {
            warn!(method = %method, url = %url, "BLOCKED by policy rule");
            return Ok(response::blocked_by_policy(method.as_str(), &path));
        }
        PolicyDecision::RateLimited {
            limit,
            window,
            retry_after_secs,
        } => {
            warn!(method = %method, url = %url, limit, window, "RATE LIMITED by policy rule");
            return Ok(response::rate_limited(*limit, window, *retry_after_secs));
        }
        _ => {}
    }

    // ── Consume request (both ManualApproval and Allow) ────────────
    let (parts, body) = req.into_parts();

    let mut headers = hyper::HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if is_forwarded_request_header(name) {
            headers.append(name.clone(), value.clone());
        }
    }

    // Sanitize headers for approval metadata (BEFORE injection, so the
    // approver never sees real credentials). Only built for ManualApproval.
    let sanitized_headers = if matches!(&decision, PolicyDecision::ManualApproval { .. }) {
        Some(
            headers
                .iter()
                .filter(|(name, _)| {
                    name.as_str() != "authorization" && name.as_str() != "x-api-key"
                })
                .map(|(n, v)| (n.to_string(), v.to_str().unwrap_or_default().to_string()))
                .collect::<HashMap<String, String>>(),
        )
    } else {
        None
    };

    // Apply injection rules — upstream_path may gain query-param secrets;
    // the original `path`/`url` stays clean for logging and approval metadata.
    let mut upstream_path = path.clone();
    let injection_count =
        inject::apply_injections(&mut headers, &mut upstream_path, &rules.injection_rules);
    let upstream_url = format!("{scheme}://{host}{upstream_path}");
    // ── ManualApproval: prepare body, store, wait for decision ─────
    let forward_body = if let PolicyDecision::ManualApproval { rule_id } = &decision {
        info!(method = %method, url = %url, rule_id = %rule_id, "MANUAL APPROVAL required");

        let project_id = match proxy_ctx.project_id.as_deref() {
            Some(id) => id,
            None => {
                warn!(url = %url, "manual approval requires authenticated agent");
                return Ok(response::approval_store_unavailable());
            }
        };
        let agent_id = proxy_ctx.agent_id.as_deref().unwrap_or("unknown");
        let agent_name = proxy_ctx.agent_name.as_deref().unwrap_or("Unknown Agent");

        // Peek the first 4KB of the body for a preview (shown to the approver),
        // then chain the peeked bytes back with the remaining stream for forwarding.
        // Only the preview (~4KB) lives in gateway RAM — the rest stays in the TCP pipe.
        let mut body_stream = Box::pin(http_body_util::BodyDataStream::new(body));
        let mut peeked: Vec<Bytes> = Vec::new();
        let mut peeked_len: usize = 0;

        while peeked_len < BODY_PREVIEW_BYTES {
            match body_stream.next().await {
                Some(Ok(data)) => {
                    peeked_len += data.len();
                    peeked.push(data);
                }
                Some(Err(e)) => {
                    return Err(anyhow::anyhow!("reading request body for preview: {e}"));
                }
                None => break,
            }
        }

        let body_preview = if peeked.is_empty() {
            None
        } else {
            let mut buf = Vec::with_capacity(peeked_len.min(BODY_PREVIEW_BYTES));
            for chunk in &peeked {
                let take = (BODY_PREVIEW_BYTES - buf.len()).min(chunk.len());
                buf.extend_from_slice(&chunk[..take]);
                if buf.len() >= BODY_PREVIEW_BYTES {
                    break;
                }
            }
            Some(String::from_utf8_lossy(&buf).into_owned())
        };

        // Chain peeked bytes + remaining body into a single stream for forwarding.
        let peeked_stream =
            futures_util::stream::iter(peeked.into_iter().map(Ok::<_, std::io::Error>));
        let remaining_stream =
            body_stream.map(|r| r.map_err(|e| std::io::Error::other(e.to_string())));
        let fwd_body = reqwest::Body::wrap_stream(peeked_stream.chain(remaining_stream));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let approval_id = uuid::Uuid::new_v4().to_string();

        let approval = PendingApproval {
            id: approval_id.clone(),
            project_id: project_id.to_string(),
            agent_id: agent_id.to_string(),
            agent_name: agent_name.to_string(),
            agent_identifier: proxy_ctx.agent_identifier.clone(),
            method: method.to_string(),
            scheme: scheme.to_string(),
            host: host.to_string(),
            path: path.clone(),
            headers: sanitized_headers.unwrap_or_default(),
            body_preview,
            created_at: now,
            expires_at: now + APPROVAL_TIMEOUT_SECS,
        };

        let decision_rx = approval_store.prepare_wait(&approval_id).await;

        // Guard cleans up the approval if the agent disconnects (future cancelled).
        // Created BEFORE store() so there's no window where cancellation misses cleanup.
        let mut guard = ApprovalGuard::new(approval_id.clone(), Arc::clone(approval_store));

        if let Err(e) = approval_store.store(&approval).await {
            warn!(url = %url, error = %e, "failed to store pending approval");
            guard.defuse(); // we'll clean up explicitly
            approval_store.remove(&approval_id).await;
            return Ok(response::approval_store_unavailable());
        }

        info!(
            url = %url,
            approval_id = %approval_id,
            agent = %agent_name,
            injections = injection_count,
            "holding request for approval"
        );

        let approval_decision = decision_rx
            .wait(Duration::from_secs(APPROVAL_TIMEOUT_SECS))
            .await;

        // Decision received (or timed out) — defuse guard, handle explicitly.
        guard.defuse();

        match approval_decision {
            Some(ApprovalDecision::Approve) => {
                info!(url = %url, approval_id = %approval_id, "APPROVED — forwarding request");
                approval_store.remove(&approval_id).await;
                fwd_body
            }
            other => {
                let reason = match other {
                    Some(ApprovalDecision::Deny) => "denied",
                    _ => "timed out",
                };
                warn!(url = %url, approval_id = %approval_id, reason, "MANUAL APPROVAL rejected");
                approval_store.remove(&approval_id).await;
                return Ok(response::manual_approval_denied(&approval_id, reason));
            }
        }
    } else {
        reqwest::Body::wrap(body)
    };

    // ── Shared: forward to upstream and stream response back ──────
    let mut upstream = http_client.request(method.clone(), &upstream_url);
    for (name, value) in headers.iter() {
        upstream = upstream.header(name.clone(), value.clone());
    }
    upstream = upstream.body(forward_body);

    let upstream_resp = upstream
        .send()
        .await
        .with_context(|| format!("forwarding to {url}"))?;

    let status = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    // Track credential-injected requests (Postgres + PostHog + Redis)
    if injection_count > 0 {
        if let (Some(aid), Some(gid)) = (
            proxy_ctx.project_id.as_deref(),
            proxy_ctx.agent_id.as_deref(),
        ) {
            let hostname = super::strip_port(host);
            let (provider, _) = crate::apps::provider_for_host_and_path(hostname, &path)
                .unwrap_or((hostname, hostname));

            let ts = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Iso8601::DEFAULT)
                .unwrap_or_default();

            // Strip query params to avoid logging sensitive data (API keys, tokens)
            let telemetry_path = match path.find('?') {
                Some(i) => &path[..i],
                None => &path,
            };

            crate::telemetry::on_request(crate::telemetry::RequestEvent {
                project_id: aid.to_string(),
                agent_id: gid.to_string(),
                agent_name: proxy_ctx
                    .agent_name
                    .as_deref()
                    .unwrap_or("unknown")
                    .to_string(),
                method: method.to_string(),
                host: host.to_string(),
                path: telemetry_path.to_string(),
                provider: provider.to_string(),
                status: status.as_u16(),
                latency_ms: start.elapsed().as_millis() as u32,
                injection_count: injection_count as u16,
                timestamp: ts,
            });
        }
    }

    // If no credentials were injected and upstream returned 401/403,
    // guide the agent to connect/configure credentials in OneCLI.
    if injection_count == 0
        && (status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN)
        && proxy_ctx.agent_token.is_some()
    {
        let hostname = super::strip_port(host);

        // 1. Access restricted — agent in selective mode, credentials exist but not assigned.
        //    Applies to ANY host (known apps AND manual secrets).
        if rules.access_restricted {
            let (provider, display_name) =
                apps::provider_for_host_and_path(hostname, &path).unwrap_or((hostname, hostname));
            info!(method = %method, url = %url, status = %status.as_u16(), "access restricted");
            return Ok(response::access_restricted(
                status,
                provider,
                display_name,
                proxy_ctx.agent_id.as_deref(),
            ));
        }

        // 2. Known app host — not connected.
        if let Some((provider, display_name)) = apps::provider_for_host_and_path(hostname, &path) {
            info!(method = %method, url = %url, status = %status.as_u16(), provider = %provider, "app not connected");
            return Ok(response::app_not_connected(
                status,
                provider,
                display_name,
                proxy_ctx.agent_name.as_deref(),
            ));
        }

        // 3. Unknown host — no credentials at all, guide user to create a secret.
        info!(method = %method, url = %url, status = %status.as_u16(), "credential not found");
        return Ok(response::credential_not_found(status, hostname, &path));
    }

    // Some APIs (e.g. Google) return 400 instead of 401 for invalid/missing API keys.
    // Buffer the body and check for auth-related keywords before deciding.
    if injection_count == 0 && status == StatusCode::BAD_REQUEST && proxy_ctx.agent_token.is_some()
    {
        let body_bytes = upstream_resp
            .bytes()
            .await
            .context("reading 400 response body for auth check")?;

        let check_slice = &body_bytes[..body_bytes.len().min(AUTH_CHECK_BODY_LIMIT)];

        if body_indicates_auth_error(check_slice) {
            let hostname = super::strip_port(host);

            // Mirror the 401/403 logic: access_restricted → app_not_connected → credential_not_found
            if rules.access_restricted {
                let (provider, display_name) = apps::provider_for_host_and_path(hostname, &path)
                    .unwrap_or((hostname, hostname));
                info!(method = %method, url = %url, status = 400, "auth-related 400 — access restricted");
                return Ok(response::access_restricted(
                    StatusCode::BAD_REQUEST,
                    provider,
                    display_name,
                    proxy_ctx.agent_id.as_deref(),
                ));
            }
            if let Some((provider, display_name)) =
                apps::provider_for_host_and_path(hostname, &path)
            {
                info!(method = %method, url = %url, status = 400, provider = %provider, "auth-related 400 — app not connected");
                return Ok(response::app_not_connected(
                    StatusCode::BAD_REQUEST,
                    provider,
                    display_name,
                    proxy_ctx.agent_name.as_deref(),
                ));
            }
            info!(method = %method, url = %url, status = 400, "auth-related 400 — credential not found");
            return Ok(response::credential_not_found(
                StatusCode::BAD_REQUEST,
                hostname,
                &path,
            ));
        }

        // Not auth-related: forward the buffered 400 as-is.
        let mut response = Response::new(Either::Left(Full::new(body_bytes)));
        *response.status_mut() = status;
        for (name, value) in resp_headers.iter() {
            if is_forwarded_response_header(name) {
                response.headers_mut().append(name.clone(), value.clone());
            }
        }
        return Ok(response);
    }

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

    for (name, value) in resp_headers.iter() {
        if is_forwarded_response_header(name) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }

    Ok(response)
}

/// Check if a response body contains auth-related error keywords,
/// indicating a 400 is actually an authentication failure.
fn body_indicates_auth_error(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body);
    let lower = text.to_ascii_lowercase();
    const AUTH_KEYWORDS: &[&str] = &[
        "api key",
        "api_key",
        "apikey",
        "unauthorized",
        "unauthenticated",
        "authentication",
        "credentials",
        "access denied",
        "permission denied",
        "invalid token",
        "token expired",
        "not authenticated",
    ];
    AUTH_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
    fn request_header_strips_connection_id() {
        assert!(!is_forwarded_request_header(&HeaderName::from_static(
            crate::connect::CONNECTION_ID_HEADER
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

    // ── body_indicates_auth_error ───────────────────────────────────────

    #[test]
    fn auth_error_detects_api_key() {
        let body = br#"{"error": {"message": "API key not valid"}}"#;
        assert!(body_indicates_auth_error(body));
    }

    #[test]
    fn auth_error_detects_unauthenticated() {
        let body = br#"{"error": "Request is missing required authentication credential."}"#;
        assert!(body_indicates_auth_error(body));
    }

    #[test]
    fn auth_error_case_insensitive() {
        let body = br#"{"error": "UNAUTHORIZED access"}"#;
        assert!(body_indicates_auth_error(body));
    }

    #[test]
    fn auth_error_rejects_unrelated_400() {
        let body = br#"{"error": "invalid_argument", "message": "Field 'email' is required"}"#;
        assert!(!body_indicates_auth_error(body));
    }

    #[test]
    fn auth_error_handles_empty_body() {
        assert!(!body_indicates_auth_error(b""));
    }

    #[test]
    fn auth_error_handles_non_utf8() {
        // Invalid UTF-8 prefix + "api key"
        let body = &[0xFF, 0xFE, 0x61, 0x70, 0x69, 0x20, 0x6B, 0x65, 0x79];
        assert!(body_indicates_auth_error(body));
    }
}
