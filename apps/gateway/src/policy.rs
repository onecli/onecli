//! Policy rule evaluation for the gateway.
//!
//! Policy rules control access to upstream endpoints:
//! - **Block**: returns 403 Forbidden
//! - **Rate limit**: allows up to N requests per time window, then 429

use crate::cache::CacheStore;
use crate::inject::path_matches;

// ── Data types ──────────────────────────────────────────────────────────

/// What action to take when a request matches a policy rule.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum PolicyAction {
    Block,
    RateLimit {
        rule_id: String,
        max_requests: u64,
        window_secs: u64,
    },
    ManualApproval {
        rule_id: String,
    },
}

/// A resolved policy rule ready for evaluation.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PolicyRule {
    pub path_pattern: String,
    pub method: Option<String>,
    pub action: PolicyAction,
}

/// Result of policy evaluation for a single request.
#[derive(Debug)]
pub(crate) enum PolicyDecision {
    /// Request is allowed.
    Allow,
    /// Request is blocked by a block rule.
    Blocked,
    /// Request exceeds a rate limit.
    RateLimited {
        limit: u64,
        window: &'static str,
        retry_after_secs: u64,
    },
    /// Request requires manual approval before proceeding.
    ManualApproval { rule_id: String },
}

// ── Evaluation ──────────────────────────────────────────────────────────

/// Evaluate all policy rules against a request.
///
/// Priority: Block > ManualApproval > RateLimit > Allow.
/// Each pass checks only one action type to enforce strict ordering.
pub(crate) async fn evaluate(
    request_method: &str,
    request_path: &str,
    rules: &[PolicyRule],
    agent_token: &str,
    cache: &dyn CacheStore,
) -> PolicyDecision {
    // Pass 1: block rules (absolute deny, highest priority)
    for rule in rules {
        if !matches_request(rule, request_method, request_path) {
            continue;
        }
        if matches!(rule.action, PolicyAction::Block) {
            return PolicyDecision::Blocked;
        }
    }

    // Pass 2: manual approval rules
    for rule in rules {
        if !matches_request(rule, request_method, request_path) {
            continue;
        }
        if let PolicyAction::ManualApproval { rule_id } = &rule.action {
            return PolicyDecision::ManualApproval {
                rule_id: rule_id.clone(),
            };
        }
    }

    // Pass 3: rate limit rules
    for rule in rules {
        if !matches_request(rule, request_method, request_path) {
            continue;
        }
        if let PolicyAction::RateLimit {
            rule_id,
            max_requests,
            window_secs,
        } = &rule.action
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let window_id = now / (*window_secs).max(1);
            let key = format!("rate:{rule_id}:{agent_token}:{window_id}");

            if let Some(count) = cache.incr(&key, *window_secs).await {
                if count > *max_requests {
                    let window_end = (window_id + 1) * window_secs;
                    let retry_after = window_end.saturating_sub(now);
                    let window_name = match *window_secs {
                        60 => "minute",
                        3600 => "hour",
                        86400 => "day",
                        _ => "window",
                    };
                    return PolicyDecision::RateLimited {
                        limit: *max_requests,
                        window: window_name,
                        retry_after_secs: retry_after,
                    };
                }
            }
            // If incr failed (cache unavailable), allow through — graceful fallback
        }
    }

    PolicyDecision::Allow
}

/// Check if a rule matches the request method and path.
fn matches_request(rule: &PolicyRule, method: &str, path: &str) -> bool {
    path_matches(path, &rule.path_pattern)
        && rule
            .method
            .as_ref()
            .is_none_or(|m| m.eq_ignore_ascii_case(method))
}

/// Check if a request should be blocked by any policy rule (sync, block-only).
/// Used in tests; production code uses `evaluate()`.
#[allow(dead_code)]
pub(crate) fn is_blocked(request_method: &str, request_path: &str, rules: &[PolicyRule]) -> bool {
    rules.iter().any(|rule| {
        matches!(rule.action, PolicyAction::Block)
            && path_matches(request_path, &rule.path_pattern)
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

    fn block_rule(path: &str, method: Option<&str>) -> PolicyRule {
        PolicyRule {
            path_pattern: path.to_string(),
            method: method.map(|m| m.to_string()),
            action: PolicyAction::Block,
        }
    }

    fn rate_rule(path: &str, method: Option<&str>, max: u64, window: u64) -> PolicyRule {
        PolicyRule {
            path_pattern: path.to_string(),
            method: method.map(|m| m.to_string()),
            action: PolicyAction::RateLimit {
                rule_id: "test-rule".to_string(),
                max_requests: max,
                window_secs: window,
            },
        }
    }

    // ── Block tests (existing behavior) ──────────────────────────────────

    #[test]
    fn blocks_exact_path_and_method() {
        let rules = vec![block_rule("/gmail/v1/users/me/messages/send", Some("POST"))];
        assert!(is_blocked(
            "POST",
            "/gmail/v1/users/me/messages/send",
            &rules
        ));
    }

    #[test]
    fn allows_different_method() {
        let rules = vec![block_rule("/gmail/v1/users/me/messages/send", Some("POST"))];
        assert!(!is_blocked(
            "GET",
            "/gmail/v1/users/me/messages/send",
            &rules
        ));
    }

    #[test]
    fn allows_different_path() {
        let rules = vec![block_rule("/gmail/v1/users/me/messages/send", Some("POST"))];
        assert!(!is_blocked("POST", "/gmail/v1/users/me/messages", &rules));
    }

    #[test]
    fn blocks_all_methods_when_none() {
        let rules = vec![block_rule("/admin/*", None)];
        assert!(is_blocked("GET", "/admin/users", &rules));
        assert!(is_blocked("POST", "/admin/users", &rules));
        assert!(is_blocked("DELETE", "/admin/settings", &rules));
    }

    #[test]
    fn blocks_wildcard_path() {
        let rules = vec![block_rule("/gmail/*", Some("POST"))];
        assert!(is_blocked(
            "POST",
            "/gmail/v1/users/me/messages/send",
            &rules
        ));
        assert!(!is_blocked("POST", "/calendar/v1/events", &rules));
    }

    #[test]
    fn blocks_all_paths() {
        let rules = vec![block_rule("*", Some("DELETE"))];
        assert!(is_blocked("DELETE", "/anything", &rules));
        assert!(!is_blocked("GET", "/anything", &rules));
    }

    #[test]
    fn method_matching_is_case_insensitive() {
        let rules = vec![block_rule("*", Some("POST"))];
        assert!(is_blocked("post", "/path", &rules));
        assert!(is_blocked("Post", "/path", &rules));
    }

    #[test]
    fn no_rules_allows_everything() {
        assert!(!is_blocked("POST", "/anything", &[]));
    }

    #[test]
    fn blocks_with_default_wildcard_path() {
        let rules = vec![block_rule("*", Some("POST"))];
        assert!(is_blocked("POST", "/any/path/here", &rules));
        assert!(is_blocked("POST", "/", &rules));
    }

    #[test]
    fn multiple_rules_any_match_blocks() {
        let rules = vec![
            block_rule("/safe/*", Some("GET")),
            block_rule("/danger/*", Some("POST")),
        ];
        assert!(!is_blocked("POST", "/safe/path", &rules));
        assert!(is_blocked("POST", "/danger/path", &rules));
    }

    // ── Rate limit tests ─────────────────────────────────────────────────

    #[tokio::test]
    async fn rate_limit_allows_under_limit() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![rate_rule("*", Some("POST"), 5, 3600)];
        let decision = evaluate("POST", "/path", &rules, "agent1", &*store).await;
        assert!(matches!(decision, PolicyDecision::Allow));
    }

    #[tokio::test]
    async fn rate_limit_blocks_over_limit() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![rate_rule("*", Some("POST"), 2, 3600)];

        // First 2 requests allowed
        let d1 = evaluate("POST", "/path", &rules, "agent1", &*store).await;
        assert!(matches!(d1, PolicyDecision::Allow));
        let d2 = evaluate("POST", "/path", &rules, "agent1", &*store).await;
        assert!(matches!(d2, PolicyDecision::Allow));

        // Third request rate limited
        let d3 = evaluate("POST", "/path", &rules, "agent1", &*store).await;
        assert!(matches!(d3, PolicyDecision::RateLimited { .. }));
    }

    #[tokio::test]
    async fn rate_limit_per_agent_isolation() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![rate_rule("*", Some("POST"), 1, 3600)];

        // Agent1 hits limit
        evaluate("POST", "/path", &rules, "agent1", &*store).await;
        let d = evaluate("POST", "/path", &rules, "agent1", &*store).await;
        assert!(matches!(d, PolicyDecision::RateLimited { .. }));

        // Agent2 is unaffected
        let d = evaluate("POST", "/path", &rules, "agent2", &*store).await;
        assert!(matches!(d, PolicyDecision::Allow));
    }

    #[tokio::test]
    async fn block_takes_precedence_over_rate_limit() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![
            block_rule("/danger/*", Some("POST")),
            rate_rule("/danger/*", Some("POST"), 100, 3600),
        ];
        let d = evaluate("POST", "/danger/path", &rules, "agent1", &*store).await;
        assert!(matches!(d, PolicyDecision::Blocked));
    }

    #[tokio::test]
    async fn evaluate_allows_non_matching_rules() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![block_rule("/blocked/*", Some("POST"))];
        let d = evaluate("GET", "/safe/path", &rules, "agent1", &*store).await;
        assert!(matches!(d, PolicyDecision::Allow));
    }

    // ── Manual approval tests ────────────────────────────────────────

    fn approval_rule(path: &str, method: Option<&str>) -> PolicyRule {
        PolicyRule {
            path_pattern: path.to_string(),
            method: method.map(|m| m.to_string()),
            action: PolicyAction::ManualApproval {
                rule_id: "test-approval".to_string(),
            },
        }
    }

    #[tokio::test]
    async fn manual_approval_matches_path_and_method() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![approval_rule("/send/*", Some("POST"))];
        let d = evaluate("POST", "/send/email", &rules, "agent1", &*store).await;
        assert!(matches!(d, PolicyDecision::ManualApproval { .. }));
    }

    #[tokio::test]
    async fn manual_approval_no_match_different_method() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![approval_rule("/send/*", Some("POST"))];
        let d = evaluate("GET", "/send/email", &rules, "agent1", &*store).await;
        assert!(matches!(d, PolicyDecision::Allow));
    }

    #[tokio::test]
    async fn block_takes_precedence_over_manual_approval() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![
            approval_rule("/danger/*", Some("POST")),
            block_rule("/danger/*", Some("POST")),
        ];
        let d = evaluate("POST", "/danger/path", &rules, "agent1", &*store).await;
        assert!(matches!(d, PolicyDecision::Blocked));
    }

    #[tokio::test]
    async fn manual_approval_takes_precedence_over_rate_limit() {
        let store = crate::cache::create_store().await.unwrap();
        let rules = vec![
            rate_rule("/api/*", Some("POST"), 100, 3600),
            approval_rule("/api/*", Some("POST")),
        ];
        let d = evaluate("POST", "/api/send", &rules, "agent1", &*store).await;
        assert!(matches!(d, PolicyDecision::ManualApproval { .. }));
    }
}
