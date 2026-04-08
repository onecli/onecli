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
    /// Optional path prefix to scope this rule (e.g., `"/calendar/"` for Google Calendar).
    /// When set, only requests whose path starts with this prefix match this provider.
    /// When `None`, all paths on the host match (used for providers with dedicated subdomains).
    path_prefix: Option<&'static str>,
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
    display_name: &'static str,
    host_rules: &'static [HostRule],
    refresh: Option<&'static RefreshConfig>,
}

/// Shared refresh config for all Google OAuth APIs.
static GOOGLE_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://oauth2.googleapis.com/token",
    client_id_env: "GOOGLE_CLIENT_ID",
    client_secret_env: "GOOGLE_CLIENT_SECRET",
};

// ── Provider registry ──────────────────────────────────────────────────

static APP_PROVIDERS: &[AppProvider] = &[
    AppProvider {
        provider: "github",
        display_name: "GitHub",
        host_rules: &[
            HostRule {
                host: "api.github.com",
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
            },
            HostRule {
                host: "github.com",
                path_prefix: None,
                strategy: AuthStrategy::BasicXAccessToken,
            },
            HostRule {
                host: "raw.githubusercontent.com",
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
            },
        ],
        refresh: None,
    },
    AppProvider {
        provider: "gmail",
        display_name: "Gmail",
        host_rules: &[
            HostRule {
                host: "gmail.googleapis.com",
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
            },
            // Legacy endpoint — some clients still use www.googleapis.com/gmail/
            HostRule {
                host: "www.googleapis.com",
                path_prefix: Some("/gmail/"),
                strategy: AuthStrategy::Bearer,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-calendar",
        display_name: "Google Calendar",
        host_rules: &[HostRule {
            host: "www.googleapis.com",
            path_prefix: Some("/calendar/"),
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-drive",
        display_name: "Google Drive",
        host_rules: &[
            HostRule {
                host: "www.googleapis.com",
                path_prefix: Some("/drive/"),
                strategy: AuthStrategy::Bearer,
            },
            HostRule {
                host: "www.googleapis.com",
                path_prefix: Some("/upload/drive/"),
                strategy: AuthStrategy::Bearer,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-docs",
        display_name: "Google Docs",
        host_rules: &[HostRule {
            host: "docs.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-sheets",
        display_name: "Google Sheets",
        host_rules: &[HostRule {
            host: "sheets.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-slides",
        display_name: "Google Slides",
        host_rules: &[HostRule {
            host: "slides.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-tasks",
        display_name: "Google Tasks",
        host_rules: &[HostRule {
            host: "tasks.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-forms",
        display_name: "Google Forms",
        host_rules: &[HostRule {
            host: "forms.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-classroom",
        display_name: "Google Classroom",
        host_rules: &[HostRule {
            host: "classroom.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-admin",
        display_name: "Google Admin",
        host_rules: &[HostRule {
            host: "admin.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-analytics",
        display_name: "Google Analytics",
        host_rules: &[HostRule {
            host: "analyticsdata.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-search-console",
        display_name: "Google Search Console",
        host_rules: &[HostRule {
            host: "searchconsole.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-meet",
        display_name: "Google Meet",
        host_rules: &[HostRule {
            host: "meet.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "google-photos",
        display_name: "Google Photos",
        host_rules: &[HostRule {
            host: "photoslibrary.googleapis.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: Some(&GOOGLE_REFRESH),
    },
    AppProvider {
        provider: "resend",
        display_name: "Resend",
        host_rules: &[HostRule {
            host: "api.resend.com",
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
        }],
        refresh: None,
    },
];

// ── Public API ─────────────────────────────────────────────────────────

/// Given a hostname, return the first matching provider's (id, display_name).
/// Returns `None` if no provider matches.
pub(crate) fn provider_for_host(hostname: &str) -> Option<(&'static str, &'static str)> {
    APP_PROVIDERS.iter().find_map(|p| {
        p.host_rules
            .iter()
            .any(|r| r.host == hostname)
            .then_some((p.provider, p.display_name))
    })
}

/// Given a hostname and request path, return the best matching provider's (id, display_name).
///
/// For shared hosts (e.g., `www.googleapis.com`), uses the path prefix to disambiguate
/// between providers (Gmail on `/gmail/*`, Calendar on `/calendar/*`, etc.).
/// Falls back to the first host-only match if no path prefix matches.
pub(crate) fn provider_for_host_and_path(
    hostname: &str,
    path: &str,
) -> Option<(&'static str, &'static str)> {
    // First try: match both host and path prefix
    let path_match = APP_PROVIDERS.iter().find_map(|p| {
        p.host_rules
            .iter()
            .any(|r| r.host == hostname && r.path_prefix.is_some_and(|pfx| path.starts_with(pfx)))
            .then_some((p.provider, p.display_name))
    });
    if path_match.is_some() {
        return path_match;
    }

    // Fallback: host-only match (for providers with dedicated subdomains)
    provider_for_host(hostname)
}

/// Given a hostname, return all provider names that have at least one host rule
/// matching it. Multiple providers can share the same host with different path
/// prefixes (e.g., Gmail on `/gmail/` and Calendar on `/calendar/`).
pub(crate) fn providers_for_host(hostname: &str) -> Vec<&'static str> {
    let mut providers = Vec::new();
    for provider in APP_PROVIDERS {
        for rule in provider.host_rules {
            if rule.host == hostname {
                providers.push(provider.provider);
                break;
            }
        }
    }
    providers
}

/// Return the path pattern for the first matching host rule of a provider.
/// For providers with multiple rules on the same host, use `build_app_injection_rules` instead.
#[cfg(test)]
fn path_pattern_for(provider: &str, hostname: &str) -> String {
    APP_PROVIDERS
        .iter()
        .find(|p| p.provider == provider)
        .and_then(|app| app.host_rules.iter().find(|r| r.host == hostname))
        .and_then(|rule| rule.path_prefix)
        .map_or_else(|| "*".to_string(), |prefix| format!("{prefix}*"))
}

/// Build injections for the first matching host rule (single-rule providers).
/// For multi-rule providers (e.g., Google Drive), use `build_app_injection_rules`.
#[cfg(test)]
fn build_app_injections(provider: &str, hostname: &str, token: &str) -> Vec<Injection> {
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

/// Build injection rules for all matching host rules of a provider on a given host.
/// Returns one `(path_pattern, injections)` pair per matching rule. This handles
/// providers with multiple rules on the same host (e.g., Google Drive has `/drive/`
/// and `/upload/drive/` on `www.googleapis.com`).
pub(crate) fn build_app_injection_rules(
    provider: &str,
    hostname: &str,
    token: &str,
) -> Vec<(String, Vec<Injection>)> {
    let Some(app) = APP_PROVIDERS.iter().find(|p| p.provider == provider) else {
        return vec![];
    };

    app.host_rules
        .iter()
        .filter(|r| r.host == hostname)
        .map(|rule| {
            let pattern = rule
                .path_prefix
                .map_or_else(|| "*".to_string(), |prefix| format!("{prefix}*"));
            let injections = match rule.strategy {
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
            };
            (pattern, injections)
        })
        .collect()
}

/// Get the refresh config for a provider, if it supports token refresh.
pub(crate) fn refresh_config(provider: &str) -> Option<&'static RefreshConfig> {
    APP_PROVIDERS
        .iter()
        .find(|p| p.provider == provider)
        .and_then(|p| p.refresh)
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
    fn providers_for_known_hosts() {
        assert_eq!(providers_for_host("api.github.com"), vec!["github"]);
        assert_eq!(providers_for_host("github.com"), vec!["github"]);
        assert_eq!(
            providers_for_host("raw.githubusercontent.com"),
            vec!["github"]
        );
    }

    #[test]
    fn providers_for_unknown_host() {
        assert!(providers_for_host("api.openai.com").is_empty());
        assert!(providers_for_host("example.com").is_empty());
    }

    #[test]
    fn providers_for_googleapis_hosts() {
        assert_eq!(providers_for_host("gmail.googleapis.com"), vec!["gmail"]);
        // www.googleapis.com is shared — Gmail, Calendar, and Drive use path prefixes
        let www = providers_for_host("www.googleapis.com");
        assert!(www.contains(&"gmail"));
        assert!(www.contains(&"google-calendar"));
        assert!(www.contains(&"google-drive"));
    }

    #[test]
    fn path_pattern_scopes_shared_host() {
        // Providers on www.googleapis.com get path-scoped patterns
        assert_eq!(path_pattern_for("gmail", "www.googleapis.com"), "/gmail/*");
        assert_eq!(
            path_pattern_for("google-calendar", "www.googleapis.com"),
            "/calendar/*"
        );
        assert_eq!(
            path_pattern_for("google-drive", "www.googleapis.com"),
            "/drive/*"
        );
        // Dedicated subdomains use wildcard
        assert_eq!(path_pattern_for("gmail", "gmail.googleapis.com"), "*");
        assert_eq!(path_pattern_for("github", "api.github.com"), "*");
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

    // ── Gmail ─────────────────────────────────────────────────────────

    #[test]
    fn gmail_api_uses_bearer() {
        let injections = build_app_injections("gmail", "gmail.googleapis.com", "ya29.test");
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
    fn gmail_matches_www_googleapis() {
        // Gmail claims www.googleapis.com (with /gmail/ path prefix)
        let injections = build_app_injections("gmail", "www.googleapis.com", "ya29.test");
        assert_eq!(injections.len(), 1);
    }

    // ── Google Calendar ──────────────────────────────────────────────

    #[test]
    fn google_calendar_www_api_uses_bearer() {
        let injections =
            build_app_injections("google-calendar", "www.googleapis.com", "ya29.cal_test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ya29.cal_test".to_string(),
            }
        );
    }

    // ── Google Drive ──────────────────────────────────────────────────

    #[test]
    fn google_drive_produces_two_injection_rules() {
        // Drive has two host rules on www.googleapis.com: /drive/ and /upload/drive/
        let rules =
            build_app_injection_rules("google-drive", "www.googleapis.com", "ya29.drive_test");
        assert_eq!(
            rules.len(),
            2,
            "expected two rules for Drive on www.googleapis.com"
        );

        let patterns: Vec<&str> = rules.iter().map(|(p, _)| p.as_str()).collect();
        assert!(patterns.contains(&"/drive/*"));
        assert!(patterns.contains(&"/upload/drive/*"));

        // Both should use Bearer auth
        for (_, injections) in &rules {
            assert_eq!(injections.len(), 1);
            assert_eq!(
                injections[0],
                Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: "Bearer ya29.drive_test".to_string(),
                }
            );
        }
    }

    // ── Google Workspace apps (dedicated subdomains) ──────────────────

    #[test]
    fn providers_for_google_workspace_hosts() {
        assert_eq!(
            providers_for_host("docs.googleapis.com"),
            vec!["google-docs"]
        );
        assert_eq!(
            providers_for_host("sheets.googleapis.com"),
            vec!["google-sheets"]
        );
        assert_eq!(
            providers_for_host("slides.googleapis.com"),
            vec!["google-slides"]
        );
        assert_eq!(
            providers_for_host("tasks.googleapis.com"),
            vec!["google-tasks"]
        );
        assert_eq!(
            providers_for_host("forms.googleapis.com"),
            vec!["google-forms"]
        );
        assert_eq!(
            providers_for_host("classroom.googleapis.com"),
            vec!["google-classroom"]
        );
        assert_eq!(
            providers_for_host("admin.googleapis.com"),
            vec!["google-admin"]
        );
        assert_eq!(
            providers_for_host("analyticsdata.googleapis.com"),
            vec!["google-analytics"]
        );
        assert_eq!(
            providers_for_host("searchconsole.googleapis.com"),
            vec!["google-search-console"]
        );
        assert_eq!(
            providers_for_host("meet.googleapis.com"),
            vec!["google-meet"]
        );
        assert_eq!(
            providers_for_host("photoslibrary.googleapis.com"),
            vec!["google-photos"]
        );
    }

    #[test]
    fn google_workspace_apps_use_bearer() {
        let hosts = [
            ("google-docs", "docs.googleapis.com"),
            ("google-sheets", "sheets.googleapis.com"),
            ("google-slides", "slides.googleapis.com"),
            ("google-tasks", "tasks.googleapis.com"),
            ("google-forms", "forms.googleapis.com"),
            ("google-classroom", "classroom.googleapis.com"),
            ("google-admin", "admin.googleapis.com"),
            ("google-analytics", "analyticsdata.googleapis.com"),
            ("google-search-console", "searchconsole.googleapis.com"),
            ("google-meet", "meet.googleapis.com"),
            ("google-photos", "photoslibrary.googleapis.com"),
        ];
        for (provider, host) in &hosts {
            let injections = build_app_injections(provider, host, "ya29.test");
            assert_eq!(
                injections.len(),
                1,
                "{provider} on {host} should produce one injection"
            );
            assert_eq!(
                injections[0],
                Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: "Bearer ya29.test".to_string(),
                },
                "{provider} on {host} should use Bearer auth"
            );
        }
    }

    // ── Resend ────────────────────────────────────────────────────────

    #[test]
    fn providers_for_resend_host() {
        assert_eq!(providers_for_host("api.resend.com"), vec!["resend"]);
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

    #[test]
    fn path_pattern_unknown_provider_returns_wildcard() {
        assert_eq!(path_pattern_for("nonexistent", "any.host.com"), "*");
    }

    // ── provider_for_host ─────────────────────────────────────────────

    #[test]
    fn provider_for_host_returns_known_provider() {
        let result = provider_for_host("api.github.com");
        assert_eq!(result, Some(("github", "GitHub")));
    }

    #[test]
    fn provider_for_host_returns_none_for_unknown() {
        assert_eq!(provider_for_host("unknown.example.com"), None);
    }

    #[test]
    fn provider_for_host_returns_first_match_for_shared_host() {
        // www.googleapis.com is shared by Gmail, Calendar, Drive, etc.
        // provider_for_host returns the first match in registry order.
        let result = provider_for_host("www.googleapis.com");
        assert!(result.is_some());
        let (provider, _) = result.unwrap();
        // Gmail comes before Calendar in the registry
        assert_eq!(provider, "gmail");
    }

    // ── provider_for_host_and_path ─────────────────────────────────────

    #[test]
    fn provider_for_host_and_path_disambiguates_shared_host() {
        let result = provider_for_host_and_path("www.googleapis.com", "/calendar/v3/calendars");
        assert_eq!(result, Some(("google-calendar", "Google Calendar")));

        let result = provider_for_host_and_path("www.googleapis.com", "/gmail/v1/users/me");
        assert_eq!(result, Some(("gmail", "Gmail")));

        let result = provider_for_host_and_path("www.googleapis.com", "/drive/v3/files");
        assert_eq!(result, Some(("google-drive", "Google Drive")));
    }

    #[test]
    fn provider_for_host_and_path_falls_back_to_host_only() {
        // Dedicated subdomain — no path prefix needed
        let result = provider_for_host_and_path("gmail.googleapis.com", "/gmail/v1/users/me");
        assert_eq!(result, Some(("gmail", "Gmail")));

        let result = provider_for_host_and_path("api.github.com", "/user");
        assert_eq!(result, Some(("github", "GitHub")));
    }

    #[test]
    fn provider_for_host_and_path_returns_none_for_unknown() {
        assert_eq!(
            provider_for_host_and_path("unknown.example.com", "/foo"),
            None
        );
    }

    #[test]
    fn provider_for_host_includes_display_name() {
        let result = provider_for_host("gmail.googleapis.com");
        assert_eq!(result, Some(("gmail", "Gmail")));

        let result = provider_for_host("sheets.googleapis.com");
        assert_eq!(result, Some(("google-sheets", "Google Sheets")));
    }

    /// Shared hosts must not mix `None` and `Some` path prefixes — that would
    /// cause ambiguous injection (catch-all vs path-scoped rules on the same host).
    #[test]
    fn no_mixed_path_prefix_on_shared_hosts() {
        use std::collections::HashMap;
        let mut hosts: HashMap<&str, (bool, bool)> = HashMap::new();
        for provider in APP_PROVIDERS {
            for rule in provider.host_rules {
                let entry = hosts.entry(rule.host).or_default();
                if rule.path_prefix.is_some() {
                    entry.0 = true; // has prefix
                } else {
                    entry.1 = true; // has catch-all
                }
            }
        }
        for (host, (has_prefix, has_catchall)) in &hosts {
            assert!(
                !(*has_prefix && *has_catchall),
                "host {host} mixes path-prefix and catch-all rules — this causes ambiguous injection"
            );
        }
    }
}
