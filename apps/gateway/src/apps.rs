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

/// Configuration for refreshing expired OAuth tokens.
pub(crate) struct RefreshConfig {
    /// Token endpoint URL (e.g., `https://oauth2.googleapis.com/token`).
    pub token_url: &'static str,
    /// Env var for the OAuth client ID.
    pub client_id_env: &'static str,
    /// Env var for the OAuth client secret.
    pub client_secret_env: &'static str,
}

/// An app provider definition with its host rules.
struct AppProvider {
    provider: &'static str,
    host_rules: &'static [HostRule],
    refresh: Option<RefreshConfig>,
}

// ── Provider registry ──────────────────────────────────────────────────

static APP_PROVIDERS: &[AppProvider] = &[
    AppProvider {
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
        refresh: None, // GitHub tokens don't expire
    },
    AppProvider {
        provider: "google",
        host_rules: &[
            // Gmail REST API
            HostRule {
                host: "gmail.googleapis.com",
                strategy: AuthStrategy::Bearer,
            },
            // Google APIs (userinfo, etc.)
            HostRule {
                host: "www.googleapis.com",
                strategy: AuthStrategy::Bearer,
            },
        ],
        refresh: Some(RefreshConfig {
            token_url: "https://oauth2.googleapis.com/token",
            client_id_env: "GOOGLE_CLIENT_ID",
            client_secret_env: "GOOGLE_CLIENT_SECRET",
        }),
    },
    AppProvider {
        provider: "resend",
        host_rules: &[HostRule {
            host: "api.resend.com",
            strategy: AuthStrategy::Bearer,
        }],
        refresh: None,
    },
];

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

/// Get the refresh config for a provider, if it supports token refresh.
pub(crate) fn refresh_config(provider: &str) -> Option<&'static RefreshConfig> {
    APP_PROVIDERS
        .iter()
        .find(|p| p.provider == provider)
        .and_then(|p| p.refresh.as_ref())
}

/// Refresh an expired access token using the provider's token endpoint.
/// Returns the new access token and updated expires_at timestamp.
///
/// Client credentials are resolved in order:
/// 1. Explicit `client_id`/`client_secret` (from BYOC AppConfig)
/// 2. Env vars from `RefreshConfig` (platform defaults)
pub(crate) async fn refresh_access_token(
    config: &RefreshConfig,
    refresh_token: &str,
    byoc_client_id: Option<&str>,
    byoc_client_secret: Option<&str>,
) -> anyhow::Result<(String, i64)> {
    let client_id = match byoc_client_id {
        Some(id) => id.to_string(),
        None => std::env::var(config.client_id_env)
            .map_err(|_| anyhow::anyhow!("{} env var not set", config.client_id_env))?,
    };
    let client_secret = match byoc_client_secret {
        Some(secret) => secret.to_string(),
        None => std::env::var(config.client_secret_env)
            .map_err(|_| anyhow::anyhow!("{} env var not set", config.client_secret_env))?,
    };

    let resp = reqwest::Client::new()
        .post(config.token_url)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("refresh request failed: {e}"))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("refresh response parse failed: {e}"))?;

    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let error = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            anyhow::anyhow!("token refresh failed: {error}")
        })?
        .to_string();

    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs() as i64;

    Ok((access_token, now + expires_in))
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

    // ── Google ────────────────────────────────────────────────────────

    #[test]
    fn provider_for_google_hosts() {
        assert_eq!(provider_for_host("gmail.googleapis.com"), Some("google"));
        assert_eq!(provider_for_host("www.googleapis.com"), Some("google"));
    }

    #[test]
    fn google_gmail_api_uses_bearer() {
        let injections = build_app_injections("google", "gmail.googleapis.com", "ya29.test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ya29.test".to_string(),
            }
        );
    }

    #[test]
    fn google_www_api_uses_bearer() {
        let injections = build_app_injections("google", "www.googleapis.com", "ya29.test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ya29.test".to_string(),
            }
        );
    }

    // ── Resend ────────────────────────────────────────────────────────

    #[test]
    fn provider_for_resend_host() {
        assert_eq!(provider_for_host("api.resend.com"), Some("resend"));
    }

    #[test]
    fn resend_api_uses_bearer() {
        let injections = build_app_injections("resend", "api.resend.com", "re_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer re_test123".to_string(),
            }
        );
    }

    // ── Edge cases ───────────────────────────────────────────────────

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
