//! Policy rule evaluation for the gateway.
//!
//! Policy rules control access to upstream endpoints. When a request matches
//! a policy rule with action "block", the gateway returns 403 Forbidden
//! instead of forwarding the request.

use crate::inject::path_matches;

// ── Data types ──────────────────────────────────────────────────────────

/// A resolved policy rule ready for evaluation in `forward_request`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PolicyRule {
    pub path_pattern: String,
    pub method: Option<String>,
}

// ── Evaluation ──────────────────────────────────────────────────────────

/// Check if a request should be blocked by any policy rule.
/// Returns `true` if the request matches a block rule.
pub(crate) fn is_blocked(request_method: &str, request_path: &str, rules: &[PolicyRule]) -> bool {
    rules.iter().any(|rule| {
        path_matches(request_path, &rule.path_pattern)
            && rule
                .method
                .as_ref()
                .is_none_or(|m| m.eq_ignore_ascii_case(request_method))
    })
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(path: &str, method: Option<&str>) -> PolicyRule {
        PolicyRule {
            path_pattern: path.to_string(),
            method: method.map(|m| m.to_string()),
        }
    }

    #[test]
    fn blocks_exact_path_and_method() {
        let rules = vec![rule("/gmail/v1/users/me/messages/send", Some("POST"))];
        assert!(is_blocked(
            "POST",
            "/gmail/v1/users/me/messages/send",
            &rules
        ));
    }

    #[test]
    fn allows_different_method() {
        let rules = vec![rule("/gmail/v1/users/me/messages/send", Some("POST"))];
        assert!(!is_blocked(
            "GET",
            "/gmail/v1/users/me/messages/send",
            &rules
        ));
    }

    #[test]
    fn allows_different_path() {
        let rules = vec![rule("/gmail/v1/users/me/messages/send", Some("POST"))];
        assert!(!is_blocked("POST", "/gmail/v1/users/me/messages", &rules));
    }

    #[test]
    fn blocks_all_methods_when_none() {
        let rules = vec![rule("/admin/*", None)];
        assert!(is_blocked("GET", "/admin/users", &rules));
        assert!(is_blocked("POST", "/admin/users", &rules));
        assert!(is_blocked("DELETE", "/admin/settings", &rules));
    }

    #[test]
    fn blocks_wildcard_path() {
        let rules = vec![rule("/gmail/*", Some("POST"))];
        assert!(is_blocked(
            "POST",
            "/gmail/v1/users/me/messages/send",
            &rules
        ));
        assert!(!is_blocked("POST", "/calendar/v1/events", &rules));
    }

    #[test]
    fn blocks_all_paths() {
        let rules = vec![rule("*", Some("DELETE"))];
        assert!(is_blocked("DELETE", "/anything", &rules));
        assert!(!is_blocked("GET", "/anything", &rules));
    }

    #[test]
    fn method_matching_is_case_insensitive() {
        let rules = vec![rule("*", Some("POST"))];
        assert!(is_blocked("post", "/path", &rules));
        assert!(is_blocked("Post", "/path", &rules));
    }

    #[test]
    fn no_rules_allows_everything() {
        assert!(!is_blocked("POST", "/anything", &[]));
    }

    #[test]
    fn blocks_with_default_wildcard_path() {
        // connect.rs converts pathPattern: None to "*"
        let rules = vec![rule("*", Some("POST"))];
        assert!(is_blocked("POST", "/any/path/here", &rules));
        assert!(is_blocked("POST", "/", &rules));
    }

    #[test]
    fn multiple_rules_any_match_blocks() {
        let rules = vec![
            rule("/safe/*", Some("GET")),
            rule("/danger/*", Some("POST")),
        ];
        assert!(!is_blocked("POST", "/safe/path", &rules));
        assert!(is_blocked("POST", "/danger/path", &rules));
    }
}
