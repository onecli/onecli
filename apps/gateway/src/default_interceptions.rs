//! Default interceptions: gateway-authored responses for a small set of
//! predefined endpoints, served WITHOUT forwarding upstream and independent of
//! whether any secret or app connection is configured.
//!
//! Unlike secret/app injection (which rewrites a request that is then forwarded),
//! a default interception short-circuits the request entirely. These are
//! protocol workarounds that ship with the gateway, so the registry is static.
//!
//! First case: Codex (the OpenAI agent) runs against a stub `~/.codex/auth.json`
//! whose tokens are the `"onecli-managed"` placeholder. When the stub's
//! `last_refresh` ages past Codex's ~8-day window, Codex proactively
//! `POST`s `auth.openai.com/oauth/token` to refresh — which can never succeed
//! against the placeholder `refresh_token` and produces a retry storm. We answer
//! that refresh with a synthetic `200`; Codex stamps `last_refresh = now` itself
//! and goes quiet. The real token is still injected at the actual API call.

use hyper::{Method, StatusCode};

/// Sentinel value used for all placeholder credentials written into agent stubs.
/// Only requests carrying this value are intercepted; real credentials pass through.
const ONECLI_MANAGED: &str = "onecli-managed";

/// A gateway-authored response for a predefined endpoint, returned to the client
/// without forwarding upstream.
#[derive(Debug)]
pub(crate) struct SyntheticResponse {
    pub status: StatusCode,
    pub body: serde_json::Value,
}

/// One entry in the default-interception registry.
#[derive(Debug)]
pub(crate) struct DefaultInterception {
    /// Exact hostname (no port), e.g. `"auth.openai.com"`.
    host: &'static str,
    /// Path pattern matched via [`crate::inject::path_matches`] (glob-aware).
    path: &'static str,
    /// HTTP method this interception applies to.
    method: Method,
    /// Inspects the request body and decides whether to intercept. Returning
    /// `None` lets the request forward normally.
    handler: fn(&[u8]) -> Option<SyntheticResponse>,
}

impl DefaultInterception {
    /// Run this interception's handler against the (buffered) request body.
    pub(crate) fn handle(&self, body: &[u8]) -> Option<SyntheticResponse> {
        (self.handler)(body)
    }
}

/// The static registry of predefined interceptions.
static REGISTRY: &[DefaultInterception] = &[DefaultInterception {
    host: "auth.openai.com",
    path: "/oauth/token",
    method: Method::POST,
    handler: codex_oauth_refresh,
}];

/// Cheap pre-match on host + path + method, run for every forwarded request
/// before any body is read. Returns the matching interception, if any.
pub(crate) fn match_target(
    host: &str,
    path: &str,
    method: &Method,
) -> Option<&'static DefaultInterception> {
    REGISTRY.iter().find(|i| {
        i.host == host && *method == i.method && crate::inject::path_matches(path, i.path)
    })
}

/// Seconds advertised in the synthetic refresh response's `expires_in`. Codex
/// does not read this field (its refresh timing comes from the access-token JWT
/// `exp` and the `last_refresh` age), so the value is cosmetic; it is kept large
/// (~30 days) so any other client that did read it would not refresh frequently.
const SYNTHETIC_EXPIRES_IN_SECS: u64 = 30 * 24 * 60 * 60;

/// Handler for Codex refreshing its `onecli-managed` placeholder OAuth token.
///
/// Codex's refresh response type has all-optional fields and ignores any others,
/// and on any `2xx` Codex stamps `last_refresh = now` to disk itself — so echoing
/// the placeholders is enough to make it stop retrying. `id_token` is intentionally
/// omitted: Codex keeps its existing valid one, and a placeholder JWT here would
/// fail Codex's claim parsing and break the refresh. `token_type`/`expires_in` are
/// not read by Codex and exist only to mirror a standard OAuth token response.
///
/// Real Codex logins carry a real `refresh_token`, fail the sentinel check, and
/// are forwarded to the real `auth.openai.com` untouched.
fn codex_oauth_refresh(body: &[u8]) -> Option<SyntheticResponse> {
    let json: serde_json::Value = serde_json::from_slice(body).ok()?;
    if json.get("grant_type").and_then(|v| v.as_str()) != Some("refresh_token") {
        return None;
    }
    if json.get("refresh_token").and_then(|v| v.as_str()) != Some(ONECLI_MANAGED) {
        return None;
    }
    Some(SyntheticResponse {
        status: StatusCode::OK,
        body: serde_json::json!({
            "access_token": ONECLI_MANAGED,
            "refresh_token": ONECLI_MANAGED,
            "token_type": "Bearer",
            "expires_in": SYNTHETIC_EXPIRES_IN_SECS,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── match_target ───────────────────────────────────────────────────

    #[test]
    fn match_target_hits_codex_refresh() {
        let target = match_target("auth.openai.com", "/oauth/token", &Method::POST);
        assert!(target.is_some());
    }

    #[test]
    fn match_target_respects_query_string() {
        // path_matches strips the query string before comparison.
        let target = match_target("auth.openai.com", "/oauth/token?foo=bar", &Method::POST);
        assert!(target.is_some());
    }

    #[test]
    fn match_target_misses_other_host_path_method() {
        assert!(match_target("api.openai.com", "/oauth/token", &Method::POST).is_none());
        assert!(match_target("auth.openai.com", "/oauth/authorize", &Method::POST).is_none());
        assert!(match_target("auth.openai.com", "/oauth/token", &Method::GET).is_none());
    }

    // ── codex_oauth_refresh handler ────────────────────────────────────

    #[test]
    fn codex_oauth_refresh_intercepts_onecli_managed() {
        let body = br#"{"client_id":"app_x","grant_type":"refresh_token","refresh_token":"onecli-managed"}"#;
        let resp = codex_oauth_refresh(body).expect("should intercept");
        assert_eq!(resp.status, StatusCode::OK);
        assert_eq!(resp.body["access_token"], "onecli-managed");
        assert_eq!(resp.body["refresh_token"], "onecli-managed");
        // id_token is intentionally not returned (Codex keeps its existing one).
        assert!(resp.body.get("id_token").is_none());
    }

    #[test]
    fn codex_oauth_refresh_passes_through_real_token() {
        let body = br#"{"grant_type":"refresh_token","refresh_token":"rt_real_user_token"}"#;
        assert!(codex_oauth_refresh(body).is_none());
    }

    #[test]
    fn codex_oauth_refresh_passes_through_non_refresh_grant() {
        let body = br#"{"grant_type":"authorization_code","refresh_token":"onecli-managed"}"#;
        assert!(codex_oauth_refresh(body).is_none());
    }

    #[test]
    fn codex_oauth_refresh_ignores_malformed_or_empty_body() {
        assert!(codex_oauth_refresh(b"not json").is_none());
        assert!(codex_oauth_refresh(b"").is_none());
        assert!(codex_oauth_refresh(b"{}").is_none());
    }
}
