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
pub(crate) enum AuthStrategy {
    /// `Authorization: Bearer {token}`
    Bearer,
    /// `Authorization: Basic base64("x-access-token:{token}")`
    BasicXAccessToken,
    /// No `Authorization` header — auth injected via `credential_headers` only.
    #[cfg_attr(not(feature = "cloud"), allow(dead_code))]
    None,
}

/// How a host rule matches incoming hostnames.
#[derive(Debug, Clone, Copy)]
pub(crate) enum HostPattern {
    /// Match the hostname exactly (e.g., `"api.github.com"`).
    Exact(&'static str),
    /// Match any hostname ending with the suffix, strictly longer than the suffix
    /// (e.g., `"-aiplatform.googleapis.com"` matches `"us-central1-aiplatform.googleapis.com"`).
    Suffix(&'static str),
}

/// A host pattern and its injection strategy for an app provider.
pub(crate) struct HostRule {
    pub(crate) pattern: HostPattern,
    /// Optional path prefix to scope this rule (e.g., `"/calendar/"` for Google Calendar).
    /// When set, only requests whose path starts with this prefix match this provider.
    /// When `None`, all paths on the host match (used for providers with dedicated subdomains).
    pub(crate) path_prefix: Option<&'static str>,
    pub(crate) strategy: AuthStrategy,
    /// When true, matching requests return a synthetic OAuth token response with
    /// the cached access token instead of being forwarded upstream. Used for
    /// credential stub flows where the SDK tries to refresh dummy credentials.
    pub(crate) intercept: bool,
}

/// Check whether a `HostRule` matches a given hostname.
/// Suffix rules match any hostname that ends with the suffix and is strictly longer
/// (so the bare suffix itself never matches). Exact rules compare the host directly.
fn host_rule_matches(rule: &HostRule, hostname: &str) -> bool {
    match rule.pattern {
        HostPattern::Exact(host) => host == hostname,
        HostPattern::Suffix(suffix) => hostname.ends_with(suffix) && hostname.len() > suffix.len(),
    }
}

/// Body format for token refresh requests.
#[derive(Debug, Clone, Copy)]
pub(crate) enum TokenBodyFormat {
    /// `application/x-www-form-urlencoded` (OAuth 2.0 default, used by Google).
    Form,
    /// `application/json` (required by Atlassian).
    Json,
}

/// Configuration for refreshing expired OAuth tokens.
pub(crate) struct RefreshConfig {
    /// Token endpoint URL (e.g., `https://oauth2.googleapis.com/token`).
    pub(crate) token_url: &'static str,
    /// Env var for the OAuth client ID.
    pub(crate) client_id_env: &'static str,
    /// Env var for the OAuth client secret.
    pub(crate) client_secret_env: &'static str,
    /// Body format for token requests.
    pub(crate) body_format: TokenBodyFormat,
}

/// Maps a credential JSON field to an HTTP header injected on every request.
/// Used for providers that need custom headers (e.g., Datadog's DD-API-KEY).
pub(crate) struct CredentialHeader {
    pub(crate) credential_field: &'static str,
    pub(crate) header_name: &'static str,
}

/// Rewrites the upstream host based on a credential field.
/// Used for providers with regional endpoints (e.g., Datadog us5 → api.us5.datadoghq.com).
pub(crate) struct HostRewrite {
    pub(crate) credential_field: &'static str,
    pub(crate) template: fn(&str) -> String,
}

/// Maps a connection metadata key to an HTTP header injected on every request.
pub(crate) struct MetadataHeader {
    pub(crate) metadata_key: &'static str,
    pub(crate) header_name: &'static str,
}

/// An app provider definition with its host rules.
pub(crate) struct AppProvider {
    pub(crate) provider: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) host_rules: &'static [HostRule],
    pub(crate) refresh: Option<&'static RefreshConfig>,
    /// Headers injected from connection metadata (e.g., project ID → x-goog-user-project).
    pub(crate) metadata_headers: &'static [MetadataHeader],
    /// Headers injected from credential fields (e.g., DD-API-KEY from credentials.apiKey).
    pub(crate) credential_headers: &'static [CredentialHeader],
    /// Optional host rewrite based on a credential field (e.g., Datadog site → regional endpoint).
    pub(crate) host_rewrite: Option<&'static HostRewrite>,
}

/// Shared refresh config for Atlassian OAuth APIs (Jira, Confluence).
static ATLASSIAN_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://auth.atlassian.com/oauth/token",
    client_id_env: "ATLASSIAN_CLIENT_ID",
    client_secret_env: "ATLASSIAN_CLIENT_SECRET",
    body_format: TokenBodyFormat::Json,
};

/// Refresh config for Todoist OAuth API.
static TODOIST_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.todoist.com/oauth/access_token",
    client_id_env: "TODOIST_CLIENT_ID",
    client_secret_env: "TODOIST_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
};

/// Shared refresh config for all Google OAuth APIs.
static GOOGLE_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://oauth2.googleapis.com/token",
    client_id_env: "GOOGLE_CLIENT_ID",
    client_secret_env: "GOOGLE_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
};

// ── Provider registry ──────────────────────────────────────────────────

static APP_PROVIDERS: &[AppProvider] = &[
    AppProvider {
        provider: "github",
        display_name: "GitHub",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.github.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("github.com"),
                path_prefix: None,
                strategy: AuthStrategy::BasicXAccessToken,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("raw.githubusercontent.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "gmail",
        display_name: "Gmail",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("gmail.googleapis.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            // Legacy endpoint — some clients still use www.googleapis.com/gmail/
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/gmail/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/gmail/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-calendar",
        display_name: "Google Calendar",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/calendar/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/calendar/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-drive",
        display_name: "Google Drive",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/drive/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/upload/drive/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/drive/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-docs",
        display_name: "Google Docs",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("docs.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-sheets",
        display_name: "Google Sheets",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("sheets.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-slides",
        display_name: "Google Slides",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("slides.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-tasks",
        display_name: "Google Tasks",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("tasks.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-forms",
        display_name: "Google Forms",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("forms.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-classroom",
        display_name: "Google Classroom",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("classroom.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-admin",
        display_name: "Google Admin",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("admin.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-analytics",
        display_name: "Google Analytics",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("analyticsdata.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-search-console",
        display_name: "Google Search Console",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("searchconsole.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-meet",
        display_name: "Google Meet",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("meet.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "google-photos",
        display_name: "Google Photos",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("photoslibrary.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "jira",
        display_name: "Jira",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.atlassian.com"),
            path_prefix: Some("/ex/jira/"),
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&ATLASSIAN_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "confluence",
        display_name: "Confluence",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.atlassian.com"),
            path_prefix: Some("/ex/confluence/"),
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&ATLASSIAN_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "youtube",
        display_name: "YouTube",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/youtube/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/upload/youtube/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/youtube/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "vertex-ai",
        display_name: "Vertex AI",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Suffix("-aiplatform.googleapis.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
            },
            HostRule {
                pattern: HostPattern::Exact("oauth2.googleapis.com"),
                path_prefix: Some("/token"),
                strategy: AuthStrategy::Bearer,
                intercept: true,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[MetadataHeader {
            metadata_key: "quotaProjectId",
            header_name: "x-goog-user-project",
        }],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "todoist",
        display_name: "Todoist",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.todoist.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: Some(&TODOIST_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
    AppProvider {
        provider: "resend",
        display_name: "Resend",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.resend.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        host_rewrite: None,
    },
];

// ── Public API ─────────────────────────────────────────────────────────

/// Iterate over all registered providers, including cloud-only providers
/// added by the `cloud_apps` module.
fn all_providers() -> impl Iterator<Item = &'static AppProvider> {
    APP_PROVIDERS
        .iter()
        .chain(crate::cloud_apps::providers().iter())
}

/// Given a hostname, return the first matching provider's (id, display_name).
/// Returns `None` if no provider matches.
pub(crate) fn provider_for_host(hostname: &str) -> Option<(&'static str, &'static str)> {
    all_providers().find_map(|p| {
        p.host_rules
            .iter()
            .any(|r| host_rule_matches(r, hostname))
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
    let path_match = all_providers().find_map(|p| {
        p.host_rules
            .iter()
            .any(|r| {
                host_rule_matches(r, hostname)
                    && r.path_prefix.is_some_and(|pfx| path.starts_with(pfx))
            })
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
    for provider in all_providers() {
        for rule in provider.host_rules {
            if host_rule_matches(rule, hostname) {
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
    all_providers()
        .find(|p| p.provider == provider)
        .and_then(|app| {
            app.host_rules
                .iter()
                .find(|r| host_rule_matches(r, hostname))
        })
        .and_then(|rule| rule.path_prefix)
        .map_or_else(|| "*".to_string(), |prefix| format!("{prefix}*"))
}

/// Build injections for the first matching host rule (single-rule providers).
/// For multi-rule providers (e.g., Google Drive), use `build_app_injection_rules`.
#[cfg(test)]
fn build_app_injections(provider: &str, hostname: &str, token: &str) -> Vec<Injection> {
    let app = all_providers().find(|p| p.provider == provider);
    let Some(app) = app else { return vec![] };

    let rule = app
        .host_rules
        .iter()
        .find(|r| host_rule_matches(r, hostname));
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
        AuthStrategy::None => vec![],
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
    let Some(app) = all_providers().find(|p| p.provider == provider) else {
        return vec![];
    };

    app.host_rules
        .iter()
        .filter(|r| host_rule_matches(r, hostname))
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
                AuthStrategy::None => vec![],
            };
            (pattern, injections)
        })
        .collect()
}

/// Get the refresh config for a provider, if it supports token refresh.
pub(crate) fn refresh_config(provider: &str) -> Option<&'static RefreshConfig> {
    all_providers()
        .find(|p| p.provider == provider)
        .and_then(|p| p.refresh)
}

/// Get metadata-to-header mappings for a provider.
pub(crate) fn metadata_headers(provider: &str) -> &'static [MetadataHeader] {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| p.metadata_headers)
        .unwrap_or(&[])
}

/// Get credential-to-header mappings for a provider.
pub(crate) fn credential_headers(provider: &str) -> &'static [CredentialHeader] {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| p.credential_headers)
        .unwrap_or(&[])
}

/// Compute the rewritten upstream host for a provider based on credential fields.
/// Returns `None` if the provider has no host rewrite rule or the credential field is missing.
pub(crate) fn rewrite_host(provider: &str, creds: &serde_json::Value) -> Option<String> {
    let app = all_providers().find(|p| p.provider == provider)?;
    let hw = app.host_rewrite?;
    let field_value = creds.get(hw.credential_field)?.as_str()?;
    Some((hw.template)(field_value))
}

/// Returns true if the provider has any host rule that injects an Authorization header.
/// Providers using only credential_headers (e.g., Datadog) return false.
pub(crate) fn needs_access_token(provider: &str) -> bool {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| {
            p.host_rules
                .iter()
                .any(|r| !matches!(r.strategy, AuthStrategy::None))
        })
        .unwrap_or(false)
}

/// Check whether any provider matching this hostname has intercept rules.
/// Used to decide whether to pre-compute interception data at resolution time.
pub(crate) fn host_has_intercept_rules(hostname: &str) -> bool {
    all_providers().any(|p| {
        p.host_rules.iter().any(|r| r.intercept)
            && p.host_rules.iter().any(|r| host_rule_matches(r, hostname))
    })
}

/// Check whether a request should be intercepted with a synthetic token response.
/// Returns true when any provider has a host rule matching the hostname and path
/// with `intercept: true`.
pub(crate) fn is_intercept_target(hostname: &str, path: &str) -> bool {
    all_providers().any(|p| {
        p.host_rules.iter().any(|r| {
            r.intercept
                && host_rule_matches(r, hostname)
                && r.path_prefix.is_none_or(|pfx| path.starts_with(pfx))
        })
    })
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

    let req = reqwest::Client::new().post(config.token_url);
    let req = match config.body_format {
        TokenBodyFormat::Form => req.form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ]),
        TokenBodyFormat::Json => req.json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        })),
    };
    let resp = req
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

#[derive(serde::Serialize)]
struct ServiceAccountClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    aud: &'static str,
    scope: &'static str,
    iat: i64,
    exp: i64,
}

/// Refresh an access token using a Google service account private key.
/// Signs a JWT with RS256, then exchanges it at Google's token endpoint
/// using the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant type.
pub(crate) async fn refresh_via_service_account(
    private_key_pem: &str,
    client_email: &str,
) -> anyhow::Result<(String, i64)> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs() as i64;

    let claims = ServiceAccountClaims {
        iss: client_email,
        sub: client_email,
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        iat: now,
        exp: now + 3600,
    };

    let key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
        .map_err(|e| anyhow::anyhow!("invalid RSA private key: {e}"))?;

    let assertion = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|e| anyhow::anyhow!("JWT signing failed: {e}"))?;

    let resp = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("service account token request failed: {e}"))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("service account token response parse failed: {e}"))?;

    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let error = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            anyhow::anyhow!("service account token exchange failed: {error}")
        })?
        .to_string();

    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);

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
        // www.googleapis.com is shared — Gmail, Calendar, Drive, and YouTube use path prefixes
        let www = providers_for_host("www.googleapis.com");
        assert!(www.contains(&"gmail"));
        assert!(www.contains(&"google-calendar"));
        assert!(www.contains(&"google-drive"));
        assert!(www.contains(&"youtube"));
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

    #[test]
    fn google_calendar_produces_two_injection_rules() {
        let rules =
            build_app_injection_rules("google-calendar", "www.googleapis.com", "ya29.cal_test");
        assert_eq!(
            rules.len(),
            2,
            "expected two rules for Calendar on www.googleapis.com"
        );

        let patterns: Vec<&str> = rules.iter().map(|(p, _)| p.as_str()).collect();
        assert!(patterns.contains(&"/calendar/*"));
        assert!(patterns.contains(&"/batch/calendar/*"));
    }

    // ── Google Drive ──────────────────────────────────────────────────

    #[test]
    fn google_drive_produces_three_injection_rules() {
        let rules =
            build_app_injection_rules("google-drive", "www.googleapis.com", "ya29.drive_test");
        assert_eq!(
            rules.len(),
            3,
            "expected three rules for Drive on www.googleapis.com"
        );

        let patterns: Vec<&str> = rules.iter().map(|(p, _)| p.as_str()).collect();
        assert!(patterns.contains(&"/drive/*"));
        assert!(patterns.contains(&"/upload/drive/*"));
        assert!(patterns.contains(&"/batch/drive/*"));

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
    fn google_refresh_uses_form_body_format() {
        let config = refresh_config("gmail").expect("gmail should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
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

    // ── Atlassian (Jira + Confluence) ───────────────────────────────

    #[test]
    fn providers_for_atlassian_host() {
        let providers = providers_for_host("api.atlassian.com");
        assert!(providers.contains(&"jira"));
        assert!(providers.contains(&"confluence"));
    }

    #[test]
    fn jira_path_disambiguation() {
        let result =
            provider_for_host_and_path("api.atlassian.com", "/ex/jira/11223344/rest/api/3/issue");
        assert_eq!(result, Some(("jira", "Jira")));
    }

    #[test]
    fn confluence_path_disambiguation() {
        let result = provider_for_host_and_path(
            "api.atlassian.com",
            "/ex/confluence/11223344/rest/api/v3/content",
        );
        assert_eq!(result, Some(("confluence", "Confluence")));
    }

    #[test]
    fn jira_api_uses_bearer() {
        let injections = build_app_injections("jira", "api.atlassian.com", "eyJ0eXAi.test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer eyJ0eXAi.test".to_string(),
            }
        );
    }

    #[test]
    fn confluence_api_uses_bearer() {
        let injections = build_app_injections("confluence", "api.atlassian.com", "eyJ0eXAi.test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer eyJ0eXAi.test".to_string(),
            }
        );
    }

    #[test]
    fn atlassian_refresh_uses_json_body_format() {
        let config = refresh_config("jira").expect("jira should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Json));

        let config = refresh_config("confluence").expect("confluence should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Json));
    }

    // ── YouTube ───────────────────────────────────────────────────────

    #[test]
    fn youtube_matches_www_googleapis() {
        let www = providers_for_host("www.googleapis.com");
        assert!(www.contains(&"youtube"));
    }

    #[test]
    fn youtube_path_disambiguation() {
        let result = provider_for_host_and_path("www.googleapis.com", "/youtube/v3/playlists");
        assert_eq!(result, Some(("youtube", "YouTube")));
    }

    #[test]
    fn youtube_produces_three_injection_rules() {
        let rules = build_app_injection_rules("youtube", "www.googleapis.com", "ya29.yt_test");
        assert_eq!(
            rules.len(),
            3,
            "expected three rules for YouTube on www.googleapis.com"
        );

        let patterns: Vec<&str> = rules.iter().map(|(p, _)| p.as_str()).collect();
        assert!(patterns.contains(&"/youtube/*"));
        assert!(patterns.contains(&"/upload/youtube/*"));
        assert!(patterns.contains(&"/batch/youtube/*"));

        for (_, injections) in &rules {
            assert_eq!(injections.len(), 1);
            assert_eq!(
                injections[0],
                Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: "Bearer ya29.yt_test".to_string(),
                }
            );
        }
    }

    // ── Todoist ───────────────────────────────────────────────────────

    #[test]
    fn providers_for_todoist_host() {
        assert_eq!(providers_for_host("api.todoist.com"), vec!["todoist"]);
    }

    #[test]
    fn provider_for_host_todoist() {
        let result = provider_for_host("api.todoist.com");
        assert_eq!(result, Some(("todoist", "Todoist")));
    }

    #[test]
    fn todoist_api_uses_bearer() {
        let injections = build_app_injections("todoist", "api.todoist.com", "test_token_abc");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer test_token_abc".to_string(),
            }
        );
    }

    #[test]
    fn todoist_refresh_uses_form_body_format() {
        let config = refresh_config("todoist").expect("todoist should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
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

    // ── Cloud-only providers ─────────────────────────────────────────

    #[cfg(feature = "cloud")]
    mod cloud_providers {
        use super::*;

        #[test]
        fn providers_for_datadog_hosts() {
            assert_eq!(providers_for_host("api.datadoghq.com"), vec!["datadog"]);
            assert_eq!(providers_for_host("api.us3.datadoghq.com"), vec!["datadog"]);
            assert_eq!(providers_for_host("api.us5.datadoghq.com"), vec!["datadog"]);
            assert_eq!(providers_for_host("api.ap1.datadoghq.com"), vec!["datadog"]);
            assert_eq!(providers_for_host("api.ap2.datadoghq.com"), vec!["datadog"]);
            assert_eq!(providers_for_host("api.datadoghq.eu"), vec!["datadog"]);
            assert_eq!(providers_for_host("api.ddog-gov.com"), vec!["datadog"]);
            assert_eq!(providers_for_host("api.us2.ddog-gov.com"), vec!["datadog"]);
        }

        #[test]
        fn datadog_no_false_positives() {
            assert!(providers_for_host("datadoghq.com").is_empty());
            assert!(providers_for_host("datadoghq.eu").is_empty());
            assert!(providers_for_host("ddog-gov.com").is_empty());
        }

        #[test]
        fn provider_for_host_datadog() {
            let result = provider_for_host("api.datadoghq.com");
            assert_eq!(result, Some(("datadog", "Datadog")));
        }

        #[test]
        fn datadog_no_auth_header_injected() {
            let injections = build_app_injections("datadog", "api.datadoghq.com", "unused");
            assert!(
                injections.is_empty(),
                "Datadog should not inject Authorization header"
            );
        }

        #[test]
        fn datadog_credential_headers_defined() {
            let headers = credential_headers("datadog");
            assert_eq!(headers.len(), 2);
            assert_eq!(headers[0].credential_field, "apiKey");
            assert_eq!(headers[0].header_name, "DD-API-KEY");
            assert_eq!(headers[1].credential_field, "appKey");
            assert_eq!(headers[1].header_name, "DD-APPLICATION-KEY");
        }
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
    fn provider_for_host_and_path_matches_batch_endpoints() {
        let result = provider_for_host_and_path("www.googleapis.com", "/batch/calendar/v3");
        assert_eq!(result, Some(("google-calendar", "Google Calendar")));

        let result = provider_for_host_and_path("www.googleapis.com", "/batch/gmail/v1");
        assert_eq!(result, Some(("gmail", "Gmail")));

        let result = provider_for_host_and_path("www.googleapis.com", "/batch/drive/v3");
        assert_eq!(result, Some(("google-drive", "Google Drive")));

        let result = provider_for_host_and_path("www.googleapis.com", "/batch/youtube/v3");
        assert_eq!(result, Some(("youtube", "YouTube")));
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
        for provider in all_providers() {
            for rule in provider.host_rules {
                let host = match rule.pattern {
                    HostPattern::Exact(h) => h,
                    HostPattern::Suffix(_) => continue, // suffix rules don't share hosts
                };
                let entry = hosts.entry(host).or_default();
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

    // ── Vertex AI ────────────────────────────────────────────────────────

    #[test]
    fn providers_for_vertex_ai_hosts() {
        assert_eq!(
            providers_for_host("us-central1-aiplatform.googleapis.com"),
            vec!["vertex-ai"]
        );
        assert_eq!(
            providers_for_host("europe-west1-aiplatform.googleapis.com"),
            vec!["vertex-ai"]
        );
        assert_eq!(
            providers_for_host("asia-east1-aiplatform.googleapis.com"),
            vec!["vertex-ai"]
        );
    }

    #[test]
    fn vertex_ai_suffix_no_false_positives() {
        assert!(providers_for_host("aiplatform.googleapis.com").is_empty());
        assert!(providers_for_host("-aiplatform.googleapis.com").is_empty());
    }

    #[test]
    fn vertex_ai_uses_bearer() {
        let rules = build_app_injection_rules(
            "vertex-ai",
            "us-central1-aiplatform.googleapis.com",
            "ya29.test",
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].0, "*");
        assert_eq!(
            rules[0].1,
            vec![Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ya29.test".to_string(),
            }]
        );
    }

    #[test]
    fn provider_for_host_vertex_ai() {
        let result = provider_for_host("us-central1-aiplatform.googleapis.com");
        assert_eq!(result, Some(("vertex-ai", "Vertex AI")));
    }

    #[test]
    fn provider_for_host_and_path_vertex_ai() {
        let result = provider_for_host_and_path(
            "us-central1-aiplatform.googleapis.com",
            "/v1/projects/my-proj/locations/us-central1/publishers/anthropic/models/claude:streamRawPredict",
        );
        assert_eq!(result, Some(("vertex-ai", "Vertex AI")));
    }

    #[test]
    fn oauth2_token_endpoint_maps_to_vertex_ai() {
        assert_eq!(
            providers_for_host("oauth2.googleapis.com"),
            vec!["vertex-ai"]
        );
        assert!(is_intercept_target("oauth2.googleapis.com", "/token"));
        assert!(!is_intercept_target("oauth2.googleapis.com", "/authorize"));
    }
}
