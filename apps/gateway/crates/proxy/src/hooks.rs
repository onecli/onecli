//! Forward hooks — extension points for the request forwarding pipeline.
//!
//! The cloud-specific blocks (granular access, budgets, the free-plan call
//! quota) are inert without their data: no session policy and no budget
//! bindings mean every hook degrades to a passthrough. The one hard edition
//! gate is the call quota, which is a cloud-billing concept (see
//! `call_limit_for_plan`).

use futures_util::TryStreamExt;
use hyper::body::{Bytes, Frame};
use hyper::Response;
use tracing::warn;

use cache::CacheStore;

use super::mitm::ResolvedRules;
use context::ProxyContext;
use ee::response as ee_response;

// ── Shared types ────────────────────────────────────────────────────────

// The response-stream aliases live in `crate::context` (shared with the ee
// responses and the budget meter); re-exported so existing paths hold.
pub use context::{BodyStream, ForwardResponseBody};

/// Common telemetry fields for a proxied request, passed from forward to hooks.
/// Lives in `telemetry::core` (shared with the budget meter, which compiles in
/// every edition); re-exported here for the forwarding path.
pub use telemetry::core::RequestMeta;

// ── Quota ───────────────────────────────────────────────────────────────

const FREE_PLAN_INJECTION_CALL_LIMIT: u64 = 500;

/// The injected-call quota for a plan label — 0 means unlimited.
///
/// The free-tier quota is a cloud-billing concept: the onprem edition has no
/// plans (every org carries whatever `subscription_status` the schema
/// defaulted), so it is never call-limited. Takes `Edition` as a parameter so
/// both arms are table-testable without touching process env.
fn call_limit_for_plan(edition: common::edition::Edition, plan: &str) -> u64 {
    if edition != common::edition::Edition::Cloud {
        return 0;
    }
    if plan == "free" {
        FREE_PLAN_INJECTION_CALL_LIMIT
    } else {
        0
    }
}

fn quota_key_and_ttl(org_id: &str) -> (String, u64) {
    let now = time::OffsetDateTime::now_utc();
    let month = format!("{}-{:02}", now.year(), now.month() as u8);
    let days_remaining = now.month().length(now.year()) as u64 - now.day() as u64 + 1;
    (
        format!("api:quota:injection-calls:{org_id}:{month}"),
        days_remaining * 86400,
    )
}

// ── Hooks ───────────────────────────────────────────────────────────────

pub fn prepare_request(
    rules: &ResolvedRules,
    _host: &str,
    _path: &str,
    headers: &mut hyper::HeaderMap,
) {
    // For a budgeted credential with a metering strategy, force an
    // identity-encoded response so the meter can read token usage — Anthropic's
    // non-streaming JSON body would otherwise arrive gzip/br-compressed.
    if rules
        .budget_bindings
        .iter()
        .any(|b| ee::budget::has_meter(&b.secret_type))
    {
        headers.remove(hyper::header::ACCEPT_ENCODING);
    }
}

/// Whether the request guard needs the buffered request body to decide.
/// Delegated to the granular-access module (e.g. Dropbox folder scoping reads
/// the JSON body of `api.dropboxapi.com` calls).
pub fn needs_request_body(rules: &ResolvedRules, host: &str, method: &str, path: &str) -> bool {
    ee::granular_access::needs_request_body(rules.session_policy.as_ref(), host, method, path)
}

/// Refuse a request whose resource scope allows nothing, before any credential
/// is materialized or served. An empty scope is the composition of an org
/// boundary with a workspace selection that do not overlap — no request can ever
/// be in scope, so this precedes the per-provider guards (which reason about a
/// non-empty allowlist) and the credential mint itself.
pub fn refuse_empty_scope(
    rules: &ResolvedRules,
    proxy_ctx: &ProxyContext,
    host: &str,
    method: &str,
    path: &str,
) -> Option<Response<ForwardResponseBody>> {
    if !ee::granular_access::denies_everything(rules.session_policy.as_ref()) {
        return None;
    }
    // Returns before forward.rs emits its own telemetry, so log here — a block
    // the operator can't see in the activity feed may as well not have a
    // reason. Same treatment as the granular denial in `pre_forward`.
    emit_block_telemetry(proxy_ctx, host, method, path, "Empty resource scope");
    Some(ee_response::forbidden_empty_scope())
}

#[allow(clippy::too_many_arguments)]
pub async fn pre_forward(
    rules: &ResolvedRules,
    proxy_ctx: &ProxyContext,
    host: &str,
    cache: &dyn CacheStore,
    pool: &sqlx::PgPool,
    injection_count: usize,
    method: &str,
    path: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Option<Response<ForwardResponseBody>> {
    // Granular resource enforcement (e.g. Dropbox folder allowlist). Runs before
    // the quota check below — it must apply on every plan, and a denied request
    // should not consume the agent's quota. Provider-specific logic lives in the
    // granular_access module; this hook only dispatches.
    if let Some(denial) = ee::granular_access::enforce_request(
        rules.session_policy.as_ref(),
        host,
        path,
        headers,
        body,
    ) {
        warn!(host = %common::util::strip_port(host), %path, reason = %denial.reason, "granular access denied");
        // The block returns before forward.rs emits telemetry, so log it here —
        // surfaces as a "Blocked" row in the activity feed.
        emit_block_telemetry(proxy_ctx, host, method, path, denial.rule_name);
        return Some(ee_response::forbidden_resource(
            &denial.reason,
            &denial.allowed,
        ));
    }

    // Budget: block when the effective credential for this host has reached its
    // spend cap. Runs regardless of plan (the call quota below is free-plan only,
    // so the budget check must precede its early return). Delivered as a
    // `budget_exceeded` 403, like the gateway's other policy blocks.
    for binding in &rules.budget_bindings {
        if ee::budget::is_over_budget(cache, pool, binding).await {
            warn!(
                secret_id = %binding.secret_id,
                subject = %binding.subject,
                "budget exceeded — blocking request"
            );
            emit_block_telemetry(proxy_ctx, host, method, path, "budget_exceeded");
            return Some(ee_response::budget_exceeded(
                binding,
                proxy_ctx.workspace_id.as_deref(),
            ));
        }
    }

    let limit = call_limit_for_plan(common::edition::edition(), &rules.plan);
    if limit == 0 || injection_count == 0 {
        return None;
    }
    // Every injected call counts toward the quota, including LLM hosts: we
    // custody and inject the user's credential regardless of destination.
    // Over the limit, though, only integration calls are blocked — LLM hosts
    // are still counted but always allowed through, so a free user's agent
    // keeps working while paid-tier integrations are gated. (is_llm_host is the
    // same check that exempts LLM hosts from deny-by-default policy in
    // forward.rs / websocket.rs.)
    let org_id = proxy_ctx.organization_id.as_deref()?;
    let (key, ttl) = quota_key_and_ttl(org_id);
    let count = cache.incr(&key, ttl).await?;
    if count > limit && !policy::is_llm_host(host) {
        warn!(org_id, count, limit, "integration call quota exceeded");
        return Some(ee_response::quota_exceeded(limit, Some(org_id)));
    }
    None
}

pub fn track_and_wrap(
    meta: RequestMeta,
    rules: &ResolvedRules,
    resp_headers: &hyper::HeaderMap,
    stream: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> BodyStream {
    // Budget metering: for a 2xx response whose effective credential is a
    // budgeted, metered provider, wrap the stream to price usage at stream end
    // (it fires telemetry with the charge then). Only 2xx is metered — errors
    // aren't billable.
    //
    // There is at most one effective budgeted credential per host (the
    // ConnectResponse is cached per host), so `budget_bindings` holds 0/1 metered
    // entries and metering the first is exact. `pre_forward` still gates *every*
    // binding, so even a degenerate multi-binding config can't underenforce —
    // only (harmlessly) undermeter a second key that isn't actually the one used.
    if (200..300).contains(&meta.status) {
        if let Some(binding) = rules
            .budget_bindings
            .iter()
            .find(|b| ee::budget::has_meter(&b.secret_type))
        {
            let is_sse = resp_headers
                .get(hyper::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|ct| ct.contains("text/event-stream"));
            return ee::budget::wrap_metered(binding, meta, is_sse, Box::pin(stream));
        }
    }
    telemetry::on_request(meta.into_event(None));
    Box::pin(stream.map_ok(Frame::data))
}

// ── Blocked-request telemetry ───────────────────────────────────────────

/// Emits a request-log event for a request the guard blocked. The guard
/// returns before `forward.rs` runs its normal telemetry, so without this the
/// denial would be invisible in the activity feed. Mirrors
/// `emit_policy_telemetry`; renders as a red "Blocked" row attributed to
/// `rule_name`.
fn emit_block_telemetry(
    proxy_ctx: &ProxyContext,
    host: &str,
    method: &str,
    path: &str,
    rule_name: &str,
) {
    let (Some(pid), Some(aid)) = (
        proxy_ctx.workspace_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) else {
        return;
    };
    let hostname = common::util::strip_port(host);
    let (provider, _) =
        apps::provider_for_host_and_path(hostname, path).unwrap_or((hostname, hostname));
    let ts = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Iso8601::DEFAULT)
        .unwrap_or_default();
    let telemetry_path = path.split('?').next().unwrap_or(path);
    telemetry::on_request(telemetry::RequestEvent {
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
        // Every guard block is a 403 Forbidden.
        status: 403,
        latency_ms: 0,
        injection_count: 0,
        timestamp: ts,
        injected: false,
        decision: telemetry::core::RequestDecision::Blocked {
            rule_name: rule_name.to_string(),
        },
        connection_label: None,
        existing_log_id: None,
        log_id: None,
        // Blocked before forwarding upstream — no spend incurred.
        budget_charge: None,
        // Guard blocks (budget/granular) are not v2 policy rules.
        matched_rule: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::edition::Edition;

    // The free tier caps injected integration calls; every paid plan is
    // unlimited (0 means no limit). A nonzero limit leaking onto a paid plan is
    // exactly the `scale`-throttled-as-free regression, so pin every known label.
    #[test]
    fn only_free_plan_on_cloud_is_call_limited() {
        assert_eq!(
            call_limit_for_plan(Edition::Cloud, "free"),
            FREE_PLAN_INJECTION_CALL_LIMIT
        );
        assert_eq!(call_limit_for_plan(Edition::Cloud, "pro"), 0);
        assert_eq!(call_limit_for_plan(Edition::Cloud, "team"), 0);
        assert_eq!(call_limit_for_plan(Edition::Cloud, "enterprise"), 0);
        assert_eq!(call_limit_for_plan(Edition::Cloud, "scale"), 0);
        // Unknown labels are treated as paid (unlimited), matching the
        // fail-safe pass-through in connect.rs.
        assert_eq!(call_limit_for_plan(Edition::Cloud, "ultra"), 0);
    }

    // Quotas are billing; the self-hosted edition has no plans and is never
    // call-limited — whatever label its rows happen to carry.
    #[test]
    fn onprem_is_never_call_limited() {
        assert_eq!(call_limit_for_plan(Edition::Onprem, "free"), 0);
        assert_eq!(call_limit_for_plan(Edition::Onprem, "pro"), 0);
    }
}
