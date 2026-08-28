//! Cloud-specific response builders.

use http_body_util::{Either, Full, StreamBody};
use hyper::body::Bytes;
use hyper::header::HeaderValue;
use hyper::{Response, StatusCode};

use crate::gateway::hooks::BodyStream;

type ForwardBody = Either<Full<Bytes>, StreamBody<BodyStream>>;

pub(crate) fn quota_exceeded(limit: u64, org_id: Option<&str>) -> Response<ForwardBody> {
    let base = crate::gateway::response::dashboard_url();
    let upgrade_url = match org_id {
        Some(oid) => format!("{base}/org/{oid}/billing"),
        None => format!("{base}/billing"),
    };
    let body = serde_json::json!({
        "error": "quota_exceeded",
        "message": format!(
            "Your plan allows {limit} integration calls per month. \
             Upgrade to Pro or Team for unlimited calls."
        ),
        "limit": limit,
        "upgrade_url": upgrade_url,
    });
    let json = body.to_string();
    let mut resp = Response::new(Either::Left(Full::new(Bytes::from(json))));
    *resp.status_mut() = StatusCode::TOO_MANY_REQUESTS;
    resp.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    resp.headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    resp
}

/// Returned when the effective credential for this host has reached its spend
/// budget for the current period, so the gateway pauses the key. A `403 Forbidden`
/// with `x-should-retry: false`, like the gateway's other policy blocks; clients
/// identify it via the `error` field — `"budget_exceeded"` for an
/// admin-configured org budget, `"trial_credit_exhausted"` for the platform's
/// free trial credit (the sandbox supervisor keys its friendly add-a-key
/// classification on the latter).
pub(crate) fn budget_exceeded(
    binding: &crate::ee::budget::BudgetBinding,
    workspace_id: Option<&str>,
) -> Response<ForwardBody> {
    let limit_usd = binding.limit_nanos as f64 / 1e9;
    let (window_label, period) = match binding.period {
        crate::ee::budget::BudgetPeriod::Monthly => ("this month", "monthly"),
        crate::ee::budget::BudgetPeriod::Total => ("in total", "total"),
    };
    // Deep-link to the workspace-scoped LLM keys page — a user's own key overrides
    // the paused one (workspace credentials take precedence).
    let base = crate::gateway::response::dashboard_url();
    let add_key_url = match workspace_id {
        Some(pid) => format!("{base}/w/{pid}/connections/llms"),
        None => base.to_string(),
    };
    // The platform trial credit gets its own wording AND its own wire code:
    // it is a free credit the user exhausted, not a budget an admin
    // configured — the fix is bringing their own key, not raising a limit —
    // and downstream classifiers (the sandbox supervisor) key on the error
    // CODE, so the two conditions must be distinguishable without prose
    // matching.
    let is_platform_credit = binding.secret_id == crate::ee::platform_llm::PLATFORM_SECRET_ID;
    let (error_code, message) = if is_platform_credit {
        (
            "trial_credit_exhausted",
            format!(
                "Your free OneCLI trial credit (${limit_usd:.2}) is used up. Add your own \
                 Anthropic API key in the OneCLI dashboard to keep going: {add_key_url}"
            ),
        )
    } else {
        (
            "budget_exceeded",
            format!(
                "This organization's spend budget for the {} key (${:.2} {}) has been \
                 reached, so the key is paused. The user can set their own key in the OneCLI \
                 dashboard to keep going: {}",
                binding.secret_type, limit_usd, window_label, add_key_url
            ),
        )
    };
    let body = serde_json::json!({
        "error": error_code,
        "message": message,
        "limit_usd": limit_usd,
        "period": period,
        "add_key_url": add_key_url,
    });
    let json = body.to_string();
    let mut resp = Response::new(Either::Left(Full::new(Bytes::from(json))));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    resp.headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    resp
}

/// 403 Forbidden — the request targets an app that is not available to this
/// workspace (the org's app-availability allowlist, step 7). Availability is an
/// org-level, admin-managed posture, so — unlike the workspace-scoped policy
/// blocks — there is no per-workspace dashboard deep link here. Body and header
/// order mirror the shared `json_error` + `with_no_retry` construction exactly
/// (the wire shape is pinned by the availability e2e).
pub(crate) fn app_unavailable(
    provider: &str,
    method: &str,
    path: &str,
    host: &str,
) -> Response<ForwardBody> {
    let hostname = host.split(':').next().unwrap_or(host);
    let body = serde_json::json!({
        "error": "app_unavailable",
        "message": format!(
            "The \"{provider}\" app is not available to this workspace. \
             {method} {hostname}{path} was blocked. An organization admin \
             can grant access on the App Availability page."
        ),
        "provider": provider,
        "method": method,
        "host": hostname,
        "path": path,
    });
    let json = body.to_string();
    let mut resp = Response::new(Either::Left(Full::new(Bytes::from(json))));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    resp.headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    resp
}

/// 403 returned when granular access blocks a request (e.g. a Dropbox folder
/// allowlist). `reason` is the specific cause; `allowed` is the scope the agent
/// may use, echoed back so the model can self-correct (retry inside scope)
/// instead of dead-ending.
pub(crate) fn forbidden_resource(reason: &str, allowed: &[String]) -> Response<ForwardBody> {
    let allowed_list = allowed.join(", ");
    let body = serde_json::json!({
        "error": "resource_access_denied",
        "message": format!(
            "This agent is restricted to: {allowed_list}. The requested resource is \
             outside its allowed scope — use a location inside one of those."
        ),
        "allowed": allowed,
        "detail": reason,
    });
    let json = body.to_string();
    let mut resp = Response::new(Either::Left(Full::new(Bytes::from(json))));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    resp.headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    resp
}

/// 403 for a resource scope that allows NOTHING — the organization's boundary
/// and the workspace's selection have no overlap. Distinct wording from
/// `forbidden_resource`, whose "restricted to: {list}" reads as an empty
/// sentence here, and actionable: no retry can succeed, an admin must widen the
/// scope.
pub(crate) fn forbidden_empty_scope() -> Response<ForwardBody> {
    let body = serde_json::json!({
        "error": "resource_access_denied",
        "message": "This agent's resource scope is empty: the organization's allowed \
                    resources and this workspace's selection do not overlap, so the \
                    credential can reach nothing. Ask an administrator to widen the scope.",
        "allowed": [],
        "detail": "empty resource scope",
    });
    let json = body.to_string();
    let mut resp = Response::new(Either::Left(Full::new(Bytes::from(json))));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    resp.headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ee::budget::{BudgetBinding, BudgetPeriod, BudgetSubject};

    fn budget_binding() -> BudgetBinding {
        BudgetBinding {
            secret_id: "sec_1".into(),
            subject: BudgetSubject::Org("org_1".into()),
            secret_type: "anthropic".into(),
            limit_nanos: 50 * 1_000_000_000,
            period: BudgetPeriod::Monthly,
        }
    }

    #[test]
    fn budget_exceeded_is_403() {
        // Budget blocks return a policy 403 (not 402), uniform with the gateway's
        // other blocks; the JSON `error` field is what disambiguates them.
        assert_eq!(
            budget_exceeded(&budget_binding(), Some("proj_1")).status(),
            StatusCode::FORBIDDEN
        );
    }

    // The two arms carry DISTINCT wire codes: downstream classifiers (the
    // sandbox supervisor) key the friendly add-a-key treatment on
    // `trial_credit_exhausted`, so the org-budget arm leaking onto that code
    // (or vice versa) would mislabel one condition as the other.
    #[test]
    fn budget_exceeded_wire_codes_distinguish_org_budget_from_trial_credit() {
        use futures_util::FutureExt;
        use http_body_util::BodyExt;
        let body_of = |resp: Response<ForwardBody>| {
            let Either::Left(full) = resp.into_body() else {
                panic!("expected a buffered body");
            };
            let bytes = full
                .collect()
                .now_or_never()
                .expect("body ready")
                .expect("body ok")
                .to_bytes();
            serde_json::from_slice::<serde_json::Value>(&bytes).expect("json")
        };

        let org = body_of(budget_exceeded(&budget_binding(), Some("proj_1")));
        assert_eq!(org["error"], "budget_exceeded");

        let platform = body_of(budget_exceeded(
            &BudgetBinding {
                secret_id: crate::ee::platform_llm::PLATFORM_SECRET_ID.into(),
                subject: BudgetSubject::User("user_1".into()),
                secret_type: "anthropic".into(),
                limit_nanos: 5 * 1_000_000_000,
                period: BudgetPeriod::Total,
            },
            Some("proj_1"),
        ));
        assert_eq!(platform["error"], "trial_credit_exhausted");
        assert!(platform["message"]
            .as_str()
            .expect("message")
            .contains("trial credit"));
    }

    #[test]
    fn forbidden_resource_is_403() {
        assert_eq!(
            forbidden_resource("denied", &["/allowed".to_string()]).status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn forbidden_empty_scope_is_403_with_its_own_wording() {
        use futures_util::FutureExt;
        let resp = forbidden_empty_scope();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(resp.headers()["x-should-retry"], "false");
        // The generic body would render "restricted to: ." here — the empty
        // scope has its own message telling the agent no retry can succeed.
        let Either::Left(full) = resp.into_body() else {
            panic!("expected a buffered body");
        };
        let bytes = full.clone();
        let body: serde_json::Value = serde_json::from_slice(
            &http_body_util::BodyExt::collect(bytes)
                .now_or_never()
                .expect("body ready")
                .expect("body ok")
                .to_bytes(),
        )
        .expect("json body");
        assert_eq!(body["error"], "resource_access_denied");
        assert_eq!(body["allowed"], serde_json::json!([]));
        assert!(body["message"]
            .as_str()
            .expect("message")
            .contains("do not overlap"));
    }

    #[test]
    fn quota_exceeded_is_429_not_403() {
        // The call quota is a rate limit, deliberately distinct from the policy 403s.
        assert_eq!(
            quota_exceeded(500, Some("org_1")).status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }
}
