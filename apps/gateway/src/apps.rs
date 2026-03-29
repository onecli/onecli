//! App connection provider registry.
//!
//! Maps hostnames to OAuth providers and defines per-host injection rules.
//! Each provider can have multiple host rules with different auth patterns
//! (e.g., GitHub REST API uses Bearer auth, but git HTTPS uses Basic auth).

use base64::Engine;

use crate::inject::Injection;

// ── Host rule ──────────────────────────────────────────────────────────

/// Auth injection strategy for a specific host.
#[derive(Debug, Clone, Copy)]
enum AuthStrategy {
    /// `Authorization: Bearer {token}`
    Bearer,
    /// `Authorization: Basic base64("x-access-token:{token}")`
    BasicXAccessToken,
}

/// A host pattern and its injection strategy for an app provider.
struct HostRule {
    host: &'static str,
    strategy: AuthStrategy,
}

/// An app provider definition with its host rules.
struct AppProvider {
    provider: &'static str,
    host_rules: &'static [HostRule],
}

// ── Provider registry ──────────────────────────────────────────────────

static APP_PROVIDERS: &[AppProvider] = &[AppProvider {
    provider: "github",
    host_rules: &[
        // REST + GraphQL API
        HostRule {
            host: "api.github.com",
            strategy: AuthStrategy::Bearer,
        },
        // Git HTTPS operations (push, pull, clone, fetch)
        HostRule {
            host: "github.com",
            strategy: AuthStrategy::BasicXAccessToken,
        },
        // Raw content for private repos
        HostRule {
            host: "raw.githubusercontent.com",
            strategy: AuthStrategy::Bearer,
        },
    ],
}];

// ── Public API ─────────────────────────────────────────────────────────

/// Given a hostname, return the provider name if it matches any registered app.
pub(crate) fn provider_for_host(hostname: &str) -> Option<&'static str> {
    for provider in APP_PROVIDERS {
        for rule in provider.host_rules {
            if rule.host == hostname {
                return Some(provider.provider);
            }
        }
    }
    None
}

/// Build injection rules for an app connection's access token on a given host.
/// Returns an empty vec if the hostname doesn't match the provider.
pub(crate) fn build_app_injections(provider: &str, hostname: &str, token: &str) -> Vec<Injection> {
    let app = APP_PROVIDERS.iter().find(|p| p.provider == provider);
    let Some(app) = app else { return vec![] };

    let rule = app.host_rules.iter().find(|r| r.host == hostname);
    let Some(rule) = rule else { return vec![] };

    match rule.strategy {
        AuthStrategy::Bearer => vec![Injection::SetHeader {
            name: "authorization".to_string(),
            value: format!("Bearer {token}"),
        }],
        AuthStrategy::BasicXAccessToken => {
            let b64 = base64::engine::general_purpose::STANDARD;
            let encoded = b64.encode(format!("x-access-token:{token}"));
            vec![Injection::SetHeader {
                name: "authorization".to_string(),
                value: format!("Basic {encoded}"),
            }]
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_for_known_hosts() {
        assert_eq!(provider_for_host("api.github.com"), Some("github"));
        assert_eq!(provider_for_host("github.com"), Some("github"));
        assert_eq!(
            provider_for_host("raw.githubusercontent.com"),
            Some("github")
        );
    }

    #[test]
    fn provider_for_unknown_host() {
        assert_eq!(provider_for_host("api.openai.com"), None);
        assert_eq!(provider_for_host("example.com"), None);
    }

    #[test]
    fn github_api_uses_bearer() {
        let injections = build_app_injections("github", "api.github.com", "ghp_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ghp_test123".to_string(),
            }
        );
    }

    #[test]
    fn github_git_uses_basic() {
        let injections = build_app_injections("github", "github.com", "ghp_test123");
        assert_eq!(injections.len(), 1);
        match &injections[0] {
            Injection::SetHeader { name, value } => {
                assert_eq!(name, "authorization");
                assert!(value.starts_with("Basic "));
                // Decode and verify
                let b64 = base64::engine::general_purpose::STANDARD;
                let encoded = &value["Basic ".len()..];
                let decoded = String::from_utf8(b64.decode(encoded).unwrap()).unwrap();
                assert_eq!(decoded, "x-access-token:ghp_test123");
            }
            _ => panic!("expected SetHeader"),
        }
    }

    #[test]
    fn github_raw_uses_bearer() {
        let injections = build_app_injections("github", "raw.githubusercontent.com", "ghp_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ghp_test123".to_string(),
            }
        );
    }

    #[test]
    fn unknown_provider_returns_empty() {
        let injections = build_app_injections("unknown", "api.github.com", "token");
        assert!(injections.is_empty());
    }

    #[test]
    fn unknown_host_for_provider_returns_empty() {
        let injections = build_app_injections("github", "unknown.com", "token");
        assert!(injections.is_empty());
    }
}
