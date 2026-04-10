//! HTTP request forwarding: send requests upstream, apply injection/policy rules,
//! stream responses back, and intercept auth failures for unconnected apps.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

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
use crate::inject::{self, InjectionRule};
use crate::policy::{self, PolicyDecision, PolicyRule};

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

#[allow(clippy::too_many_arguments)]
pub(crate) async fn forward_request(
    req: Request<Incoming>,
    host: &str,
    scheme: &str,
    http_client: reqwest::Client,
    injection_rules: &[InjectionRule],
    policy_rules: &[PolicyRule],
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
    let method = req.method().clone();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("{scheme}://{host}{path}");
    let agent_token = proxy_ctx.agent_token.as_deref().unwrap_or("");

    // Check policy rules before forwarding
    let decision = policy::evaluate(method.as_str(), &path, policy_rules, agent_token, cache).await;

    // ── Early return for block / rate-limit (no body needed) ─────
    match &decision {
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
                .insert("content-type", "application/json".parse().unwrap());
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
                "message": "This request was rate-limited by an OneCLI policy rule.",
                "limit": limit,
                "window": window,
            })
            .to_string();
            let mut response = Response::new(Either::Left(Full::new(Bytes::from(body))));
            *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
            response
                .headers_mut()
                .insert("content-type", "application/json".parse().unwrap());
            response
                .headers_mut()
                .insert("retry-after", retry_after_secs.to_string().parse().unwrap());
            return Ok(response);
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

    // Apply injection rules matching this request path
    let injection_count = inject::apply_injections(&mut headers, &path, injection_rules);

    // ── ManualApproval: prepare body, store, wait for decision ─────
    let forward_body = if let PolicyDecision::ManualApproval { rule_id } = &decision {
        info!(method = %method, url = %url, rule_id = %rule_id, "MANUAL APPROVAL required");

        let account_id = match proxy_ctx.account_id.as_deref() {
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
            account_id: account_id.to_string(),
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
    let mut upstream = http_client.request(method.clone(), &url);
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

    // If no credentials were injected and upstream returned 401/403,
    // check if this host belongs to a known app that needs connecting.
    if injection_count == 0
        && (status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN)
    {
        let hostname = super::strip_port(host);
        if let Some((provider, display_name)) = apps::provider_for_host_and_path(hostname, &path) {
            info!(
                method = %method,
                url = %url,
                status = %status.as_u16(),
                provider = %provider,
                "app not connected"
            );
            return Ok(response::app_not_connected(status, provider, display_name));
        }
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
}
