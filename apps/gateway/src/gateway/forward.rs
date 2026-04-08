//! HTTP request forwarding: send requests upstream, apply injection/policy rules,
//! stream responses back, and intercept auth failures for unconnected apps.

use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use http_body_util::{Either, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::HeaderName;
use hyper::{Request, Response, StatusCode};
use tracing::{info, warn};

use crate::apps;
use crate::cache::CacheStore;
use crate::inject::{self, InjectionRule};
use crate::policy::{self, PolicyDecision, PolicyRule};

use super::response;

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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn forward_request(
    req: Request<Incoming>,
    host: &str,
    scheme: &str,
    http_client: reqwest::Client,
    injection_rules: &[InjectionRule],
    policy_rules: &[PolicyRule],
    cache: &dyn CacheStore,
    agent_token: &str,
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
