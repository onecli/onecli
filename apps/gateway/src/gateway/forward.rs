//! HTTP request forwarding: send requests upstream, apply injection/policy rules,
//! stream responses back, and intercept auth failures for unconnected apps.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{StreamExt, TryStreamExt};
use http_body_util::{BodyExt, Either, Full};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::HeaderName;
use hyper::{Request, Response, StatusCode};
use tracing::{info, warn};

use crate::approval::{
    ApprovalDecision, ApprovalGuard, ApprovalStore, PendingApproval, APPROVAL_TIMEOUT_SECS,
};
use crate::apps;
use crate::cache::CacheStore;
use crate::default_interceptions;
use crate::inject;
use crate::policy::{self, PolicyDecision};

use super::hooks;
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

/// Returns true if the request declares a `Content-Length` no larger than `max`.
/// Absent or oversized `Content-Length` ⇒ false, so the request is left to
/// forward normally rather than buffered for a default-interception check.
fn content_length_at_most(headers: &hyper::HeaderMap, max: usize) -> bool {
    headers
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .is_some_and(|n| n <= max)
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
/// For `ManualApproval`, the gateway peeks a bounded prefix of the body to build
/// a human-readable approval summary and a redacted preview, then chains it back
/// with the remaining stream for forwarding. No full-body buffering — the body
/// stays in the TCP pipe during the approval wait. 16 KB is enough to decode the
/// RFC822 headers / first MIME part for the summary while staying tiny next to a
/// multi-megabyte attachment.
const APPROVAL_BODY_PEEK: usize = 16 * 1024;

/// Maximum response body to buffer when checking if a 400 is auth-related.
/// Auth error messages are small JSON; no need to scan large bodies.
const AUTH_CHECK_BODY_LIMIT: usize = 8192;

/// Maximum request body we'll buffer to evaluate a default interception.
/// OAuth refresh bodies are tiny; this only guards against pathological inputs.
const MAX_DEFAULT_INTERCEPT_BODY: usize = 64 * 1024;

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
    pool: &sqlx::PgPool,
) -> Result<Response<hooks::ForwardResponseBody>> {
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
    // own OAuth token through the proxy, serve the cached access token from
    // the stored app connection instead of forwarding dummy credentials.
    // Interception targets are defined per-provider in the app registry.
    if let Some(ref intercept) = rules.intercept_token {
        if crate::apps::is_intercept_target(super::strip_port(host), &path)
            && method == hyper::Method::POST
        {
            info!(
                method = %method,
                url = %url,
                "token endpoint intercepted — serving cached token"
            );
            let body = serde_json::json!({
                "access_token": intercept.access_token,
                "expires_in": intercept.expires_in,
                "token_type": "Bearer",
            });
            return Ok(response::json(StatusCode::OK, body));
        }
    }

    // Default interceptions: gateway-authored responses for predefined endpoints
    // (e.g. Codex's onecli-managed OAuth refresh), independent of any connected
    // secret or app. Cheap host/path/method pre-match for every request; only a
    // matched, small request gets its body buffered and inspected below.
    let default_target =
        default_interceptions::match_target(super::strip_port(host), &path, &method)
            .filter(|_| content_length_at_most(req.headers(), MAX_DEFAULT_INTERCEPT_BODY));

    // Buffer the request body for condition matching, when the request guard needs
    // to inspect it (e.g. Dropbox folder scoping reads the JSON body), or for a
    // matched default interception. In OSS, both predicates return false → zero
    // overhead unless a default interception matched.
    let (condition_buffer, req) = if crate::condition_match::needs_body_buffer(&rules.policy_rules)
        || hooks::needs_request_body(rules, host, method.as_str(), &path)
    {
        let (parts, incoming) = req.into_parts();
        let (buf, fwd_body) =
            crate::condition_match::prepare_body(incoming, method.as_str(), &url).await?;
        (buf, hyper::Request::from_parts(parts, fwd_body))
    } else if default_target.is_some() {
        // OSS-safe: fully buffer the known-small body, keeping the bytes for both
        // the interception check and (if it declines) forwarding.
        let (parts, incoming) = req.into_parts();
        let bytes = incoming
            .collect()
            .await
            .context("buffering request body for default interception")?
            .to_bytes();
        let req = hyper::Request::from_parts(parts, reqwest::Body::from(bytes.clone()));
        (Some(bytes.to_vec()), req)
    } else {
        (None, req.map(reqwest::Body::wrap))
    };

    // Answer a matched default interception before any forwarding. A handler that
    // declines (e.g. a real refresh token) falls through to normal forwarding.
    if let Some(target) = default_target {
        if let Some(synth) = target.handle(condition_buffer.as_deref().unwrap_or(&[])) {
            info!(method = %method, url = %url, "default interception — serving synthetic response");
            return Ok(response::json(synth.status, synth.body));
        }
    }

    let has_injections = !rules.injection_rules.is_empty();
    let enforce_deny = has_injections && !policy::is_llm_host(host);

    let org_id = proxy_ctx.organization_id.as_deref().unwrap_or("");
    let pid = proxy_ctx.project_id.as_deref().unwrap_or("");

    let decision = policy::evaluate(
        org_id,
        pid,
        method.as_str(),
        &path,
        condition_buffer.as_deref(),
        &rules.policy_rules,
        agent_token,
        cache,
        &rules.policy_mode,
        enforce_deny,
    )
    .await;

    // ── Early return for block / rate-limit / default-deny (no body needed) ───
    match &decision {
        PolicyDecision::BlockedByDefaultPolicy => {
            warn!(method = %method, url = %url, "BLOCKED by default deny policy");
            emit_policy_telemetry(
                proxy_ctx,
                host,
                &method,
                &path,
                start,
                StatusCode::FORBIDDEN,
                crate::telemetry_core::RequestDecision::BlockedByDefaultPolicy,
            );
            return Ok(response::blocked_by_default_policy(
                method.as_str(),
                &path,
                host,
                proxy_ctx.project_id.as_deref(),
            ));
        }
        PolicyDecision::Blocked { rule_name } => {
            warn!(method = %method, url = %url, rule = %rule_name, "BLOCKED by policy rule");
            emit_policy_telemetry(
                proxy_ctx,
                host,
                &method,
                &path,
                start,
                StatusCode::FORBIDDEN,
                crate::telemetry_core::RequestDecision::Blocked {
                    rule_name: rule_name.clone(),
                },
            );
            return Ok(response::blocked_by_policy(
                method.as_str(),
                &path,
                rule_name,
                proxy_ctx.project_id.as_deref(),
            ));
        }
        PolicyDecision::RateLimited {
            rule_name,
            limit,
            window,
            retry_after_secs,
        } => {
            warn!(method = %method, url = %url, rule = %rule_name, limit, window, "RATE LIMITED by policy rule");
            emit_policy_telemetry(
                proxy_ctx,
                host,
                &method,
                &path,
                start,
                StatusCode::TOO_MANY_REQUESTS,
                crate::telemetry_core::RequestDecision::RateLimited {
                    rule_name: rule_name.clone(),
                },
            );
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

    hooks::prepare_request(rules, host, &path, &mut headers);

    // Apply injection rules — upstream_path may gain query-param secrets;
    // the original `path`/`url` stays clean for logging and approval metadata.
    let mut upstream_path = path.clone();
    let injection_count =
        inject::apply_injections(&mut headers, &mut upstream_path, &rules.injection_rules);
    let upstream_url = format!("{scheme}://{host}{upstream_path}");

    if let Some(resp) = hooks::pre_forward(
        rules,
        proxy_ctx,
        host,
        cache,
        pool,
        injection_count,
        method.as_str(),
        &path,
        &headers,
        condition_buffer.as_deref(),
    )
    .await
    {
        return Ok(resp);
    }

    // ── ManualApproval: prepare body, store, wait for decision ─────
    // Approval log_id + metadata are stored as locals so they can be
    // threaded to the telemetry section for the approved UPDATE.

    // The deciding user (for the approved-path telemetry below) is captured
    // here because the approve arm returns the body tuple, not the identity.
    let mut approval_approved_by: Option<String> = None;
    let (forward_body, approval_log_id, approval_id_for_telemetry, approval_triggered_at) =
        if let PolicyDecision::ManualApproval { rule_id } = &decision {
            info!(method = %method, url = %url, rule_id = %rule_id, "MANUAL APPROVAL required");

            let project_id = match proxy_ctx.project_id.as_deref() {
                Some(id) => id,
                None => {
                    warn!(url = %url, "manual approval requires authenticated agent");
                    return Ok(response::approval_store_unavailable());
                }
            };
            let org_id = proxy_ctx.organization_id.as_deref().unwrap_or("");
            let agent_id = proxy_ctx.agent_id.as_deref().unwrap_or("unknown");
            let agent_name = proxy_ctx.agent_name.as_deref().unwrap_or("Unknown Agent");

            // Peek a bounded prefix of the body for the summary + preview, then
            // build the forwarding body. If condition buffering already captured
            // the body, reuse that buffer instead of peeking the stream again.
            let (summary_bytes, fwd_body): (Cow<'_, [u8]>, reqwest::Body) = if let Some(ref buf) =
                condition_buffer
            {
                // Body already buffered for condition matching — borrow its prefix
                // for the summary instead of copying it again.
                let take = buf.len().min(APPROVAL_BODY_PEEK);
                (Cow::Borrowed(&buf[..take]), body)
            } else {
                let mut body_stream = Box::pin(http_body_util::BodyDataStream::new(body));
                let mut peeked: Vec<Bytes> = Vec::new();
                let mut peeked_len: usize = 0;

                while peeked_len < APPROVAL_BODY_PEEK {
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

                let mut buf = Vec::with_capacity(peeked_len.min(APPROVAL_BODY_PEEK));
                for chunk in &peeked {
                    let take = (APPROVAL_BODY_PEEK - buf.len()).min(chunk.len());
                    buf.extend_from_slice(&chunk[..take]);
                    if buf.len() >= APPROVAL_BODY_PEEK {
                        break;
                    }
                }

                let peeked_stream =
                    futures_util::stream::iter(peeked.into_iter().map(Ok::<_, std::io::Error>));
                let remaining_stream =
                    body_stream.map(|r| r.map_err(|e| std::io::Error::other(e.to_string())));
                let reassembled = reqwest::Body::wrap_stream(peeked_stream.chain(remaining_stream));

                (Cow::Owned(buf), reassembled)
            };

            // Resolve provider + content-type for the summarizer. Both degrade
            // gracefully: unknown provider → generic summary, no content-type →
            // best-effort sniffing. The summary/preview never embed raw base64 or
            // oversized JSON, so the approval card can't overflow a chat client.
            let (summary_provider, _) =
                crate::apps::provider_for_host_and_path(super::strip_port(host), &path)
                    .unwrap_or((host, host));
            let content_type = parts
                .headers
                .get(hyper::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok());
            let summary_body = (!summary_bytes.is_empty()).then_some(&*summary_bytes);
            let approval_summary = crate::summary::summarize_request(
                summary_provider,
                method.as_str(),
                &path,
                content_type,
                summary_body,
            );
            // `body_preview` carries the rendered summary so consumers that only
            // read the legacy field still get a clean, bounded, human-readable
            // card instead of raw JSON/base64. The structured `summary` is sent
            // alongside for richer rendering.
            let body_preview = Some(approval_summary.render_text());

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let approval_id = uuid::Uuid::new_v4().to_string();

            let approval = PendingApproval {
                id: approval_id.clone(),
                organization_id: org_id.to_string(),
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
                summary: Some(approval_summary),
                created_at: now,
                expires_at: now + APPROVAL_TIMEOUT_SECS,
            };

            let decision_rx = approval_store
                .prepare_wait(org_id, project_id, &approval_id)
                .await;

            // Guard cleans up the approval if the agent disconnects (future cancelled).
            // Created BEFORE store() so there's no window where cancellation misses cleanup.
            let mut guard = ApprovalGuard::new(
                approval_id.clone(),
                org_id.to_string(),
                project_id.to_string(),
                Arc::clone(approval_store),
            );

            if let Err(e) = approval_store.store(&approval).await {
                warn!(url = %url, error = ?e, "failed to store pending approval");
                guard.defuse();
                approval_store
                    .remove(org_id, project_id, &approval_id)
                    .await;
                return Ok(response::approval_store_unavailable());
            }

            let telemetry_path = path.split('?').next().unwrap_or(&path);
            let triggered_at = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Iso8601::DEFAULT)
                .unwrap_or_default();

            let log_id = uuid::Uuid::new_v4().to_string();
            guard.set_log_context(log_id.clone(), pool.clone());
            emit_approval_telemetry(
                proxy_ctx,
                host,
                &method,
                telemetry_path,
                202,
                0,
                crate::telemetry_core::RequestDecision::ApprovalPending {
                    approval_id: approval_id.clone(),
                    triggered_at: triggered_at.clone(),
                },
                Some(log_id.clone()),
                None,
            );

            info!(
                url = %url,
                approval_id = %approval_id,
                agent = %agent_name,
                injections = injection_count,
                "holding request for approval"
            );

            let outcome = decision_rx
                .wait(Duration::from_secs(APPROVAL_TIMEOUT_SECS))
                .await;

            // Decision received (or timed out) — defuse guard, handle explicitly.
            guard.defuse();

            let decision = outcome.as_ref().map(|o| o.decision);
            let approved_by = outcome.and_then(|o| o.approved_by);

            match decision {
                Some(ApprovalDecision::Approve) => {
                    info!(url = %url, approval_id = %approval_id, "APPROVED — forwarding request");
                    approval_store
                        .remove(org_id, project_id, &approval_id)
                        .await;
                    approval_approved_by = approved_by;
                    (
                        fwd_body,
                        Some(log_id),
                        Some(approval_id),
                        Some(triggered_at),
                    )
                }
                other => {
                    let reason = match other {
                        Some(ApprovalDecision::Deny) => "denied",
                        _ => "timed out",
                    };
                    warn!(url = %url, approval_id = %approval_id, reason, "MANUAL APPROVAL rejected");
                    approval_store
                        .remove(org_id, project_id, &approval_id)
                        .await;
                    let resolved_at = time::OffsetDateTime::now_utc()
                        .format(&time::format_description::well_known::Iso8601::DEFAULT)
                        .unwrap_or_default();
                    emit_approval_telemetry(
                        proxy_ctx,
                        host,
                        &method,
                        telemetry_path,
                        403,
                        start.elapsed().as_millis() as u32,
                        crate::telemetry_core::RequestDecision::ApprovalDenied {
                            approval_id: approval_id.clone(),
                            reason: reason.to_string(),
                            triggered_at,
                            resolved_at,
                            approved_by,
                        },
                        None,
                        Some(log_id),
                    );
                    return Ok(response::manual_approval_denied(&approval_id, reason));
                }
            }
        } else {
            (body, None, None, None)
        };

    // ── Provider-specific body transformation ────────────────────
    let forward_body = match rules.body_transform {
        Some(crate::apps::BodyTransform::GitHubCommitTrailer) => {
            if let (Some(agent_name), Some(project_id)) = (
                proxy_ctx.agent_name.as_deref(),
                proxy_ctx.project_id.as_deref(),
            ) {
                super::transforms::github_commit_trailer::try_inject_trailer(
                    host,
                    &method,
                    &path,
                    forward_body,
                    agent_name,
                    project_id,
                )
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(error = ?e, "body transform failed, forwarding empty body");
                    reqwest::Body::from(vec![])
                })
            } else {
                forward_body
            }
        }
        None => forward_body,
    };

    // ── Claim-mode request-body note (cloud) ──────────────────────
    // For an unclaimed partner-created org, the cloud build injects a calm
    // claim note into LLM requests; OSS is a passthrough no-op.
    let forward_body = hooks::prepare_request_body(rules, host, forward_body).await;

    // ── Provider-specific request signing ─────────────────────────
    let forward_body = match rules
        .finalizer
        .or_else(|| crate::apps::finalizer_for_host(host.split(':').next().unwrap_or(host)))
    {
        Some(crate::apps::RequestFinalizer::AwsSigV4) => {
            super::finalizers::aws_sigv4::finalize_request(
                host,
                method.as_str(),
                &upstream_path,
                &mut headers,
                forward_body,
            )
            .await?
        }
        #[cfg(feature = "cloud")]
        Some(crate::apps::RequestFinalizer::AwsAssumeRole) => {
            super::finalizers::aws_sts::finalize_request(
                host,
                method.as_str(),
                &upstream_path,
                &mut headers,
                forward_body,
            )
            .await?
        }
        None => forward_body,
    };

    // ── Forward to upstream ──────────────────────────────────────────
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

    // Response hints: intercept known-deprecated host error responses.
    if proxy_ctx.agent_token.is_some() {
        let hostname = super::strip_port(host);
        if let Some(hint) =
            super::hints::find_hint(hostname, &path, status.as_u16(), injection_count)
        {
            info!(
                method = %method,
                url = %url,
                status = %status.as_u16(),
                hint = %hint.error_code,
                "deprecated host — returning response hint"
            );
            return Ok(super::hints::hint_response(hint, hostname, &path));
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
                proxy_ctx.project_id.as_deref(),
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
                proxy_ctx.project_id.as_deref(),
            ));
        }

        // 2b. Known host but unrecognized API path — pre-fill a custom connection form.
        if apps::provider_for_host(hostname).is_some() {
            info!(method = %method, url = %url, status = %status.as_u16(), host = %hostname, "app not connected — no matching provider, custom connection");
            return Ok(response::app_not_connected_unknown_provider(
                status,
                hostname,
                proxy_ctx.agent_name.as_deref(),
                proxy_ctx.project_id.as_deref(),
            ));
        }

        // 3. Unknown host — no credentials at all, guide user to create a secret.
        info!(method = %method, url = %url, status = %status.as_u16(), "credential not found");
        return Ok(response::credential_not_found(
            status,
            hostname,
            &path,
            proxy_ctx.project_id.as_deref(),
        ));
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
                    proxy_ctx.project_id.as_deref(),
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
                    proxy_ctx.project_id.as_deref(),
                ));
            }
            if apps::provider_for_host(hostname).is_some() {
                info!(method = %method, url = %url, status = 400, host = %hostname, "auth-related 400 — no matching provider, custom connection");
                return Ok(response::app_not_connected_unknown_provider(
                    StatusCode::BAD_REQUEST,
                    hostname,
                    proxy_ctx.agent_name.as_deref(),
                    proxy_ctx.project_id.as_deref(),
                ));
            }
            info!(method = %method, url = %url, status = 400, "auth-related 400 — credential not found");
            return Ok(response::credential_not_found(
                StatusCode::BAD_REQUEST,
                hostname,
                &path,
                proxy_ctx.project_id.as_deref(),
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

    // Track all authenticated proxied requests and stream response body.
    // Hooks handle telemetry emission and optional response stream wrapping.
    let body_stream: hooks::BodyStream = if let (Some(aid), Some(gid)) = (
        proxy_ctx.project_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) {
        let hostname = super::strip_port(host);
        let (provider, _) = crate::apps::provider_for_host_and_path(hostname, &path)
            .unwrap_or((hostname, hostname));

        let ts = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Iso8601::DEFAULT)
            .unwrap_or_default();

        let telemetry_path = match path.find('?') {
            Some(i) => &path[..i],
            None => &path,
        };

        let resolved_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Iso8601::DEFAULT)
            .unwrap_or_default();
        let approval_decision = match (
            &approval_log_id,
            approval_id_for_telemetry,
            approval_triggered_at,
        ) {
            (Some(_), Some(aid_val), Some(triggered)) => {
                Some(crate::telemetry_core::RequestDecision::ApprovalApproved {
                    approval_id: aid_val,
                    triggered_at: triggered,
                    resolved_at,
                    approved_by: approval_approved_by,
                })
            }
            _ => None,
        };

        let meta = hooks::RequestMeta {
            org_id: proxy_ctx
                .organization_id
                .as_deref()
                .unwrap_or("")
                .to_string(),
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
            injected: injection_count > 0,
            connection_label: rules.connection_label.clone(),
            existing_log_id: approval_log_id,
            decision: approval_decision,
        };

        hooks::track_and_wrap(meta, rules, &resp_headers, upstream_resp.bytes_stream())
    } else {
        Box::pin(upstream_resp.bytes_stream().map_ok(Frame::data))
    };

    let body = http_body_util::StreamBody::new(body_stream);
    let mut response = Response::new(Either::Right(body));
    *response.status_mut() = status;

    for (name, value) in resp_headers.iter() {
        if is_forwarded_response_header(name) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }

    Ok(response)
}

fn emit_policy_telemetry(
    proxy_ctx: &super::ProxyContext,
    host: &str,
    method: &hyper::Method,
    path: &str,
    start: std::time::Instant,
    status: StatusCode,
    decision: crate::telemetry_core::RequestDecision,
) {
    let (pid, aid) = match (
        proxy_ctx.project_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) {
        (Some(p), Some(a)) => (p, a),
        _ => return,
    };
    let hostname = super::strip_port(host);
    let (provider, _) =
        crate::apps::provider_for_host_and_path(hostname, path).unwrap_or((hostname, hostname));
    let ts = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Iso8601::DEFAULT)
        .unwrap_or_default();
    let telemetry_path = path.split('?').next().unwrap_or(path);
    crate::telemetry::on_request(crate::telemetry::RequestEvent {
        org_id: proxy_ctx
            .organization_id
            .as_deref()
            .unwrap_or("")
            .to_string(),
        project_id: pid.to_string(),
        agent_id: aid.to_string(),
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
        injection_count: 0,
        timestamp: ts,
        injected: false,
        decision,
        connection_label: None,
        existing_log_id: None,
        log_id: None,
        budget_charge: None,
    });
}

#[allow(clippy::too_many_arguments)]
fn emit_approval_telemetry(
    proxy_ctx: &super::ProxyContext,
    host: &str,
    method: &hyper::Method,
    telemetry_path: &str,
    status: u16,
    latency_ms: u32,
    decision: crate::telemetry_core::RequestDecision,
    log_id: Option<String>,
    existing_log_id: Option<String>,
) {
    let (pid, aid) = match (
        proxy_ctx.project_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) {
        (Some(p), Some(a)) => (p, a),
        _ => return,
    };
    let hostname = super::strip_port(host);
    let (provider, _) = crate::apps::provider_for_host_and_path(hostname, telemetry_path)
        .unwrap_or((hostname, hostname));
    let ts = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Iso8601::DEFAULT)
        .unwrap_or_default();
    crate::telemetry::on_request(crate::telemetry::RequestEvent {
        org_id: proxy_ctx
            .organization_id
            .as_deref()
            .unwrap_or("")
            .to_string(),
        project_id: pid.to_string(),
        agent_id: aid.to_string(),
        agent_name: proxy_ctx
            .agent_name
            .as_deref()
            .unwrap_or("unknown")
            .to_string(),
        method: method.to_string(),
        host: host.to_string(),
        path: telemetry_path.to_string(),
        provider: provider.to_string(),
        status,
        latency_ms,
        injection_count: 0,
        timestamp: ts,
        injected: false,
        decision,
        connection_label: None,
        existing_log_id,
        log_id,
        budget_charge: None,
    });
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
