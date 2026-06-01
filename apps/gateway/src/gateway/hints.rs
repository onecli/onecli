//! Response hints — synthetic responses for requests to known-deprecated hosts.
//!
//! When an agent calls a deprecated API endpoint and the upstream returns an
//! error matching a configured trigger status, the gateway replaces the response
//! with actionable guidance telling the agent which API to use instead.

use hyper::{Response, StatusCode};

use crate::apps::HostPattern;

use super::response::{self, ForwardBody};

// ── Hint definition ────────────────────────────────────────────────────

pub(super) struct ResponseHint {
    pattern: HostPattern,
    path_prefix: Option<&'static str>,
    trigger_statuses: &'static [u16],
    skip_with_injections: bool,
    pub(super) response_status: StatusCode,
    pub(super) error_code: &'static str,
    pub(super) provider: &'static str,
    pub(super) correct_host: &'static str,
    message: &'static str,
}

// ── Hint registry ──────────────────────────────────────────────────────

static RESPONSE_HINTS: &[ResponseHint] = &[ResponseHint {
    pattern: HostPattern::Suffix(".atlassian.net"),
    path_prefix: None,
    trigger_statuses: &[401, 403],
    skip_with_injections: true,
    response_status: StatusCode::MISDIRECTED_REQUEST,
    error_code: "deprecated_api",
    provider: "atlassian",
    correct_host: "api.atlassian.com",
    message: "The Atlassian tenant REST API at {hostname} is deprecated. \
              Use the Atlassian cloud REST API at api.atlassian.com instead.\n\n\
              For Jira: https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...\n\
              For Confluence: https://api.atlassian.com/ex/confluence/<cloudId>/rest/api/...\n\n\
              To discover your cloudId, call: \
              GET https://api.atlassian.com/oauth/token/accessible-resources\n\n\
              Your credentials are already configured for api.atlassian.com \
              through the OneCLI gateway — just update the URL and retry.",
}];

// ── Lookup ─────────────────────────────────────────────────────────────

#[must_use]
pub(super) fn find_hint(
    hostname: &str,
    path: &str,
    status: u16,
    injection_count: usize,
) -> Option<&'static ResponseHint> {
    RESPONSE_HINTS.iter().find(|hint| {
        hint.pattern.matches(hostname)
            && hint.path_prefix.is_none_or(|pfx| path.starts_with(pfx))
            && hint.trigger_statuses.contains(&status)
            && !(hint.skip_with_injections && injection_count > 0)
    })
}

// ── Response builder ───────────────────────────────────────────────────

#[must_use]
pub(super) fn hint_response<S>(
    hint: &ResponseHint,
    hostname: &str,
    path: &str,
) -> Response<ForwardBody<S>> {
    let message = hint.message.replace("{hostname}", hostname);
    response::with_no_retry(response::json_error(
        hint.response_status,
        serde_json::json!({
            "error": hint.error_code,
            "message": message,
            "deprecated_host": hostname,
            "correct_host": hint.correct_host,
            "provider": hint.provider,
            "requested_path": path,
        }),
    ))
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use http_body_util::Either;
    use hyper::body::Bytes;

    use super::*;

    type TestBody =
        ForwardBody<futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>>;

    #[test]
    fn atlassian_tenant_host_triggers_hint() {
        let hint = find_hint("mysite.atlassian.net", "/rest/api/3/issue", 401, 0);
        assert!(hint.is_some(), "*.atlassian.net with 401 should match");
        let h = hint.unwrap();
        assert_eq!(h.error_code, "deprecated_api");
        assert_eq!(h.correct_host, "api.atlassian.com");
        assert_eq!(h.provider, "atlassian");
    }

    #[test]
    fn atlassian_tenant_host_triggers_on_403() {
        assert!(find_hint("mysite.atlassian.net", "/rest/api/3/issue", 403, 0).is_some());
    }

    #[test]
    fn atlassian_tenant_host_skips_on_200() {
        assert!(find_hint("mysite.atlassian.net", "/rest/api/3/issue", 200, 0).is_none());
    }

    #[test]
    fn atlassian_tenant_host_skips_with_injections() {
        assert!(find_hint("mysite.atlassian.net", "/rest/api/3/issue", 401, 1).is_none());
    }

    #[test]
    fn atlassian_api_host_does_not_trigger_hint() {
        assert!(find_hint("api.atlassian.com", "/ex/jira/123/rest/api/3/issue", 401, 0).is_none());
    }

    #[test]
    fn bare_suffix_does_not_match() {
        assert!(find_hint(".atlassian.net", "/any", 401, 0).is_none());
        assert!(find_hint("atlassian.net", "/any", 401, 0).is_none());
    }

    #[test]
    fn unrelated_host_does_not_trigger_hint() {
        assert!(find_hint("api.github.com", "/repos", 401, 0).is_none());
        assert!(find_hint("example.com", "/", 403, 0).is_none());
    }

    #[test]
    fn hint_response_has_correct_status_and_headers() {
        let hint = find_hint("mysite.atlassian.net", "/rest/api/3/issue", 401, 0).unwrap();
        let resp: Response<TestBody> =
            hint_response(hint, "mysite.atlassian.net", "/rest/api/3/issue");
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[tokio::test]
    async fn hint_response_body_contains_fields() {
        use http_body_util::BodyExt;
        let hint = find_hint("mysite.atlassian.net", "/rest/api/3/issue", 401, 0).unwrap();
        let resp: Response<TestBody> =
            hint_response(hint, "mysite.atlassian.net", "/rest/api/3/issue");
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "deprecated_api");
        assert_eq!(json["deprecated_host"], "mysite.atlassian.net");
        assert_eq!(json["correct_host"], "api.atlassian.com");
        assert_eq!(json["provider"], "atlassian");
        assert_eq!(json["requested_path"], "/rest/api/3/issue");
        assert!(json["message"]
            .as_str()
            .unwrap()
            .contains("mysite.atlassian.net"));
        assert!(json["message"]
            .as_str()
            .unwrap()
            .contains("api.atlassian.com"));
    }
}
