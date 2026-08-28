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
use crate::policy_engine;

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

/// Split `value` on every `sep` byte that lies OUTSIDE a double-quoted string.
/// `WWW-Authenticate` uses commas both between challenges AND between the
/// auth-params of one challenge, and realm/scope values are quoted and may
/// themselves contain commas — so a naive split is wrong. Returns borrowed
/// slices (no allocation).
///
/// `sep` is a `u8` and MUST be ASCII: the scan compares raw bytes, so both the
/// separator and the `"` toggle only ever match single ASCII bytes. Because
/// ASCII bytes never occur inside a multibyte UTF-8 sequence, every split index
/// lands on a char boundary — the slices are always valid. (A non-ASCII `sep`
/// would match a continuation byte and slice mid-codepoint; the debug assert
/// pins the contract.)
fn split_outside_quotes(value: &str, sep: u8) -> impl Iterator<Item = &str> {
    debug_assert!(
        sep.is_ascii() && sep != b'"',
        "sep must be a non-quote ASCII byte"
    );
    let mut in_quotes = false;
    let mut start = 0usize;
    let mut done = false;
    let bytes = value.as_bytes();
    std::iter::from_fn(move || {
        if done {
            return None;
        }
        let mut i = start;
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'"' {
                in_quotes = !in_quotes;
            } else if b == sep && !in_quotes {
                let seg = &value[start..i];
                start = i + 1;
                return Some(seg);
            }
            i += 1;
        }
        done = true;
        Some(&value[start..])
    })
}

/// True when `value` is an absolute `http(s)` URL with a non-empty host — the
/// shape a container/OCI registry (or any OAuth2 token-exchange) uses for the
/// `realm` that the client resolves anonymously to mint a token. A bare label
/// realm (`realm="OpenAI API"`, `realm="Stripe"`) is deliberately NOT a URL.
fn is_absolute_http_url(value: &str) -> bool {
    let v = value.trim();
    let bytes = v.as_bytes();
    // Compare the scheme on bytes (ASCII, case-insensitive) so we never slice a
    // str on a non-char-boundary; "http(s)://" is pure ASCII, so the resulting
    // index is always a valid boundary.
    let scheme_len = if bytes.len() >= 8 && bytes[..8].eq_ignore_ascii_case(b"https://") {
        8
    } else if bytes.len() >= 7 && bytes[..7].eq_ignore_ascii_case(b"http://") {
        7
    } else {
        return false;
    };
    // Require a non-empty host before any path/query/fragment.
    v[scheme_len..]
        .split(['/', '?', '#'])
        .next()
        .is_some_and(|host| !host.is_empty())
}

/// True when one `WWW-Authenticate` header value carries a **`Bearer`**
/// challenge whose own `realm` param is an absolute `http(s)` URL.
///
/// Parses the RFC 9110 `1#challenge` grammar: comma-separated (outside quotes),
/// where each `challenge = auth-scheme [ 1*SP #auth-param ]`. A segment is a
/// *continuation* auth-param when its leading token is followed (after optional
/// BWS) by `=` — `auth-param = token BWS "=" BWS ( token / quoted-string )`;
/// otherwise its leading token is a new auth-scheme. The realm is matched to
/// the scheme of ITS OWN challenge — so a `Basic` challenge with a URL-shaped
/// realm does NOT match, a `realm=` nested inside another param's quoted value
/// does NOT match (only the param whose NAME is `realm`), and
/// `Basic …, Bearer realm="https://…"` on one line DOES (including a
/// `realm ="…"` continuation with BWS before the `=`).
fn value_has_bearer_url_realm(value: &str) -> bool {
    let mut current_is_bearer = false;
    for segment in split_outside_quotes(value, b',') {
        let seg = segment.trim();
        if seg.is_empty() {
            continue;
        }
        // Leading token = up to the first whitespace or `=`. The segment is a
        // continuation param when, after that token, the next non-space char is
        // `=` (`name = value`, BWS allowed); otherwise the token is a new
        // auth-scheme and the remainder is its first auth-param.
        let token_end = seg
            .find(|c: char| c.is_ascii_whitespace() || c == '=')
            .unwrap_or(seg.len());
        let leading_token = &seg[..token_end];
        let after_token = seg[token_end..].trim_start();
        let param = if after_token.starts_with('=') {
            // continuation param of the current challenge (the whole segment)
            seg
        } else {
            // new challenge: leading_token is the auth-scheme, remainder is its
            // first auth-param (may be empty for a bare scheme)
            current_is_bearer = leading_token.eq_ignore_ascii_case("bearer");
            after_token
        };
        if current_is_bearer && param_is_url_realm(param) {
            return true;
        }
    }
    false
}

/// True when a single auth-param is `realm=<absolute http(s) URL>` (name
/// case-insensitive; value quoted-string or bare token). Only the param whose
/// NAME is exactly `realm` is considered.
fn param_is_url_realm(param: &str) -> bool {
    let Some((name, raw)) = param.trim().split_once('=') else {
        return false;
    };
    if !name.trim().eq_ignore_ascii_case("realm") {
        return false;
    }
    let value = raw.trim();
    // Strip surrounding quotes if present (quoted-string) — take up to the
    // closing quote; else take the bare token up to the next whitespace.
    let value = if let Some(inner) = value.strip_prefix('"') {
        inner.split_once('"').map_or(inner, |(v, _)| v)
    } else {
        value.split_whitespace().next().unwrap_or(value)
    };
    is_absolute_http_url(value)
}

/// True when the upstream 401/403 carries a `Bearer` `WWW-Authenticate`
/// challenge whose `realm` is an absolute `http(s)` URL — i.e. a container
/// registry / OAuth2 token-exchange the client resolves ITSELF (the anonymous
/// Docker Registry v2 token dance, or its own creds). In that case the gateway
/// must forward the real 401 so the client can complete auth, NOT hijack it
/// with the `credential_not_found` nudge (which would strip the challenge and
/// break every `podman pull` / `docker pull` of a public image).
///
/// Deliberately narrow: `Basic`, a label-realm `Bearer` (`realm="OpenAI API"`),
/// an `error=`-only / `authorization_uri=` challenge (Azure), and a header-less
/// 401 all fail this and keep the nudge — for those there is no anonymous flow
/// to break, so the nudge is the correct UX.
fn upstream_offers_anonymous_token_challenge(headers: &hyper::HeaderMap) -> bool {
    headers
        .get_all(hyper::header::WWW_AUTHENTICATE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(value_has_bearer_url_realm)
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

/// Mint any deferred credentials and fold their rules into the request's
/// injection set. Called once the request is allowed — see
/// [`crate::connect::PendingInjection`].
///
/// The merge is re-run rather than appended to: `merge_injection_rules` encodes
/// which rule wins when a secret and an app both cover a host, and appending
/// would silently hand that contest to the app.
///
/// A credential that cannot be resolved BLOCKS. The decision was made on the
/// premise that one would be injected, so forwarding the request bare would
/// send it upstream with less authority than the policy assumed — and read to
/// the agent as an inexplicable upstream 401.
///
/// KNOWN GAP: this runs before the manual-approval wait, and before the
/// `pre_forward` refusals (budget, quota, the Dropbox guard) — those
/// need `injection_count`, so the ordering is forced. A request denied at any
/// of those points has therefore already minted. Closing it would mean moving
/// header injection past the approval hold, which changes what `pre_forward`
/// inspects for every request — more risk than the case is worth. Requests
/// blocked by POLICY, the ones that matter, never reach here.
// The Err is a full ready-to-send refusal Response (~152 bytes); boxed so the
// hot Ok path moves a pointer-sized Result instead of one sized for the cold
// refusal arm (clippy::result_large_err under -D warnings since Rust 1.98).
pub(super) async fn materialize_injections<'a>(
    rules: &'a ResolvedRules,
    engine: &crate::connect::PolicyEngine,
    cache: &dyn CacheStore,
    method: &str,
    path: &str,
) -> std::result::Result<Cow<'a, [inject::InjectionRule]>, Box<Response<hooks::ForwardResponseBody>>>
{
    // Nothing deferred (every request that isn't resource-scoped) borrows the
    // rules as they are — this sits on the hot path, so it must not allocate.
    if rules.pending_injections.is_empty() {
        return Ok(Cow::Borrowed(&rules.injection_rules));
    }
    let mut app_rules = Vec::new();
    for pending in &rules.pending_injections {
        match engine.materialize_pending(pending, cache).await {
            Some(minted) => app_rules.extend(minted),
            None => {
                warn!(
                    connection_id = %pending.conn.id,
                    provider = %pending.conn.provider,
                    %method,
                    %path,
                    "could not resolve the connection's credential after the request was allowed"
                );
                return Err(Box::new(response::json(
                    StatusCode::BAD_GATEWAY,
                    serde_json::json!({
                        "error": "credential_unavailable",
                        "message": format!(
                            "OneCLI could not obtain a credential for the {} connection, \
                             so the request was not forwarded.",
                            pending.conn.provider
                        ),
                    }),
                )));
            }
        }
    }
    Ok(Cow::Owned(inject::merge_injection_rules(
        app_rules,
        rules.injection_rules.clone(),
    )))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn forward_request(
    req: Request<Incoming>,
    host: &str,
    // The original, pre-rewrite host the live policy rules were assembled from —
    // the host policy must match against. Differs from `host` only when an app
    // rewrites the upstream to a provider-specific site; `host` stays the actual
    // forward target (URL, `is_llm_host`, interception).
    policy_host: &str,
    scheme: &str,
    http_client: reqwest::Client,
    rules: &ResolvedRules,
    cache: &dyn CacheStore,
    proxy_ctx: &ProxyContext,
    approval_store: &Arc<dyn ApprovalStore>,
    engine: &crate::connect::PolicyEngine,
) -> Result<Response<hooks::ForwardResponseBody>> {
    let start = std::time::Instant::now();
    let method = req.method().clone();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("{scheme}://{host}{path}");

    // An empty resource scope reaches nothing, so refuse before anything can
    // hand out or mint a credential — ahead of the token interception below,
    // which would otherwise serve the connection's access token straight to the
    // client and bypass every later check.
    if let Some(resp) = hooks::refuse_empty_scope(rules, proxy_ctx, host, method.as_str(), &path) {
        warn!(method = %method, url = %url, "empty resource scope — request denied");
        return Ok(resp);
    }

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
    let default_intercept_shape =
        default_interceptions::match_target(super::strip_port(host), &path, &method);
    // A request with this shape that the synthetic handler DECLINES is a real
    // OAuth token exchange (e.g. a fresh `codex login` authorization-code
    // grant). Its upstream response — success or failure — is part of the
    // client's own auth protocol and must reach it verbatim: hijacking a
    // failed exchange with the credential nudge would tell the agent to vault
    // a secret for the token endpoint, the exact wrong action (#490).
    let is_real_oauth_exchange = default_intercept_shape.is_some();
    let default_target = default_intercept_shape
        .filter(|_| content_length_at_most(req.headers(), MAX_DEFAULT_INTERCEPT_BODY));

    // Buffer the request body for condition matching, when the request guard needs
    // to inspect it (e.g. Dropbox folder scoping reads the JSON body), or for a
    // matched default interception. In OSS, both predicates return false → zero
    // overhead unless a default interception matched.
    let (condition_buffer, req) = if crate::policy_engine::needs_body_buffer(&rules.policy_rules_v2)
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

    let has_injections = rules.injects();

    // Step-7 app-availability pre-check (DB-free — the set was resolved at
    // connect). Governs ONLY identifiable app providers, so raw/unknown hosts and
    // the LLM host are structurally never blocked (the enforce-deny carve). "Open"
    // orgs / OSS / enforcement-off resolve to unrestricted → a no-op here.
    // Matches on `policy_host` (pre-rewrite + port-stripped — the host the
    // provider registry knows), NOT the port-bearing / possibly-rewritten `host`,
    // which would silently identify no provider and never block.
    if let Some(provider) =
        crate::ee::principals::app_availability_block(policy_host, &path, &rules.available_apps)
    {
        info!(method = %method, host = %policy_host, provider = %provider, "app unavailable to workspace — refusing request");
        return Ok(crate::ee::response::app_unavailable(
            &provider,
            method.as_str(),
            &path,
            policy_host,
        ));
    }

    // The first-match engine over the published `policy_rules_v2` is authoritative.
    // `policy_host` is the pre-rewrite rule-match host; `is_llm_host(host)` is the
    // effective host for the deny-default carve.
    let (decision, matched_rule) = policy_engine::evaluate(
        proxy_ctx,
        policy_host,
        method.as_str(),
        &path,
        condition_buffer.as_deref(),
        has_injections,
        policy::is_llm_host(host),
        rules.winning_connection_id.as_deref(),
        cache,
        &rules.policy_rules_v2,
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
                matched_rule.clone(),
            );
            return Ok(response::blocked_by_default_policy(
                method.as_str(),
                &path,
                host,
                proxy_ctx.workspace_id.as_deref(),
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
                matched_rule.clone(),
            );
            return Ok(response::blocked_by_policy(
                method.as_str(),
                &path,
                rule_name,
                proxy_ctx.workspace_id.as_deref(),
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
                matched_rule.clone(),
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

    // The request is allowed: mint any deferred credential now. Everything
    // above could have refused it, and a refused request must never cause a
    // live credential to be created upstream.
    let injection_rules =
        match materialize_injections(rules, engine, cache, method.as_str(), &path).await {
            Ok(rules) => rules,
            Err(resp) => return Ok(*resp),
        };

    // Apply injection rules — upstream_path may gain query-param secrets;
    // the original `path`/`url` stays clean for logging and approval metadata.
    let mut upstream_path = path.clone();
    let injection_count =
        inject::apply_injections(&mut headers, &mut upstream_path, &injection_rules);
    let upstream_url = format!("{scheme}://{host}{upstream_path}");

    if let Some(resp) = hooks::pre_forward(
        rules,
        proxy_ctx,
        host,
        cache,
        &engine.pool,
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

            let workspace_id = match proxy_ctx.workspace_id.as_deref() {
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
                workspace_id: workspace_id.to_string(),
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
                .prepare_wait(org_id, workspace_id, &approval_id)
                .await;

            // Guard cleans up the approval if the agent disconnects (future cancelled).
            // Created BEFORE store() so there's no window where cancellation misses cleanup.
            let mut guard = ApprovalGuard::new(
                approval_id.clone(),
                org_id.to_string(),
                workspace_id.to_string(),
                Arc::clone(approval_store),
            );

            if let Err(e) = approval_store.store(&approval).await {
                warn!(url = %url, error = ?e, "failed to store pending approval");
                guard.defuse();
                approval_store
                    .remove(org_id, workspace_id, &approval_id)
                    .await;
                return Ok(response::approval_store_unavailable());
            }

            let telemetry_path = path.split('?').next().unwrap_or(&path);
            let triggered_at = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Iso8601::DEFAULT)
                .unwrap_or_default();

            let log_id = uuid::Uuid::new_v4().to_string();
            guard.set_log_context(log_id.clone(), engine.pool.clone());
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
                // The pending INSERT is what persists the column (approval
                // resolution is an UPDATE that never writes it).
                matched_rule.clone(),
            );

            info!(
                url = %url,
                approval_id = %approval_id,
                agent = %agent_name,
                injections = injection_count,
                "holding request for approval"
            );

            let mut shutdown_signal = crate::shutdown::subscribe();
            let outcome = tokio::select! {
                outcome = decision_rx.wait(Duration::from_secs(APPROVAL_TIMEOUT_SECS)) => {
                    Some(outcome)
                }
                // Shutting down with nobody having decided. Left alone this
                // request would be cut without an answer while its approval
                // card lingered in the dashboard for another three minutes —
                // reviewable, and approvable into a process that no longer
                // exists. Release it explicitly instead.
                _ = shutdown_signal.wait() => None,
            };

            let Some(outcome) = outcome else {
                warn!(
                    url = %url,
                    approval_id = %approval_id,
                    "shutting down — releasing held request for retry"
                );
                // Defuse first: the guard's Drop would spawn this same cleanup
                // detached, racing the pool close that follows the drain.
                guard.defuse();
                approval_store
                    .remove(org_id, workspace_id, &approval_id)
                    .await;
                let resolved_at = time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Iso8601::DEFAULT)
                    .unwrap_or_default();
                emit_approval_telemetry(
                    proxy_ctx,
                    host,
                    &method,
                    telemetry_path,
                    503,
                    start.elapsed().as_millis() as u32,
                    crate::telemetry_core::RequestDecision::ApprovalDenied {
                        approval_id: approval_id.clone(),
                        reason: "gateway_restarting".to_string(),
                        triggered_at,
                        resolved_at,
                        approved_by: None,
                    },
                    None,
                    Some(log_id),
                    matched_rule.clone(),
                );
                return Ok(response::gateway_restarting(&approval_id));
            };

            // Decision received (or timed out) — defuse guard, handle explicitly.
            guard.defuse();

            let decision = outcome.as_ref().map(|o| o.decision);
            let approved_by = outcome.and_then(|o| o.approved_by);

            match decision {
                Some(ApprovalDecision::Approve) => {
                    info!(url = %url, approval_id = %approval_id, "APPROVED — forwarding request");
                    approval_store
                        .remove(org_id, workspace_id, &approval_id)
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
                        .remove(org_id, workspace_id, &approval_id)
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
                        matched_rule.clone(),
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
            if let (Some(agent_name), Some(workspace_id)) = (
                proxy_ctx.agent_name.as_deref(),
                proxy_ctx.workspace_id.as_deref(),
            ) {
                super::transforms::github_commit_trailer::try_inject_trailer(
                    host,
                    &method,
                    &path,
                    forward_body,
                    agent_name,
                    workspace_id,
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
    {
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
    // Real OAuth exchanges are exempt (see `is_real_oauth_exchange`): their
    // 401s are the provider talking to the client, not a missing credential.
    if injection_count == 0
        && !is_real_oauth_exchange
        && (status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN)
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
                proxy_ctx.workspace_id.as_deref(),
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
                proxy_ctx.workspace_id.as_deref(),
            ));
        }

        // 2b. Known host but unrecognized API path — pre-fill a custom connection form.
        if apps::provider_for_host(hostname).is_some() {
            info!(method = %method, url = %url, status = %status.as_u16(), host = %hostname, "app not connected — no matching provider, custom connection");
            return Ok(response::app_not_connected_unknown_provider(
                status,
                hostname,
                proxy_ctx.agent_name.as_deref(),
                proxy_ctx.workspace_id.as_deref(),
            ));
        }

        // 3. Unknown host — no credentials at all, guide user to create a secret.
        //
        // EXCEPT when the upstream advertises a Bearer challenge with a
        // URL realm: that is a container registry / OAuth2 token-exchange the
        // client resolves ITSELF (the anonymous Docker Registry v2 token
        // dance). Hijacking it with the nudge strips the `WWW-Authenticate`
        // challenge and breaks every `podman pull` / `docker run` of a public
        // image from inside a sandbox. Forward the real 401 so the client can
        // mint its token. (Basic, label-realm Bearer, and header-less 401s do
        // not match — they keep the nudge, which is correct for them.)
        if upstream_offers_anonymous_token_challenge(&resp_headers) {
            info!(
                method = %method,
                url = %url,
                status = %status.as_u16(),
                "forwarding registry/token-exchange auth challenge (no nudge)"
            );
        } else {
            info!(method = %method, url = %url, status = %status.as_u16(), "credential not found");
            return Ok(response::credential_not_found(
                status,
                hostname,
                &path,
                proxy_ctx.workspace_id.as_deref(),
            ));
        }
    }

    // Some APIs (e.g. Google) return 400 instead of 401 for invalid/missing API keys.
    // Buffer the body and check for auth-related keywords before deciding.
    // Real OAuth exchanges are exempt here too: a 400 `invalid_grant` from a
    // token endpoint must reach the client verbatim.
    if injection_count == 0 && !is_real_oauth_exchange && status == StatusCode::BAD_REQUEST {
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
                    proxy_ctx.workspace_id.as_deref(),
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
                    proxy_ctx.workspace_id.as_deref(),
                ));
            }
            if apps::provider_for_host(hostname).is_some() {
                info!(method = %method, url = %url, status = 400, host = %hostname, "auth-related 400 — no matching provider, custom connection");
                return Ok(response::app_not_connected_unknown_provider(
                    StatusCode::BAD_REQUEST,
                    hostname,
                    proxy_ctx.agent_name.as_deref(),
                    proxy_ctx.workspace_id.as_deref(),
                ));
            }
            info!(method = %method, url = %url, status = 400, "auth-related 400 — credential not found");
            return Ok(response::credential_not_found(
                StatusCode::BAD_REQUEST,
                hostname,
                &path,
                proxy_ctx.workspace_id.as_deref(),
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
        proxy_ctx.workspace_id.as_deref(),
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
            workspace_id: aid.to_string(),
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
            matched_rule,
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

#[allow(clippy::too_many_arguments)]
fn emit_policy_telemetry(
    proxy_ctx: &super::ProxyContext,
    host: &str,
    method: &hyper::Method,
    path: &str,
    start: std::time::Instant,
    status: StatusCode,
    decision: crate::telemetry_core::RequestDecision,
    matched_rule: Option<crate::policy::MatchedRule>,
) {
    let (pid, aid) = match (
        proxy_ctx.workspace_id.as_deref(),
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
        workspace_id: pid.to_string(),
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
        matched_rule,
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
    matched_rule: Option<crate::policy::MatchedRule>,
) {
    let (pid, aid) = match (
        proxy_ctx.workspace_id.as_deref(),
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
        workspace_id: pid.to_string(),
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
        matched_rule,
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
        // Dropbox's 400 says "Invalid authorization value in HTTP header" —
        // the Authorization HEADER is how several APIs phrase a missing or
        // bad credential in a 400 body. Matched as the two-word phrases only:
        // bare "authorization" would also catch OAuth-protocol 400s that must
        // reach the agent verbatim ("authorization_pending" device-flow
        // polls, "Malformed authorization code." exchanges — and
        // oauth2.googleapis.com is a registered host).
        "authorization header",
        "authorization value",
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
    fn auth_error_detects_dropbox_invalid_authorization_400() {
        // Dropbox answers a missing credential with a plain-text 400, not a
        // 401 — this exact phrase must keep routing to app_not_connected or
        // the chat's connect card never shows for Dropbox.
        let body = br#"Error in call to API function "files/list_folder": Invalid authorization value in HTTP header/URL parameter"#;
        assert!(body_indicates_auth_error(body));
    }

    #[test]
    fn auth_error_detects_missing_authorization_header_400() {
        // The other half of the header-noun phrasing: "Authorization header"
        // (Dropbox pins "authorization value" above).
        let body = br#"{"message": "Missing Authorization header"}"#;
        assert!(body_indicates_auth_error(body));
    }

    #[test]
    fn auth_error_ignores_oauth_device_flow_pending_400() {
        // Google's device-flow poll answers 400 `authorization_pending` until
        // the user approves — and oauth2.googleapis.com is a registered
        // gateway host. Matching it would replace the body the OAuth client
        // must keep reading with a bogus "not connected" refusal.
        let body = br#"{"error": "authorization_pending"}"#;
        assert!(!body_indicates_auth_error(body));
    }

    #[test]
    fn auth_error_ignores_oauth_code_exchange_400() {
        // Authorization-CODE grant errors talk about the OAuth protocol, not
        // a missing credential on the proxied request.
        let body =
            br#"{"error": "invalid_grant", "error_description": "Malformed authorization code."}"#;
        assert!(!body_indicates_auth_error(body));
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

    // ── Registry / token-exchange challenge detection (arm #4 passthrough) ──
    // Header values below are the real ones probed live 2026-08-22.

    fn www_auth(value: &str) -> hyper::HeaderMap {
        let mut h = hyper::HeaderMap::new();
        h.append(
            hyper::header::WWW_AUTHENTICATE,
            hyper::header::HeaderValue::from_str(value).unwrap(),
        );
        h
    }

    #[test]
    fn token_challenge_true_for_real_registries() {
        // A URL realm is the shape every pullable registry uses — the client
        // resolves it anonymously, so the gateway must NOT nudge.
        let registries = [
            // docker.io
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io""#,
            // docker.io on a real resource (scope present)
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/ubuntu:pull""#,
            // Google Artifact Registry — NO service param
            r#"Bearer realm="https://us-docker.pkg.dev/v2/token""#,
            // gcr.io — service is UNQUOTED (bare token); realm still a URL
            r#"Bearer realm="https://gcr.io/v2/token",service=gcr.io"#,
            // public ECR
            r#"Bearer realm="https://public.ecr.aws/token/",service="public.ecr.aws",scope="aws""#,
            // self-hosted (Harbor-style) token server on an arbitrary host
            r#"Bearer realm="https://harbor.example.com/service/token",service="harbor-registry""#,
            // case-insensitive scheme
            r#"bearer realm="https://ghcr.io/token",service="ghcr.io""#,
        ];
        for c in registries {
            assert!(
                upstream_offers_anonymous_token_challenge(&www_auth(c)),
                "expected passthrough for: {c}"
            );
        }
    }

    #[test]
    fn token_challenge_false_keeps_the_nudge() {
        // These must KEEP the credential nudge — either there is no anonymous
        // flow to break, or no challenge at all.
        let nudge = [
            // OpenAI — Bearer but realm is a LABEL, not a URL
            r#"Bearer realm="OpenAI API""#,
            // Stripe — Basic scheme (client supplies its own creds)
            r#"Basic realm="Stripe""#,
            // Azure — Bearer but authorization_uri, error=, and NO realm
            r#"Bearer authorization_uri="https://login.windows.net/", error="invalid_token", error_description="missing header""#,
            // Bearer with no realm at all
            "Bearer",
            // realm present but not http(s)
            r#"Bearer realm="ftp://example.com/token""#,
            // relative / non-absolute realm
            r#"Bearer realm="/token""#,
            // a param that merely ends in "realm" must not match
            r#"Bearer myrealm="https://evil.example/token""#,
            // Basic with a URL realm (unusual) must not match — Basic is not
            // the anonymous token dance, AND the URL label even contains the
            // substring "bearer" (regression: a naive substring match matched).
            r#"Basic realm="https://bearer.example.com/login""#,
            // The realm= is NESTED inside another param's quoted value — only a
            // param whose NAME is realm counts (regression: nested match).
            r#"Bearer error="see realm=https://x/token for details""#,
        ];
        for c in nudge {
            assert!(
                !upstream_offers_anonymous_token_challenge(&www_auth(c)),
                "expected nudge (no passthrough) for: {c}"
            );
        }
    }

    #[test]
    fn token_challenge_true_when_bearer_shares_a_line_with_basic() {
        // Two challenges on ONE header line, Basic first: the Bearer's own URL
        // realm must still be found (regression: the first realm, "Corp", is
        // not a URL and would wrongly suppress passthrough → broken registry
        // pull). Order-independent.
        for c in [
            r#"Basic realm="Corp", Bearer realm="https://auth.docker.io/token",service="registry.docker.io""#,
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io", Basic realm="Corp""#,
        ] {
            assert!(
                upstream_offers_anonymous_token_challenge(&www_auth(c)),
                "expected passthrough for combined line: {c}"
            );
        }
    }

    #[test]
    fn token_challenge_realm_value_with_comma_is_not_split() {
        // A quoted realm containing a comma must not be truncated by the
        // challenge/param splitter.
        assert!(upstream_offers_anonymous_token_challenge(&www_auth(
            r#"Bearer realm="https://auth.example.com/token,v2",service="reg""#
        )));
    }

    #[test]
    fn token_challenge_handles_bws_before_equals_on_a_continuation_param() {
        // RFC 9110 auth-param allows BWS around '='. A continuation param whose
        // '=' is preceded by a space must still be recognized as this Bearer
        // challenge's realm (regression: classifying by first-whitespace-token
        // treated `realm =…` as a new auth-scheme and dropped the passthrough).
        assert!(upstream_offers_anonymous_token_challenge(&www_auth(
            r#"Bearer service="x", realm ="https://auth.docker.io/token""#
        )));
        // BWS on the FIRST param too.
        assert!(upstream_offers_anonymous_token_challenge(&www_auth(
            r#"Bearer realm = "https://auth.docker.io/token""#
        )));
    }

    #[test]
    fn token_challenge_multibyte_header_value_is_safely_ignored() {
        // A WWW-Authenticate field-value is ASCII (obs-text is rejected by
        // HeaderValue::to_str), so any value carrying a multibyte char is
        // conservatively dropped by the to_str filter — the function returns
        // false (keeps the nudge) and NEVER panics. Real registry/OAuth
        // challenges are ASCII; the splitter's own byte-boundary safety on
        // multibyte input is proven directly in
        // split_outside_quotes_respects_quotes_and_boundaries.
        assert!(!upstream_offers_anonymous_token_challenge(&www_auth(
            r#"Bearer realm="OpenAI™ API""#
        )));
        // Even a legitimate URL-realm Bearer is dropped if a multibyte char
        // appears anywhere on the same (malformed) header line — safe, not a
        // panic. A conformant ASCII line matches normally (covered elsewhere).
        assert!(!upstream_offers_anonymous_token_challenge(&www_auth(
            r#"Basic realm="Café", Bearer realm="https://auth.docker.io/token""#
        )));
    }

    #[test]
    fn split_outside_quotes_respects_quotes_and_boundaries() {
        let parts: Vec<&str> = split_outside_quotes(r#"a="x,y", b="z", c"#, b',')
            .map(str::trim)
            .collect();
        assert_eq!(parts, vec![r#"a="x,y""#, r#"b="z""#, "c"]);
        // A multibyte char adjacent to the separator: split points stay on char
        // boundaries (would panic if the byte scan mis-fired mid-codepoint).
        let parts: Vec<&str> = split_outside_quotes("café,x", b',').collect();
        assert_eq!(parts, vec!["café", "x"]);
        // No separator → one segment (the whole string).
        let parts: Vec<&str> = split_outside_quotes("solo", b',').collect();
        assert_eq!(parts, vec!["solo"]);
    }

    #[test]
    fn token_challenge_false_when_header_absent() {
        assert!(!upstream_offers_anonymous_token_challenge(
            &hyper::HeaderMap::new()
        ));
        // empty value
        assert!(!upstream_offers_anonymous_token_challenge(&www_auth("")));
    }

    #[test]
    fn token_challenge_true_across_multiple_header_lines() {
        // Two separate WWW-Authenticate lines: a Basic label-realm one and a
        // Bearer URL-realm one — the registry line wins.
        let mut h = www_auth(r#"Basic realm="Corp""#);
        h.append(
            hyper::header::WWW_AUTHENTICATE,
            hyper::header::HeaderValue::from_str(
                r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io""#,
            )
            .unwrap(),
        );
        assert!(upstream_offers_anonymous_token_challenge(&h));
    }

    #[test]
    fn param_is_url_realm_quoted_bare_and_case() {
        assert!(param_is_url_realm(r#"realm="https://x/token""#));
        // bare token value (gcr.io ships unquoted params)
        assert!(param_is_url_realm("realm=https://x/token"));
        // case-insensitive param name
        assert!(param_is_url_realm(r#"REALM="https://x/token""#));
        // not a realm param
        assert!(!param_is_url_realm(r#"service="registry.docker.io""#));
        // realm but not a URL
        assert!(!param_is_url_realm(r#"realm="OpenAI API""#));
        // a name that merely ends in "realm"
        assert!(!param_is_url_realm(r#"myrealm="https://x""#));
    }

    #[test]
    fn is_absolute_http_url_accepts_only_real_urls() {
        for ok in [
            "https://auth.docker.io/token",
            "http://localhost:5000/token",
            "HTTPS://Auth.Example.com/Token", // scheme case-insensitive
            "https://host",                   // no path
        ] {
            assert!(is_absolute_http_url(ok), "should accept: {ok}");
        }
        for bad in [
            "ftp://example.com",
            "/token",        // relative
            "OpenAI API",    // label
            "https://",      // empty host
            "https:///path", // empty host with path
            "",
        ] {
            assert!(!is_absolute_http_url(bad), "should reject: {bad}");
        }
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
