//! App connection provider registry.
//!
//! Maps hostnames to OAuth providers and defines per-host injection rules.
//! Each provider can have multiple host rules with different auth patterns
//! (e.g., GitHub REST API uses Bearer auth, but git HTTPS uses Basic auth).

use base64::Engine;

use common::util::parse_jwt_exp;
use inject::Injection;

// ── Host rule ──────────────────────────────────────────────────────────

/// Auth injection strategy for a specific host.
#[derive(Debug, Clone, Copy)]
pub enum AuthStrategy {
    /// `Authorization: Bearer {token}`
    Bearer,
    /// `Authorization: Basic base64("x-access-token:{token}")`
    BasicXAccessToken,
    /// `Authorization: Zoho-oauthtoken {token}` — Zoho's OAuth header scheme.
    ZohoOauthtoken,
    /// No `Authorization` header — auth injected via `credential_headers` only.
    None,
}

/// Provider-specific request transformation applied after header injection,
/// before forwarding. Used for auth schemes that require signing the full
/// request (headers + body) rather than injecting a static token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestFinalizer {
    /// AWS Signature Version 4 — signs the request with IAM credentials.
    AwsSigV4,
    /// AWS STS AssumeRole — resolves temporary credentials, then signs with SigV4.
    AwsAssumeRole,
}

/// Body transformation applied to specific requests after header injection.
/// The handler internally decides whether to act based on host, method, and path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyTransform {
    /// Inject agent identity trailer into GitHub commit messages.
    GitHubCommitTrailer,
}

/// How a host rule matches incoming hostnames.
#[derive(Debug, Clone, Copy)]
pub enum HostPattern {
    /// Match the hostname exactly (e.g., `"api.github.com"`).
    Exact(&'static str),
    /// Match any hostname ending with the suffix, strictly longer than the suffix
    /// (e.g., `"-aiplatform.googleapis.com"` matches `"us-central1-aiplatform.googleapis.com"`).
    Suffix(&'static str),
}

/// A host pattern and its injection strategy for an app provider.
pub struct HostRule {
    pub pattern: HostPattern,
    /// Optional path prefix to scope this rule (e.g., `"/calendar/"` for Google Calendar).
    /// When set, only requests whose path starts with this prefix match this provider.
    /// When `None`, all paths on the host match (used for providers with dedicated subdomains).
    pub path_prefix: Option<&'static str>,
    pub strategy: AuthStrategy,
    /// When true, matching requests return a synthetic OAuth token response with
    /// the cached access token instead of being forwarded upstream. Used for
    /// credential stub flows where the SDK tries to refresh dummy credentials.
    pub intercept: bool,
    /// For suffix-pattern rules covering per-tenant hosts (e.g. `*.jfrog.io`),
    /// the credential JSON field holding the connection's stored host.
    /// Injection proceeds ONLY when the request host equals the stored value,
    /// preventing token leakage to other tenants on the same suffix.
    pub credential_host_field: Option<&'static str>,
}

impl HostPattern {
    pub fn matches(&self, hostname: &str) -> bool {
        match self {
            Self::Exact(host) => *host == hostname,
            Self::Suffix(suffix) => hostname.ends_with(suffix) && hostname.len() > suffix.len(),
        }
    }
}

fn host_rule_matches(rule: &HostRule, hostname: &str) -> bool {
    rule.pattern.matches(hostname)
}

/// Body format for token refresh requests.
#[derive(Debug, Clone, Copy)]
pub enum TokenBodyFormat {
    /// `application/x-www-form-urlencoded` (OAuth 2.0 default, used by Google).
    Form,
    /// `application/json` (required by Atlassian).
    Json,
}

/// How client credentials are sent during token refresh.
#[derive(Debug, Clone, Copy)]
pub enum ClientCredentialMethod {
    /// Include `client_id` and `client_secret` in the request body (default).
    Body,
    /// Send `Authorization: Basic base64(client_id:client_secret)` header (Notion).
    BasicAuth,
}

/// Configuration for refreshing expired OAuth tokens.
pub struct RefreshConfig {
    /// Token endpoint URL (e.g., `https://oauth2.googleapis.com/token`).
    pub token_url: &'static str,
    /// Env var for the OAuth client ID.
    pub client_id_env: &'static str,
    /// Env var for the OAuth client secret.
    pub client_secret_env: &'static str,
    /// Body format for token requests.
    pub body_format: TokenBodyFormat,
    /// How client credentials are sent (body vs Basic auth header).
    pub client_auth: ClientCredentialMethod,
}

/// Maps a credential JSON field to an HTTP header injected on every request.
/// Used for providers that need custom headers (e.g., Datadog's DD-API-KEY).
pub struct CredentialHeader {
    pub credential_field: &'static str,
    pub header_name: &'static str,
}

/// Maps a credential JSON field to a URL query parameter injected on every request.
/// Used for providers that authenticate via query params (e.g., Trello's `?key=...&token=...`).
pub struct CredentialParam {
    pub credential_field: &'static str,
    pub param_name: &'static str,
}

/// Rewrites the upstream host based on a credential field.
/// Used for providers with regional endpoints (e.g., Datadog us5 → api.us5.datadoghq.com).
/// The template receives (field_value, original_host) and returns `None` to skip rewriting.
pub struct HostRewrite {
    pub credential_field: &'static str,
    pub template: fn(&str, &str) -> Option<String>,
}

/// Maps a connection metadata key to an HTTP header injected on every request.
pub struct MetadataHeader {
    pub metadata_key: &'static str,
    pub header_name: &'static str,
}

/// An app provider definition with its host rules.
pub struct AppProvider {
    pub provider: &'static str,
    pub display_name: &'static str,
    pub host_rules: &'static [HostRule],
    pub refresh: Option<&'static RefreshConfig>,
    /// Headers injected from connection metadata (e.g., project ID → x-goog-user-project).
    pub metadata_headers: &'static [MetadataHeader],
    /// Headers injected from credential fields (e.g., DD-API-KEY from credentials.apiKey).
    pub credential_headers: &'static [CredentialHeader],
    /// Query params injected from credential fields (e.g., Trello's `?key=...&token=...`).
    pub credential_params: &'static [CredentialParam],
    /// Optional host rewrite based on a credential field (e.g., Datadog site → regional endpoint).
    pub host_rewrite: Option<&'static HostRewrite>,
    /// Optional request finalizer for providers needing full request transformation
    /// (e.g., AWS SigV4 signing). Called after injection, before forwarding.
    pub finalizer: Option<RequestFinalizer>,
    /// Optional body transform for provider-specific request modifications.
    /// The handler decides per-request whether to act.
    pub body_transform: Option<BodyTransform>,
}

/// Shared refresh config for Atlassian OAuth APIs (Jira, Confluence).
static ATLASSIAN_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://auth.atlassian.com/oauth/token",
    client_id_env: "ATLASSIAN_CLIENT_ID",
    client_secret_env: "ATLASSIAN_CLIENT_SECRET",
    body_format: TokenBodyFormat::Json,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Todoist OAuth API.
static TODOIST_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.todoist.com/oauth/access_token",
    client_id_env: "TODOIST_CLIENT_ID",
    client_secret_env: "TODOIST_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Shared refresh config for all Google OAuth APIs.
static GOOGLE_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://oauth2.googleapis.com/token",
    client_id_env: "GOOGLE_CLIENT_ID",
    client_secret_env: "GOOGLE_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Supabase Management API OAuth (uses Basic auth).
static SUPABASE_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.supabase.com/v1/oauth/token",
    client_id_env: "SUPABASE_CLIENT_ID",
    client_secret_env: "SUPABASE_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::BasicAuth,
};

/// Refresh config for GitLab OAuth API.
static GITLAB_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://gitlab.com/oauth/token",
    client_id_env: "GITLAB_CLIENT_ID",
    client_secret_env: "GITLAB_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Notion OAuth API (uses Basic auth + token rotation).
static NOTION_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.notion.com/v1/oauth/token",
    client_id_env: "NOTION_CLIENT_ID",
    client_secret_env: "NOTION_CLIENT_SECRET",
    body_format: TokenBodyFormat::Json,
    client_auth: ClientCredentialMethod::BasicAuth,
};

/// Refresh config for Dropbox OAuth API.
static DROPBOX_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.dropboxapi.com/oauth2/token",
    client_id_env: "DROPBOX_CLIENT_ID",
    client_secret_env: "DROPBOX_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for LinkedIn OAuth API.
static LINKEDIN_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://www.linkedin.com/oauth/v2/accessToken",
    client_id_env: "LINKEDIN_CLIENT_ID",
    client_secret_env: "LINKEDIN_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Sentry OAuth API.
static SENTRY_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://sentry.io/oauth/token/",
    client_id_env: "SENTRY_CLIENT_ID",
    client_secret_env: "SENTRY_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Zoom OAuth API (uses Basic auth for client credentials).
static ZOOM_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://zoom.us/oauth/token",
    client_id_env: "ZOOM_CLIENT_ID",
    client_secret_env: "ZOOM_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::BasicAuth,
};

/// Shared refresh config for all Microsoft 365 OAuth APIs (Outlook Mail, Calendar, Word, OneNote).
static MICROSOFT_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    client_id_env: "MICROSOFT_CLIENT_ID",
    client_secret_env: "MICROSOFT_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Linear OAuth API.
static LINEAR_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.linear.app/oauth/token",
    client_id_env: "LINEAR_CLIENT_ID",
    client_secret_env: "LINEAR_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Fathom AI OAuth API.
static FATHOM_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.fathom.ai/external/v1/oauth2/token",
    client_id_env: "FATHOM_CLIENT_ID",
    client_secret_env: "FATHOM_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for X (Twitter) OAuth API (uses Basic auth for client credentials).
static X_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.x.com/2/oauth2/token",
    client_id_env: "X_CLIENT_ID",
    client_secret_env: "X_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::BasicAuth,
};

/// Refresh config for HubSpot OAuth API.
static HUBSPOT_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://api.hubapi.com/oauth/2026-03/token",
    client_id_env: "HUBSPOT_CLIENT_ID",
    client_secret_env: "HUBSPOT_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Refresh config for Zoho CRM OAuth (BYO clients only — the env vars match
/// the definition's envDefaults, so an operator-configured client refreshes).
static ZOHO_CRM_REFRESH: RefreshConfig = RefreshConfig {
    token_url: "https://accounts.zoho.com/oauth/v2/token",
    client_id_env: "ZOHO_CRM_CLIENT_ID",
    client_secret_env: "ZOHO_CRM_CLIENT_SECRET",
    body_format: TokenBodyFormat::Form,
    client_auth: ClientCredentialMethod::Body,
};

/// Maps a Datadog site code to its regional hostname, preserving the full
/// subdomain prefix — including compound ones like `http-intake.logs`.
fn datadog_host_for_site(site: &str, original_host: &str) -> Option<String> {
    let suffixes = [".datadoghq.com", ".datadoghq.eu", ".ddog-gov.com"];
    let subdomain = suffixes
        .iter()
        .find_map(|s| original_host.strip_suffix(s))
        .unwrap_or(original_host.split('.').next().unwrap_or("api"));

    let prefix = if !site.is_empty() {
        subdomain
            .strip_suffix(&format!(".{site}"))
            .unwrap_or(subdomain)
    } else {
        subdomain
    };

    Some(match site {
        "us1" | "" => format!("{prefix}.datadoghq.com"),
        "eu" | "eu1" => format!("{prefix}.datadoghq.eu"),
        "gov" | "us1-fed" => format!("{prefix}.ddog-gov.com"),
        other => format!("{prefix}.{other}.datadoghq.com"),
    })
}

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
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("github.com"),
                path_prefix: None,
                strategy: AuthStrategy::BasicXAccessToken,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("raw.githubusercontent.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "github-app",
        display_name: "GitHub App",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.github.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("github.com"),
                path_prefix: None,
                strategy: AuthStrategy::BasicXAccessToken,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("raw.githubusercontent.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: Some(BodyTransform::GitHubCommitTrailer),
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
                credential_host_field: None,
            },
            // Legacy endpoint — some clients still use www.googleapis.com/gmail/
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/gmail/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/gmail/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
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
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/calendar/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
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
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/upload/drive/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/drive/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-contacts",
        display_name: "Google Contacts",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("people.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-docs",
        display_name: "Google Docs",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("docs.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-sheets",
        display_name: "Google Sheets",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("sheets.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-slides",
        display_name: "Google Slides",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("slides.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-tasks",
        display_name: "Google Tasks",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("tasks.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-chat",
        display_name: "Google Chat",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("chat.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-forms",
        display_name: "Google Forms",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("forms.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-classroom",
        display_name: "Google Classroom",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("classroom.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-admin",
        display_name: "Google Admin",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("admin.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-analytics",
        display_name: "Google Analytics",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("analyticsdata.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-search-console",
        display_name: "Google Search Console",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("searchconsole.googleapis.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/webmasters/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-meet",
        display_name: "Google Meet",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("meet.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "google-photos",
        display_name: "Google Photos",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("photoslibrary.googleapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "jira",
        display_name: "Jira",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.atlassian.com"),
                path_prefix: Some("/ex/jira/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("api.atlassian.com"),
                path_prefix: Some("/oauth/token/accessible-resources"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&ATLASSIAN_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "confluence",
        display_name: "Confluence",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.atlassian.com"),
                path_prefix: Some("/ex/confluence/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("api.atlassian.com"),
                path_prefix: Some("/oauth/token/accessible-resources"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&ATLASSIAN_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
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
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/upload/youtube/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("www.googleapis.com"),
                path_prefix: Some("/batch/youtube/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
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
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("oauth2.googleapis.com"),
                path_prefix: Some("/token"),
                strategy: AuthStrategy::Bearer,
                intercept: true,
                credential_host_field: None,
            },
        ],
        refresh: Some(&GOOGLE_REFRESH),
        metadata_headers: &[MetadataHeader {
            metadata_key: "quotaProjectId",
            header_name: "x-goog-user-project",
        }],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "todoist",
        display_name: "Todoist",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.todoist.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&TODOIST_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "resend",
        display_name: "Resend",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.resend.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "cloudflare",
        display_name: "Cloudflare",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.cloudflare.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "notion",
        display_name: "Notion",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.notion.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&NOTION_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "dropbox",
        display_name: "Dropbox",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.dropboxapi.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("content.dropboxapi.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&DROPBOX_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "aws",
        display_name: "AWS",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Suffix(".amazonaws.com"),
                path_prefix: None,
                strategy: AuthStrategy::None,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Suffix(".api.aws"),
                path_prefix: None,
                strategy: AuthStrategy::None,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[
            CredentialHeader {
                credential_field: "accessKeyId",
                header_name: "x-onecli-aws-access-key-id",
            },
            CredentialHeader {
                credential_field: "secretAccessKey",
                header_name: "x-onecli-aws-secret-access-key",
            },
            CredentialHeader {
                credential_field: "region",
                header_name: "x-onecli-aws-region",
            },
        ],
        credential_params: &[],
        host_rewrite: None,
        finalizer: Some(RequestFinalizer::AwsSigV4),
        body_transform: None,
    },
    AppProvider {
        provider: "mongodb-atlas",
        display_name: "MongoDB Atlas",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("cloud.mongodb.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "flyio",
        display_name: "Fly.io",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.machines.dev"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("api.fly.io"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "docker",
        display_name: "Docker Hub",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("hub.docker.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "monday",
        display_name: "monday.com",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.monday.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "linkedin",
        display_name: "LinkedIn",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.linkedin.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&LINKEDIN_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "vercel",
        display_name: "Vercel",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.vercel.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "supabase",
        display_name: "Supabase",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.supabase.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&SUPABASE_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "trello",
        display_name: "Trello",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.trello.com"),
            path_prefix: None,
            strategy: AuthStrategy::None,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[
            CredentialParam {
                credential_field: "apiKey",
                param_name: "key",
            },
            CredentialParam {
                credential_field: "access_token",
                param_name: "token",
            },
        ],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "gitlab",
        display_name: "GitLab",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("gitlab.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&GITLAB_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "jfrog-artifactory",
        display_name: "JFrog Artifactory",
        // Wildcard suffix: JFrog SaaS hosts are per-customer (`<name>.jfrog.io`).
        // The bare suffix alone would inject the token into ANY `*.jfrog.io`
        // host, so `credential_host_field` gates injection to the connection's
        // exact stored subdomain (see connect.rs).
        host_rules: &[HostRule {
            pattern: HostPattern::Suffix(".jfrog.io"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: Some("subdomain"),
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "snowflake",
        display_name: "Snowflake",
        // Wildcard suffix: Snowflake hosts are per-account
        // (`<org>-<account>.snowflakecomputing.com`). As with JFrog, the bare
        // suffix would inject the PAT into ANY tenant's host, so
        // `credential_host_field` gates injection to the connection's exact
        // stored host (see connect.rs).
        host_rules: &[HostRule {
            pattern: HostPattern::Suffix(".snowflakecomputing.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: Some("host"),
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "stripe",
        display_name: "Stripe",
        // Stripe authenticates with API keys over `Authorization: Bearer` (the
        // docs also show `-u key:` Basic; Bearer is what the v2 surface uses
        // and both are accepted). `files.stripe.com` is the separate upload
        // host for the Files API and takes the SAME key, so it is listed
        // explicitly rather than reached with a suffix pattern — every other
        // *.stripe.com host (dashboard, checkout, js) is browser-facing and
        // must never receive the key.
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.stripe.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("files.stripe.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        // API keys don't expire; they're rotated in the Stripe Dashboard.
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "aws-role",
        display_name: "AWS Role",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Suffix(".amazonaws.com"),
                path_prefix: None,
                strategy: AuthStrategy::None,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Suffix(".api.aws"),
                path_prefix: None,
                strategy: AuthStrategy::None,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[
            CredentialHeader {
                credential_field: "roleArn",
                header_name: "x-onecli-aws-role-arn",
            },
            CredentialHeader {
                credential_field: "externalId",
                header_name: "x-onecli-aws-external-id",
            },
            CredentialHeader {
                credential_field: "region",
                header_name: "x-onecli-aws-assume-region",
            },
        ],
        credential_params: &[],
        host_rewrite: None,
        finalizer: Some(RequestFinalizer::AwsAssumeRole),
        body_transform: None,
    },
    AppProvider {
        provider: "datadog",
        display_name: "Datadog",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Suffix(".datadoghq.com"),
                path_prefix: None,
                strategy: AuthStrategy::None,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Suffix(".datadoghq.eu"),
                path_prefix: None,
                strategy: AuthStrategy::None,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Suffix(".ddog-gov.com"),
                path_prefix: None,
                strategy: AuthStrategy::None,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[
            CredentialHeader {
                credential_field: "apiKey",
                header_name: "DD-API-KEY",
            },
            CredentialHeader {
                credential_field: "appKey",
                header_name: "DD-APPLICATION-KEY",
            },
        ],
        credential_params: &[],
        host_rewrite: Some(&HostRewrite {
            credential_field: "site",
            template: datadog_host_for_site,
        }),
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "outlook-mail",
        display_name: "Outlook Mail",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/messages"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/mailFolders"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/sendMail"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/mailboxSettings"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/inferenceClassification"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/outlook"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/getMailTips"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/translateExchangeIds"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/contacts"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/contactFolders"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&MICROSOFT_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "outlook-calendar",
        display_name: "Outlook Calendar",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/calendar"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/events"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/findMeetingTimes"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/reminderView"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&MICROSOFT_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "microsoft-word",
        display_name: "Microsoft Word",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/drive"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/drives"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/sites"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/shares"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/followedSites"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&MICROSOFT_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "microsoft-onenote",
        display_name: "Microsoft OneNote",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/v1.0/me/onenote/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("graph.microsoft.com"),
                path_prefix: Some("/beta/me/onenote/"),
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&MICROSOFT_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "zoom",
        display_name: "Zoom",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.zoom.us"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&ZOOM_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "affinity",
        display_name: "Affinity",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.affinity.co"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("mcp.affinity.co"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "sentry",
        display_name: "Sentry",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("sentry.io"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Suffix(".sentry.io"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&SENTRY_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "granola",
        display_name: "Granola",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("public-api.granola.ai"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "hubspot",
        display_name: "HubSpot",
        host_rules: &[
            HostRule {
                pattern: HostPattern::Exact("api.hubapi.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
            HostRule {
                pattern: HostPattern::Exact("api.hubspot.com"),
                path_prefix: None,
                strategy: AuthStrategy::Bearer,
                intercept: false,
                credential_host_field: None,
            },
        ],
        refresh: Some(&HUBSPOT_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "linear",
        display_name: "Linear",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.linear.app"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&LINEAR_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "fathom",
        display_name: "Fathom",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.fathom.ai"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&FATHOM_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "attio",
        display_name: "Attio",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.attio.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        // Attio access tokens are non-expiring and there is no refresh grant.
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "x",
        display_name: "X",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.x.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&X_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "slack",
        display_name: "Slack",
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("slack.com"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "fireflies",
        display_name: "Fireflies",
        // One host rule with `path_prefix: None` injects the bearer key on every
        // path of api.fireflies.ai — covering both the GraphQL API (/graphql) and
        // the hosted MCP server (/mcp), which share the same API key.
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("api.fireflies.ai"),
            path_prefix: None,
            strategy: AuthStrategy::Bearer,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: None,
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
    AppProvider {
        provider: "zoho-crm",
        display_name: "Zoho CRM",
        // US data center only, by construction: the definition hardcodes
        // accounts.zoho.com and defaults api_domain to www.zohoapis.com.
        host_rules: &[HostRule {
            pattern: HostPattern::Exact("www.zohoapis.com"),
            path_prefix: None,
            strategy: AuthStrategy::ZohoOauthtoken,
            intercept: false,
            credential_host_field: None,
        }],
        refresh: Some(&ZOHO_CRM_REFRESH),
        metadata_headers: &[],
        credential_headers: &[],
        credential_params: &[],
        host_rewrite: None,
        finalizer: None,
        body_transform: None,
    },
];

// ── Public API ─────────────────────────────────────────────────────────

/// Iterate over all registered providers.
fn all_providers() -> impl Iterator<Item = &'static AppProvider> {
    APP_PROVIDERS.iter()
}

/// Return the request finalizer for the first matching provider, if any.
#[must_use]
pub fn finalizer_for_host(hostname: &str) -> Option<RequestFinalizer> {
    all_providers().find_map(|p| {
        p.host_rules
            .iter()
            .any(|r| host_rule_matches(r, hostname))
            .then_some(p.finalizer)
            .flatten()
    })
}

/// Return the request finalizer for a specific provider by ID.
#[must_use]
pub fn finalizer_for_provider(provider: &str) -> Option<RequestFinalizer> {
    all_providers().find_map(|p| (p.provider == provider).then_some(p.finalizer).flatten())
}

#[must_use]
pub fn body_transform_for_provider(provider: &str) -> Option<BodyTransform> {
    all_providers().find_map(|p| {
        (p.provider == provider)
            .then_some(p.body_transform)
            .flatten()
    })
}

/// Given a hostname, return the first matching provider's (id, display_name).
/// Returns `None` if no provider matches.
#[must_use]
pub fn provider_for_host(hostname: &str) -> Option<(&'static str, &'static str)> {
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
/// Falls back to the first host-only match only for dedicated subdomains; shared hosts
/// with path-scoped providers return `None` when no prefix matches.
#[must_use]
pub fn provider_for_host_and_path(
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

    // Fallback: host-only match for dedicated subdomains (e.g., gmail.googleapis.com).
    // Skip when the host has path-scoped providers (shared hosts like
    // www.googleapis.com) — the first match would be arbitrary and misleading.
    if host_has_path_scoped_providers(hostname) {
        return None;
    }
    provider_for_host(hostname)
}

/// Returns true when any provider registered for `hostname` uses path-prefix
/// scoped rules, indicating a shared host where the host-only fallback would
/// be ambiguous (e.g., `www.googleapis.com`).
pub fn host_has_path_scoped_providers(hostname: &str) -> bool {
    all_providers().any(|p| {
        p.host_rules
            .iter()
            .any(|r| host_rule_matches(r, hostname) && r.path_prefix.is_some())
    })
}

/// Given a hostname, return all provider names that have at least one host rule
/// matching it. Multiple providers can share the same host with different path
/// prefixes (e.g., Gmail on `/gmail/` and Calendar on `/calendar/`).
pub fn providers_for_host(hostname: &str) -> Vec<&'static str> {
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
pub fn path_pattern_for(provider: &str, hostname: &str) -> String {
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
pub fn build_app_injections(provider: &str, hostname: &str, token: &str) -> Vec<Injection> {
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
        AuthStrategy::ZohoOauthtoken => vec![Injection::SetHeader {
            name: "authorization".to_string(),
            value: format!("Zoho-oauthtoken {token}"),
        }],
        AuthStrategy::None => vec![],
    }
}

/// Build injection rules for all matching host rules of a provider on a given host.
/// Returns one `(path_pattern, injections)` pair per matching rule. This handles
/// providers with multiple rules on the same host (e.g., Google Drive has `/drive/`
/// and `/upload/drive/` on `www.googleapis.com`).
pub fn build_app_injection_rules(
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
                AuthStrategy::ZohoOauthtoken => vec![Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: format!("Zoho-oauthtoken {token}"),
                }],
                AuthStrategy::None => vec![],
            };
            (pattern, injections)
        })
        .collect()
}

/// Check if a specific provider has host rules matching both the hostname and path.
#[must_use]
pub fn provider_matches_host_and_path(provider: &str, hostname: &str, path: &str) -> bool {
    all_providers()
        .find(|p| p.provider == provider)
        .is_some_and(|app| {
            app.host_rules.iter().any(|r| {
                host_rule_matches(r, hostname)
                    && r.path_prefix.is_none_or(|pfx| path.starts_with(pfx))
            })
        })
}

/// Like [`provider_matches_host_and_path`], but matches ONLY through a
/// **path-scoped** host rule (`path_prefix` set and the request path under it) —
/// never a bare host/suffix rule. Path-scoped rules mark a legacy/mirror
/// endpoint of a specific API surface (e.g. Gmail's `www.googleapis.com/gmail/`
/// mirror of `gmail.googleapis.com`), so they are safe to fold into a
/// TOOL-scoped policy match; a broad credential-zone rule (e.g. AWS's bare
/// `*.amazonaws.com`) is deliberately excluded so a tool-scoped rule can't bleed
/// across sibling services on the same zone.
#[must_use]
pub fn provider_matches_path_scoped(provider: &str, hostname: &str, path: &str) -> bool {
    all_providers()
        .find(|p| p.provider == provider)
        .is_some_and(|app| {
            app.host_rules.iter().any(|r| {
                host_rule_matches(r, hostname)
                    && r.path_prefix.is_some_and(|pfx| path.starts_with(pfx))
            })
        })
}

/// Test helper: a representative `(provider, host, path)` for every host rule
/// that attaches a credential to a FORWARDED request — a concrete host matching
/// the rule's pattern and a path under its prefix. Excludes intercept rules
/// (synthetic-token, never forwarded) and per-tenant suffix rules gated on a
/// stored credential host — as SAMPLES only; the runtime matcher
/// (`provider_matches_host_and_path`) intentionally still covers those hosts, so
/// a whole-app rule governs them too (enforcement ⊇ injection, monotonic — a
/// per-tenant/intercept host can't be sampled statically, not that it's
/// unenforced). Backs the enforcement-⊇-injection invariant test.
///
/// Not `#[cfg(test)]`: the invariant test lives in the binary crate (beside
/// the catalog), and a dependency's `cfg(test)` is never active when a
/// dependent's tests compile. Hidden instead — test support, not API.
#[doc(hidden)]
pub fn injection_surface_samples() -> Vec<(&'static str, String, String)> {
    let mut out = Vec::new();
    for p in all_providers() {
        for r in p.host_rules {
            if r.intercept || r.credential_host_field.is_some() {
                continue;
            }
            let host = match r.pattern {
                HostPattern::Exact(h) => h.to_string(),
                HostPattern::Suffix(s) => format!("probe{s}"),
            };
            let path = r
                .path_prefix
                .map_or_else(|| "/".to_string(), |pfx| format!("{pfx}probe"));
            out.push((p.provider, host, path));
        }
    }
    out
}

/// Look up the display name for a provider slug (e.g., "jira" -> "Jira").
#[must_use]
pub fn display_name_for_provider(provider: &str) -> Option<&'static str> {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| p.display_name)
}

/// Get the refresh config for a provider, if it supports token refresh.
#[must_use]
pub fn refresh_config(provider: &str) -> Option<&'static RefreshConfig> {
    all_providers()
        .find(|p| p.provider == provider)
        .and_then(|p| p.refresh)
}

/// Get metadata-to-header mappings for a provider.
#[must_use]
pub fn metadata_headers(provider: &str) -> &'static [MetadataHeader] {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| p.metadata_headers)
        .unwrap_or(&[])
}

/// Get credential-to-header mappings for a provider.
#[must_use]
pub fn credential_headers(provider: &str) -> &'static [CredentialHeader] {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| p.credential_headers)
        .unwrap_or(&[])
}

/// Get credential-to-query-param mappings for a provider.
#[must_use]
pub fn credential_params(provider: &str) -> &'static [CredentialParam] {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| p.credential_params)
        .unwrap_or(&[])
}

/// Compute the rewritten upstream host for a provider based on credential fields.
/// Returns `None` if the provider has no host rewrite rule, the credential field is
/// missing, or the template declines to rewrite (e.g., MCP hosts that should pass through).
pub fn rewrite_host(
    provider: &str,
    creds: &serde_json::Value,
    original_host: &str,
) -> Option<String> {
    let app = all_providers().find(|p| p.provider == provider)?;
    let hw = app.host_rewrite?;
    let field_value = creds.get(hw.credential_field)?.as_str()?;
    (hw.template)(field_value, original_host)
}

/// Returns true if the provider has any host rule that injects an Authorization header.
/// Providers using only credential_headers (e.g., Datadog) return false.
pub fn needs_access_token(provider: &str) -> bool {
    all_providers()
        .find(|p| p.provider == provider)
        .map(|p| {
            p.host_rules
                .iter()
                .any(|r| !matches!(r.strategy, AuthStrategy::None))
        })
        .unwrap_or(false)
}

/// For a host-gated rule (e.g. JFrog's `*.jfrog.io`), return the credential
/// JSON field holding the connection's stored host. `None` when no matching
/// rule carries a host gate.
#[must_use]
pub fn credential_host_field(provider: &str, hostname: &str) -> Option<&'static str> {
    all_providers()
        .find(|p| p.provider == provider)
        .and_then(|p| {
            p.host_rules
                .iter()
                .find(|r| host_rule_matches(r, hostname))
                .and_then(|r| r.credential_host_field)
        })
}

/// Normalize a host for equality comparison: strip any `scheme://` prefix, cut
/// at the first path separator, drop a trailing `:port`, and lowercase.
/// Both the request host and the stored credential host are normalized before
/// comparison so `"https://MyCompany.JFrog.io/"` and `"mycompany.jfrog.io"` match.
#[must_use]
pub fn normalize_host(s: &str) -> String {
    let mut h = s.trim();
    if let Some(idx) = h.find("://") {
        h = &h[idx + 3..];
    }
    if let Some(idx) = h.find('/') {
        h = &h[..idx];
    }
    if let Some(idx) = h.find(':') {
        h = &h[..idx];
    }
    h.to_ascii_lowercase()
}

/// Check whether any provider matching this hostname has intercept rules.
/// Used to decide whether to pre-compute interception data at resolution time.
pub fn host_has_intercept_rules(hostname: &str) -> bool {
    all_providers().any(|p| {
        p.host_rules.iter().any(|r| r.intercept)
            && p.host_rules.iter().any(|r| host_rule_matches(r, hostname))
    })
}

/// Check whether a request should be intercepted with a synthetic token response.
/// Returns true when any provider has a host rule matching the hostname and path
/// with `intercept: true`.
pub fn is_intercept_target(hostname: &str, path: &str) -> bool {
    all_providers().any(|p| {
        p.host_rules.iter().any(|r| {
            r.intercept
                && host_rule_matches(r, hostname)
                && r.path_prefix.is_none_or(|pfx| path.starts_with(pfx))
        })
    })
}

/// Refresh an expired access token using the provider's token endpoint.
/// Returns (new_access_token, expires_at, optional_new_refresh_token).
///
/// Client credentials are resolved in order:
/// 1. Explicit `client_id`/`client_secret` (from BYOC AppConfig)
/// 2. Env vars from `RefreshConfig` (platform defaults)
pub async fn refresh_access_token(
    config: &RefreshConfig,
    refresh_token: &str,
    byoc_client_id: Option<&str>,
    byoc_client_secret: Option<&str>,
) -> anyhow::Result<(String, i64, Option<String>)> {
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

    let mut req = reqwest::Client::new().post(config.token_url);

    if matches!(config.client_auth, ClientCredentialMethod::BasicAuth) {
        let b64 = base64::engine::general_purpose::STANDARD;
        let encoded = b64.encode(format!("{client_id}:{client_secret}"));
        req = req.header("authorization", format!("Basic {encoded}"));
    }

    let req = match (&config.body_format, &config.client_auth) {
        (TokenBodyFormat::Form, ClientCredentialMethod::Body) => req.form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ]),
        (TokenBodyFormat::Json, ClientCredentialMethod::Body) => req.json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        })),
        (TokenBodyFormat::Form, ClientCredentialMethod::BasicAuth) => req.form(&[
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ]),
        (TokenBodyFormat::Json, ClientCredentialMethod::BasicAuth) => {
            req.json(&serde_json::json!({
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            }))
        }
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

    let new_refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs() as i64;

    Ok((access_token, now + expires_in, new_refresh_token))
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
pub async fn refresh_via_service_account(
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

/// Refresh an access token using the OAuth 2.0 client_credentials grant.
/// Used by providers like MongoDB Atlas Service Accounts that store a
/// client_id/client_secret pair and exchange them for short-lived Bearer tokens.
pub async fn refresh_via_client_credentials(
    token_url: &str,
    client_id: &str,
    client_secret: &str,
) -> anyhow::Result<(String, i64)> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut cred_buf = String::with_capacity(client_id.len() + 1 + client_secret.len());
    cred_buf.push_str(client_id);
    cred_buf.push(':');
    cred_buf.push_str(client_secret);
    let encoded = b64.encode(&cred_buf);

    let resp = reqwest::Client::new()
        .post(token_url)
        .header("Authorization", format!("Basic {encoded}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("client_credentials token request failed: {e}"))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("client_credentials token response parse failed: {e}"))?;

    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let error = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            anyhow::anyhow!("client_credentials token exchange failed: {error}")
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

/// Refresh an access token for a GitHub App installation.
/// Signs a JWT with RS256 using the app's private key, then exchanges it for
/// a short-lived installation access token (1h TTL).
pub async fn refresh_github_app_token(
    private_key_pem: &str,
    app_id: &str,
    installation_id: &str,
    repositories: Option<&[String]>,
) -> anyhow::Result<(String, i64)> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs() as i64;

    #[derive(serde::Serialize)]
    struct Claims {
        iss: String,
        iat: i64,
        exp: i64,
    }

    let claims = Claims {
        iss: app_id.to_string(),
        iat: now - 60,
        exp: now + 600,
    };

    let key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
        .map_err(|e| anyhow::anyhow!("invalid GitHub App private key: {e}"))?;

    let jwt = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|e| anyhow::anyhow!("GitHub App JWT signing failed: {e}"))?;

    let mut req = reqwest::Client::new()
        .post(format!(
            "https://api.github.com/app/installations/{installation_id}/access_tokens"
        ))
        .header("Authorization", format!("Bearer {jwt}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "onecli-gateway");

    if let Some(repos) = repositories {
        let bare_names: Vec<&str> = repos
            .iter()
            .map(|r| r.rsplit('/').next().unwrap_or(r.as_str()))
            .collect();
        req = req.json(&serde_json::json!({ "repositories": bare_names }));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("GitHub App token request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "GitHub App token exchange failed ({status}): {body}"
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("GitHub App token response parse failed: {e}"))?;

    let token = body
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("GitHub App token response missing 'token' field"))?
        .to_string();

    let expires_at_str = body
        .get("expires_at")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("GitHub App token response missing 'expires_at' field"))?;

    let expires_at = time::OffsetDateTime::parse(
        expires_at_str,
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|e| anyhow::anyhow!("failed to parse expires_at '{expires_at_str}': {e}"))?
    .unix_timestamp();

    Ok((token, expires_at))
}

/// Attempt to refresh credentials for a known credential type.
/// Returns `None` if the type is not recognized (falls through to standard OAuth refresh).
pub async fn try_refresh_credentials(
    cred_type: &str,
    creds: &serde_json::Value,
    _session_policy: Option<&serde_json::Value>,
) -> Option<anyhow::Result<(String, i64)>> {
    match cred_type {
        "github_app" => {
            let pk = creds.get("private_key").and_then(|v| v.as_str());
            let aid = creds.get("app_id").and_then(|v| v.as_str());
            let iid = creds.get("installation_id").and_then(|v| v.as_str());
            let (Some(pk), Some(aid), Some(iid)) = (pk, aid, iid) else {
                return Some(Err(anyhow::anyhow!(
                    "GitHub App credentials incomplete, cannot refresh"
                )));
            };
            Some(refresh_github_app_token(pk, aid, iid, None).await)
        }
        "service_account" => {
            let pk = creds.get("private_key").and_then(|v| v.as_str());
            let email = creds.get("client_email").and_then(|v| v.as_str());
            let (Some(pk), Some(email)) = (pk, email) else {
                return Some(Err(anyhow::anyhow!(
                    "service account credentials incomplete, cannot refresh"
                )));
            };
            Some(refresh_via_service_account(pk, email).await)
        }
        "client_credentials" => {
            let id = creds.get("client_id").and_then(|v| v.as_str());
            let secret = creds.get("client_secret").and_then(|v| v.as_str());
            let url = creds.get("token_url").and_then(|v| v.as_str());
            let (Some(id), Some(secret), Some(url)) = (id, secret, url) else {
                return Some(Err(anyhow::anyhow!(
                    "client_credentials incomplete, cannot refresh"
                )));
            };
            Some(refresh_via_client_credentials(url, id, secret).await)
        }
        "docker_hub" => {
            let username = creds.get("username").and_then(|v| v.as_str());
            let password = creds.get("password").and_then(|v| v.as_str());
            let (Some(username), Some(password)) = (username, password) else {
                return Some(Err(anyhow::anyhow!(
                    "Docker Hub credentials incomplete, cannot refresh"
                )));
            };
            Some(refresh_docker_hub_token(username, password).await)
        }
        _ => None,
    }
}

async fn refresh_docker_hub_token(username: &str, password: &str) -> anyhow::Result<(String, i64)> {
    let resp = reqwest::Client::new()
        .post("https://hub.docker.com/v2/users/login")
        .json(&serde_json::json!({
            "username": username,
            "password": password,
        }))
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Docker Hub login request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "Docker Hub login failed ({status}): {body}"
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("Docker Hub login response parse failed: {e}"))?;

    let token = body
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Docker Hub login response missing 'token' field"))?
        .to_string();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs() as i64;

    let expires_at = parse_jwt_exp(&token)
        .map(|exp| exp - 60)
        .unwrap_or(now + 3600);

    Ok((token, expires_at))
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_for_known_hosts() {
        let github_hosts = ["api.github.com", "github.com", "raw.githubusercontent.com"];
        for host in github_hosts {
            let providers = providers_for_host(host);
            assert!(
                providers.contains(&"github"),
                "{host}: expected github provider"
            );
        }
    }

    #[test]
    fn providers_for_unknown_host() {
        assert!(providers_for_host("api.openai.com").is_empty());
        assert!(providers_for_host("example.com").is_empty());
    }

    #[test]
    fn providers_for_googleapis_hosts() {
        assert_eq!(providers_for_host("gmail.googleapis.com"), vec!["gmail"]);
        // www.googleapis.com is shared — Gmail, Calendar, Drive, YouTube, and Search Console use path prefixes
        let www = providers_for_host("www.googleapis.com");
        assert!(www.contains(&"gmail"));
        assert!(www.contains(&"google-calendar"));
        assert!(www.contains(&"google-drive"));
        assert!(www.contains(&"youtube"));
        assert!(www.contains(&"google-search-console"));
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
            providers_for_host("people.googleapis.com"),
            vec!["google-contacts"]
        );
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

    // ── Google Search Console ────────────────────────────────────────

    #[test]
    fn google_search_console_path_disambiguation() {
        let result = provider_for_host_and_path(
            "www.googleapis.com",
            "/webmasters/v3/sites/sc-domain:onecli.sh/searchAnalytics/query",
        );
        assert_eq!(
            result,
            Some(("google-search-console", "Google Search Console"))
        );
    }

    #[test]
    fn google_search_console_produces_two_injection_rules() {
        let rules = build_app_injection_rules(
            "google-search-console",
            "www.googleapis.com",
            "ya29.gsc_test",
        );
        assert_eq!(
            rules.len(),
            1,
            "expected one rule for Search Console on www.googleapis.com"
        );

        let (pattern, injections) = &rules[0];
        assert_eq!(pattern, "/webmasters/*");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ya29.gsc_test".to_string(),
            }
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
            ("google-contacts", "people.googleapis.com"),
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
    fn atlassian_net_tenant_host_no_longer_matches() {
        let providers = providers_for_host("mysite.atlassian.net");
        assert!(
            providers.is_empty(),
            "*.atlassian.net should not match any provider (deprecated)"
        );
    }

    #[test]
    fn atlassian_net_tenant_host_produces_no_injections() {
        let injections = build_app_injections("jira", "mysite.atlassian.net", "eyJ0eXAi.test");
        assert!(
            injections.is_empty(),
            "*.atlassian.net should produce no injections (deprecated)"
        );
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

    // ── Stripe ────────────────────────────────────────────────────────

    #[test]
    fn provider_for_host_stripe() {
        let result = provider_for_host("api.stripe.com");
        assert_eq!(result, Some(("stripe", "Stripe")));
    }

    #[test]
    fn stripe_api_uses_bearer() {
        let injections = build_app_injections("stripe", "api.stripe.com", "rk_live_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer rk_live_test123".to_string(),
            }
        );
    }

    #[test]
    fn stripe_files_host_also_uses_bearer() {
        // The Files API lives on its own upload host and takes the same key.
        let injections = build_app_injections("stripe", "files.stripe.com", "rk_live_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer rk_live_test123".to_string(),
            }
        );
    }

    #[test]
    fn stripe_browser_facing_hosts_get_no_credentials() {
        // Only the two API hosts are registered. Stripe's browser-facing hosts
        // must never receive the secret key, and a lookalike suffix registered
        // by someone else must never match either.
        for host in [
            "dashboard.stripe.com",
            "checkout.stripe.com",
            "js.stripe.com",
            "connect.stripe.com",
            "stripe.com",
            "api.stripe.com.evil.example",
            "evilapi.stripe.com",
        ] {
            assert!(
                providers_for_host(host).is_empty(),
                "host {host} must not resolve to the stripe provider"
            );
        }
    }

    #[test]
    fn stripe_needs_access_token() {
        assert!(needs_access_token("stripe"));
    }

    #[test]
    fn stripe_has_no_refresh_config() {
        // API keys don't expire — there is no refresh flow to run.
        assert!(refresh_config("stripe").is_none());
    }

    // ── Vercel ────────────────────────────────────────────────────────

    #[test]
    fn provider_for_host_vercel() {
        let result = provider_for_host("api.vercel.com");
        assert_eq!(result, Some(("vercel", "Vercel")));
    }

    #[test]
    fn vercel_api_uses_bearer() {
        let injections = build_app_injections("vercel", "api.vercel.com", "vca_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer vca_test123".to_string(),
            }
        );
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

    // ── Cloudflare ─────────────────────────────────────────────────────

    #[test]
    fn providers_for_cloudflare_host() {
        assert_eq!(providers_for_host("api.cloudflare.com"), vec!["cloudflare"]);
    }

    #[test]
    fn cloudflare_api_uses_bearer() {
        let injections = build_app_injections("cloudflare", "api.cloudflare.com", "cfut_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer cfut_test123".to_string(),
            }
        );
    }

    // ── Notion ────────────────────────────────────────────────────────

    #[test]
    fn providers_for_notion_host() {
        assert_eq!(providers_for_host("api.notion.com"), vec!["notion"]);
    }

    #[test]
    fn provider_for_host_notion() {
        let result = provider_for_host("api.notion.com");
        assert_eq!(result, Some(("notion", "Notion")));
    }

    #[test]
    fn notion_api_uses_bearer() {
        let injections = build_app_injections("notion", "api.notion.com", "ntn_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ntn_test123".to_string(),
            }
        );
    }

    #[test]
    fn notion_refresh_uses_json_and_basic_auth() {
        let config = refresh_config("notion").expect("notion should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Json));
        assert!(matches!(
            config.client_auth,
            ClientCredentialMethod::BasicAuth
        ));
    }

    // ── AWS ──────────────────────────────────────────────────────────

    #[test]
    fn providers_for_aws_hosts() {
        let s3 = providers_for_host("s3.us-east-1.amazonaws.com");
        assert!(s3.contains(&"aws"), "expected aws provider for S3");

        let ec2 = providers_for_host("ec2.eu-west-1.amazonaws.com");
        assert!(ec2.contains(&"aws"), "expected aws provider for EC2");

        let lambda = providers_for_host("lambda.us-west-2.api.aws");
        assert!(lambda.contains(&"aws"), "expected aws provider for Lambda");
    }

    #[test]
    fn aws_no_false_positives() {
        assert!(providers_for_host("amazonaws.com").is_empty());
        assert!(providers_for_host("api.aws").is_empty());
    }

    #[test]
    fn aws_no_auth_header_injected() {
        let injections = build_app_injections("aws", "s3.us-east-1.amazonaws.com", "unused");
        assert!(
            injections.is_empty(),
            "AWS should not inject Authorization header"
        );
    }

    #[test]
    fn aws_credential_headers_defined() {
        let headers = credential_headers("aws");
        assert_eq!(headers.len(), 3);
        assert_eq!(headers[0].credential_field, "accessKeyId");
        assert_eq!(headers[0].header_name, "x-onecli-aws-access-key-id");
        assert_eq!(headers[1].credential_field, "secretAccessKey");
        assert_eq!(headers[1].header_name, "x-onecli-aws-secret-access-key");
        assert_eq!(headers[2].credential_field, "region");
        assert_eq!(headers[2].header_name, "x-onecli-aws-region");
    }

    #[test]
    fn aws_does_not_need_access_token() {
        assert!(!needs_access_token("aws"));
    }

    #[test]
    fn provider_for_host_aws() {
        let result = provider_for_host("s3.us-east-1.amazonaws.com");
        assert_eq!(result, Some(("aws", "AWS")));
    }

    #[test]
    fn finalizer_for_provider_aws() {
        assert_eq!(
            finalizer_for_provider("aws"),
            Some(RequestFinalizer::AwsSigV4)
        );
    }

    #[test]
    fn finalizer_for_provider_unknown() {
        assert_eq!(finalizer_for_provider("nonexistent"), None);
    }

    // ── MongoDB Atlas ─────────────────────────────────────────────────

    #[test]
    fn providers_for_mongodb_atlas_host() {
        assert_eq!(
            providers_for_host("cloud.mongodb.com"),
            vec!["mongodb-atlas"]
        );
    }

    #[test]
    fn provider_for_host_mongodb_atlas() {
        let result = provider_for_host("cloud.mongodb.com");
        assert_eq!(result, Some(("mongodb-atlas", "MongoDB Atlas")));
    }

    #[test]
    fn mongodb_atlas_api_uses_bearer() {
        let injections =
            build_app_injections("mongodb-atlas", "cloud.mongodb.com", "eyJtest.token");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer eyJtest.token".to_string(),
            }
        );
    }

    #[test]
    fn mongodb_atlas_has_no_refresh_config() {
        assert!(refresh_config("mongodb-atlas").is_none());
    }

    #[test]
    fn mongodb_atlas_needs_access_token() {
        assert!(needs_access_token("mongodb-atlas"));
    }

    #[test]
    fn mongodb_atlas_does_not_match_other_mongodb_hosts() {
        assert!(providers_for_host("mongodb.com").is_empty());
        assert!(providers_for_host("atlas.mongodb.com").is_empty());
    }

    // ── Docker Hub ────────────────────────────────────────────────────

    #[test]
    fn providers_for_docker_hub_host() {
        assert_eq!(providers_for_host("hub.docker.com"), vec!["docker"]);
    }

    #[test]
    fn provider_for_host_docker() {
        let result = provider_for_host("hub.docker.com");
        assert_eq!(result, Some(("docker", "Docker Hub")));
    }

    #[test]
    fn docker_api_uses_bearer() {
        let injections = build_app_injections("docker", "hub.docker.com", "eyJjwt_token_here");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer eyJjwt_token_here".to_string(),
            }
        );
    }

    #[test]
    fn docker_has_no_refresh_config() {
        assert!(refresh_config("docker").is_none());
    }

    #[test]
    fn docker_needs_access_token() {
        assert!(needs_access_token("docker"));
    }

    #[test]
    fn docker_does_not_match_other_docker_hosts() {
        assert!(providers_for_host("docker.com").is_empty());
        assert!(providers_for_host("registry.docker.com").is_empty());
        assert!(providers_for_host("index.docker.io").is_empty());
    }

    // ── Monday.com ────────────────────────────────────────────────────

    #[test]
    fn providers_for_monday_host() {
        assert_eq!(providers_for_host("api.monday.com"), vec!["monday"]);
    }

    #[test]
    fn provider_for_host_monday() {
        let result = provider_for_host("api.monday.com");
        assert_eq!(result, Some(("monday", "monday.com")));
    }

    #[test]
    fn monday_api_uses_bearer() {
        let injections = build_app_injections("monday", "api.monday.com", "test_token");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer test_token".to_string(),
            }
        );
    }

    #[test]
    fn monday_has_no_refresh_config() {
        assert!(refresh_config("monday").is_none());
    }

    #[test]
    fn monday_does_not_match_other_monday_hosts() {
        assert!(providers_for_host("monday.com").is_empty());
        assert!(providers_for_host("auth.monday.com").is_empty());
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
    fn provider_for_host_and_path_returns_none_for_unrecognized_path_on_shared_host() {
        // www.googleapis.com is a shared host — unrecognized API paths must
        // return None instead of falling back to the first match (Gmail).
        assert_eq!(
            provider_for_host_and_path("www.googleapis.com", "/some-unknown-api/v1/resource"),
            None
        );
    }

    // ── host_has_path_scoped_providers ─────────────────────────────────

    #[test]
    fn shared_host_is_path_scoped() {
        assert!(host_has_path_scoped_providers("www.googleapis.com"));
    }

    #[test]
    fn dedicated_subdomain_is_not_path_scoped() {
        assert!(!host_has_path_scoped_providers("gmail.googleapis.com"));
        assert!(!host_has_path_scoped_providers("api.github.com"));
    }

    #[test]
    fn unknown_host_is_not_path_scoped() {
        assert!(!host_has_path_scoped_providers("unknown.example.com"));
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

    // ── GitLab ────────────────────────────────────────────────────────

    #[test]
    fn provider_for_host_gitlab() {
        let result = provider_for_host("gitlab.com");
        assert_eq!(result, Some(("gitlab", "GitLab")));
    }

    #[test]
    fn gitlab_api_uses_bearer() {
        let injections = build_app_injections("gitlab", "gitlab.com", "glpat-test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer glpat-test123".to_string(),
            }
        );
    }

    #[test]
    fn gitlab_refresh_uses_form_body_format() {
        let config = refresh_config("gitlab").expect("gitlab should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
    }

    #[test]
    fn provider_for_host_trello() {
        assert_eq!(
            provider_for_host("api.trello.com"),
            Some(("trello", "Trello"))
        );
    }

    #[test]
    fn trello_uses_query_param_injection() {
        let rules = build_app_injection_rules("trello", "api.trello.com", "");
        assert_eq!(rules.len(), 1);
        let (pattern, injections) = &rules[0];
        assert_eq!(pattern, "*");
        // AuthStrategy::None produces no injections — params come from credential_params
        assert!(injections.is_empty());
    }

    #[test]
    fn trello_credential_params_defined() {
        let params = credential_params("trello");
        assert_eq!(params.len(), 2);
        assert_eq!(params[0].credential_field, "apiKey");
        assert_eq!(params[0].param_name, "key");
        assert_eq!(params[1].credential_field, "access_token");
        assert_eq!(params[1].param_name, "token");
    }

    #[test]
    fn trello_no_refresh() {
        assert!(refresh_config("trello").is_none());
    }

    // ── provider_matches_host_and_path ────────────────────────────────

    #[test]
    fn provider_matches_jira_unique_path() {
        assert!(provider_matches_host_and_path(
            "jira",
            "api.atlassian.com",
            "/ex/jira/rest/api/3/issue"
        ));
    }

    #[test]
    fn provider_matches_jira_shared_path() {
        assert!(provider_matches_host_and_path(
            "jira",
            "api.atlassian.com",
            "/oauth/token/accessible-resources"
        ));
    }

    #[test]
    fn provider_matches_confluence_shared_path() {
        assert!(provider_matches_host_and_path(
            "confluence",
            "api.atlassian.com",
            "/oauth/token/accessible-resources"
        ));
    }

    #[test]
    fn provider_does_not_match_wrong_path() {
        assert!(!provider_matches_host_and_path(
            "jira",
            "api.atlassian.com",
            "/ex/confluence/wiki/rest/api"
        ));
    }

    #[test]
    fn provider_does_not_match_wrong_host() {
        assert!(!provider_matches_host_and_path(
            "jira",
            "api.github.com",
            "/ex/jira/rest/api/3/issue"
        ));
    }

    // ── display_name_for_provider ─────────────────────────────────────

    #[test]
    fn display_name_for_known_providers() {
        assert_eq!(display_name_for_provider("jira"), Some("Jira"));
        assert_eq!(display_name_for_provider("confluence"), Some("Confluence"));
        assert_eq!(display_name_for_provider("gmail"), Some("Gmail"));
        assert_eq!(display_name_for_provider("github"), Some("GitHub"));
    }

    #[test]
    fn display_name_for_unknown_provider() {
        assert_eq!(display_name_for_provider("nonexistent"), None);
    }

    // ── JFrog Artifactory ─────────────────────────────────────────────

    #[test]
    fn providers_for_jfrog_host() {
        assert_eq!(
            providers_for_host("mycompany.jfrog.io"),
            vec!["jfrog-artifactory"]
        );
    }

    #[test]
    fn provider_for_host_jfrog() {
        let result = provider_for_host("mycompany.jfrog.io");
        assert_eq!(result, Some(("jfrog-artifactory", "JFrog Artifactory")));
    }

    #[test]
    fn jfrog_suffix_no_false_positives() {
        // The bare apex must NOT match (suffix requires something before it).
        assert!(providers_for_host("jfrog.io").is_empty());
        assert!(providers_for_host(".jfrog.io").is_empty());
    }

    #[test]
    fn jfrog_other_tenant_still_matches_provider_statically() {
        // Any *.jfrog.io matches the provider at the static level — the
        // per-connection host gate in connect.rs is what blocks injection to
        // tenants other than the connection's stored subdomain.
        assert_eq!(
            providers_for_host("evil.jfrog.io"),
            vec!["jfrog-artifactory"]
        );
    }

    #[test]
    fn jfrog_uses_bearer() {
        let injections = build_app_injections("jfrog-artifactory", "mycompany.jfrog.io", "t");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer t".to_string(),
            }
        );
    }

    #[test]
    fn jfrog_needs_access_token() {
        assert!(needs_access_token("jfrog-artifactory"));
    }

    #[test]
    fn jfrog_has_no_refresh_config() {
        assert!(refresh_config("jfrog-artifactory").is_none());
    }

    // ── Snowflake ─────────────────────────────────────────────────────

    #[test]
    fn providers_for_snowflake_host() {
        assert_eq!(
            providers_for_host("myorg-myaccount.snowflakecomputing.com"),
            vec!["snowflake"]
        );
    }

    #[test]
    fn provider_for_host_snowflake() {
        let result = provider_for_host("myorg-myaccount.snowflakecomputing.com");
        assert_eq!(result, Some(("snowflake", "Snowflake")));
    }

    #[test]
    fn snowflake_suffix_no_false_positives() {
        // The bare apex must NOT match (suffix requires something before it),
        // and neither may a lookalike domain that merely ends with the text.
        assert!(providers_for_host("snowflakecomputing.com").is_empty());
        assert!(providers_for_host(".snowflakecomputing.com").is_empty());
        assert!(providers_for_host("evilsnowflakecomputing.com").is_empty());
    }

    #[test]
    fn snowflake_other_tenant_still_matches_provider_statically() {
        // Any *.snowflakecomputing.com matches the provider at the static
        // level — the per-connection host gate in connect.rs is what blocks
        // injection to tenants other than the connection's stored host.
        assert_eq!(
            providers_for_host("evil-tenant.snowflakecomputing.com"),
            vec!["snowflake"]
        );
    }

    #[test]
    fn snowflake_uses_bearer() {
        let injections =
            build_app_injections("snowflake", "myorg-myaccount.snowflakecomputing.com", "pat");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer pat".to_string(),
            }
        );
    }

    #[test]
    fn snowflake_needs_access_token() {
        assert!(needs_access_token("snowflake"));
    }

    #[test]
    fn snowflake_has_no_refresh_config() {
        assert!(refresh_config("snowflake").is_none());
    }

    #[test]
    fn snowflake_has_credential_host_field() {
        assert_eq!(
            credential_host_field("snowflake", "myorg-myaccount.snowflakecomputing.com"),
            Some("host")
        );
    }

    // ── credential_host_field ─────────────────────────────────────────

    #[test]
    fn jfrog_has_credential_host_field() {
        assert_eq!(
            credential_host_field("jfrog-artifactory", "mycompany.jfrog.io"),
            Some("subdomain")
        );
    }

    #[test]
    fn normal_providers_have_no_credential_host_field() {
        assert_eq!(credential_host_field("github", "api.github.com"), None);
        assert_eq!(credential_host_field("resend", "api.resend.com"), None);
        assert_eq!(credential_host_field("nonexistent", "anything.com"), None);
    }

    // ── normalize_host ────────────────────────────────────────────────

    #[test]
    fn normalize_host_passthrough() {
        assert_eq!(normalize_host("mycompany.jfrog.io"), "mycompany.jfrog.io");
    }

    #[test]
    fn normalize_host_strips_scheme_path_port_and_lowercases() {
        assert_eq!(
            normalize_host("https://MyCompany.JFrog.io/artifactory/api"),
            "mycompany.jfrog.io"
        );
        assert_eq!(
            normalize_host("mycompany.jfrog.io:443"),
            "mycompany.jfrog.io"
        );
        assert_eq!(
            normalize_host("  HTTP://MYCOMPANY.JFROG.IO  "),
            "mycompany.jfrog.io"
        );
        assert_eq!(normalize_host("mycompany.jfrog.io/"), "mycompany.jfrog.io");
    }

    #[test]
    fn normalize_host_empty() {
        assert_eq!(normalize_host(""), "");
    }

    // ── Slack ─────────────────────────────────────────────────────

    #[test]
    fn providers_for_slack_host() {
        assert_eq!(providers_for_host("slack.com"), vec!["slack"]);
    }

    #[test]
    fn provider_for_host_slack() {
        let result = provider_for_host("slack.com");
        assert_eq!(result, Some(("slack", "Slack")));
    }

    #[test]
    fn slack_api_uses_bearer() {
        let injections = build_app_injections("slack", "slack.com", "xoxb-test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer xoxb-test123".to_string(),
            }
        );
    }

    #[test]
    fn slack_has_no_refresh_config() {
        assert!(refresh_config("slack").is_none());
    }

    #[test]
    fn slack_does_not_match_other_slack_hosts() {
        assert!(providers_for_host("api.slack.com").is_empty());
        assert!(providers_for_host("www.slack.com").is_empty());
    }

    // ── Zoom ──────────────────────────────────────────────────────

    #[test]
    fn providers_for_zoom_host() {
        assert_eq!(providers_for_host("api.zoom.us"), vec!["zoom"]);
    }

    #[test]
    fn provider_for_host_zoom() {
        let result = provider_for_host("api.zoom.us");
        assert_eq!(result, Some(("zoom", "Zoom")));
    }

    #[test]
    fn zoom_api_uses_bearer() {
        let injections = build_app_injections("zoom", "api.zoom.us", "eyJ0eXAi.zoom_test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer eyJ0eXAi.zoom_test".to_string(),
            }
        );
    }

    #[test]
    fn zoom_refresh_uses_form_and_basic_auth() {
        let config = refresh_config("zoom").expect("zoom should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
        assert!(matches!(
            config.client_auth,
            ClientCredentialMethod::BasicAuth
        ));
    }

    #[test]
    fn zoom_needs_access_token() {
        assert!(needs_access_token("zoom"));
    }

    #[test]
    fn zoom_no_false_positives() {
        assert!(providers_for_host("zoom.us").is_empty());
        assert!(providers_for_host("www.zoom.us").is_empty());
    }

    // ── LinkedIn ──────────────────────────────────────────────────

    #[test]
    fn providers_for_linkedin_host() {
        assert_eq!(providers_for_host("api.linkedin.com"), vec!["linkedin"]);
    }

    #[test]
    fn provider_for_host_linkedin() {
        let result = provider_for_host("api.linkedin.com");
        assert_eq!(result, Some(("linkedin", "LinkedIn")));
    }

    #[test]
    fn linkedin_api_uses_bearer() {
        let injections = build_app_injections("linkedin", "api.linkedin.com", "AQXNnd2kXITHE.test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer AQXNnd2kXITHE.test".to_string(),
            }
        );
    }

    #[test]
    fn linkedin_has_refresh_config() {
        let cfg = refresh_config("linkedin").expect("linkedin should have refresh config");
        assert_eq!(
            cfg.token_url,
            "https://www.linkedin.com/oauth/v2/accessToken"
        );
    }

    #[test]
    fn linkedin_needs_access_token() {
        assert!(needs_access_token("linkedin"));
    }

    #[test]
    fn linkedin_no_false_positives() {
        assert!(providers_for_host("linkedin.com").is_empty());
        assert!(providers_for_host("www.linkedin.com").is_empty());
    }

    // ── Supabase ──────────────────────────────────────────────────

    #[test]
    fn providers_for_supabase_host() {
        assert_eq!(providers_for_host("api.supabase.com"), vec!["supabase"]);
    }

    #[test]
    fn provider_for_host_supabase() {
        let result = provider_for_host("api.supabase.com");
        assert_eq!(result, Some(("supabase", "Supabase")));
    }

    #[test]
    fn supabase_api_uses_bearer() {
        let injections = build_app_injections("supabase", "api.supabase.com", "sbp_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer sbp_test123".to_string(),
            }
        );
    }

    #[test]
    fn supabase_refresh_uses_form_and_basic_auth() {
        let config = refresh_config("supabase").expect("supabase should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
        assert!(matches!(
            config.client_auth,
            ClientCredentialMethod::BasicAuth
        ));
    }

    #[test]
    fn supabase_no_false_positives() {
        assert!(providers_for_host("supabase.com").is_empty());
        assert!(providers_for_host("www.supabase.com").is_empty());
    }

    // ── Affinity ──────────────────────────────────────────────────

    #[test]
    fn providers_for_affinity_api_host() {
        assert_eq!(providers_for_host("api.affinity.co"), vec!["affinity"]);
    }

    #[test]
    fn providers_for_affinity_mcp_host() {
        assert_eq!(providers_for_host("mcp.affinity.co"), vec!["affinity"]);
    }

    #[test]
    fn provider_for_host_affinity_api() {
        let result = provider_for_host("api.affinity.co");
        assert_eq!(result, Some(("affinity", "Affinity")));
    }

    #[test]
    fn provider_for_host_affinity_mcp() {
        let result = provider_for_host("mcp.affinity.co");
        assert_eq!(result, Some(("affinity", "Affinity")));
    }

    #[test]
    fn affinity_api_uses_bearer() {
        let injections = build_app_injections("affinity", "api.affinity.co", "test_api_key");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer test_api_key".to_string(),
            }
        );
    }

    #[test]
    fn affinity_mcp_uses_bearer() {
        let injections = build_app_injections("affinity", "mcp.affinity.co", "test_api_key");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer test_api_key".to_string(),
            }
        );
    }

    #[test]
    fn affinity_has_no_refresh_config() {
        assert!(refresh_config("affinity").is_none());
    }

    #[test]
    fn affinity_needs_access_token() {
        assert!(needs_access_token("affinity"));
    }

    #[test]
    fn affinity_no_false_positives() {
        assert!(providers_for_host("affinity.co").is_empty());
        assert!(providers_for_host("www.affinity.co").is_empty());
    }

    // ── Datadog ──────────────────────────────────────────────────

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
    fn providers_for_datadog_mcp_hosts() {
        assert_eq!(providers_for_host("mcp.datadoghq.com"), vec!["datadog"]);
        assert_eq!(providers_for_host("mcp.datadoghq.eu"), vec!["datadog"]);
        assert_eq!(providers_for_host("mcp.ddog-gov.com"), vec!["datadog"]);
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
    fn datadog_rewrite_host_api() {
        let creds = serde_json::json!({"site": "us5", "apiKey": "k", "appKey": "a"});
        assert_eq!(
            rewrite_host("datadog", &creds, "api.datadoghq.com"),
            Some("api.us5.datadoghq.com".to_string()),
        );
    }

    #[test]
    fn datadog_rewrite_host_mcp() {
        let creds = serde_json::json!({"site": "us5", "apiKey": "k", "appKey": "a"});
        assert_eq!(
            rewrite_host("datadog", &creds, "mcp.datadoghq.com"),
            Some("mcp.us5.datadoghq.com".to_string()),
        );
    }

    #[test]
    fn datadog_rewrite_host_mcp_us1_unchanged() {
        let creds = serde_json::json!({"site": "us1", "apiKey": "k", "appKey": "a"});
        assert_eq!(
            rewrite_host("datadog", &creds, "mcp.datadoghq.com"),
            Some("mcp.datadoghq.com".to_string()),
        );
    }

    #[test]
    fn datadog_rewrite_host_eu() {
        let creds = serde_json::json!({"site": "eu", "apiKey": "k", "appKey": "a"});
        assert_eq!(
            rewrite_host("datadog", &creds, "api.datadoghq.com"),
            Some("api.datadoghq.eu".to_string()),
        );
        assert_eq!(
            rewrite_host("datadog", &creds, "mcp.datadoghq.com"),
            Some("mcp.datadoghq.eu".to_string()),
        );
    }

    #[test]
    fn datadog_rewrite_host_compound_subdomain() {
        let creds = serde_json::json!({"site": "us5", "apiKey": "k", "appKey": "a"});
        assert_eq!(
            rewrite_host("datadog", &creds, "http-intake.logs.us5.datadoghq.com"),
            Some("http-intake.logs.us5.datadoghq.com".to_string()),
        );
    }

    #[test]
    fn datadog_rewrite_host_compound_subdomain_generic() {
        let creds = serde_json::json!({"site": "us5", "apiKey": "k", "appKey": "a"});
        assert_eq!(
            rewrite_host("datadog", &creds, "http-intake.logs.datadoghq.com"),
            Some("http-intake.logs.us5.datadoghq.com".to_string()),
        );
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

    // ── AWS Role ──────────────────────────────────────────────────

    #[test]
    fn finalizer_for_provider_aws_role() {
        assert_eq!(
            finalizer_for_provider("aws-role"),
            Some(RequestFinalizer::AwsAssumeRole)
        );
    }

    #[test]
    fn aws_role_not_shadowed_by_aws_in_host_lookup() {
        let host_finalizer = finalizer_for_host("s3.us-east-1.amazonaws.com");
        let role_finalizer = finalizer_for_provider("aws-role");
        assert_eq!(
            host_finalizer,
            Some(RequestFinalizer::AwsSigV4),
            "host lookup returns AwsSigV4 (first match)"
        );
        assert_eq!(
            role_finalizer,
            Some(RequestFinalizer::AwsAssumeRole),
            "provider lookup returns AwsAssumeRole (connection-aware)"
        );
    }

    // ── Microsoft OneNote ─────────────────────────────────────────

    #[test]
    fn providers_for_microsoft_onenote_host() {
        let providers = providers_for_host("graph.microsoft.com");
        assert!(
            providers.contains(&"microsoft-onenote"),
            "expected microsoft-onenote provider for graph.microsoft.com"
        );
    }

    #[test]
    fn microsoft_onenote_path_disambiguation() {
        use crate::provider_for_host_and_path;
        let result =
            provider_for_host_and_path("graph.microsoft.com", "/v1.0/me/onenote/notebooks");
        assert_eq!(result, Some(("microsoft-onenote", "Microsoft OneNote")));
    }

    #[test]
    fn microsoft_onenote_beta_path() {
        use crate::provider_for_host_and_path;
        let result = provider_for_host_and_path(
            "graph.microsoft.com",
            "/beta/me/onenote/pages/abc123/content",
        );
        assert_eq!(result, Some(("microsoft-onenote", "Microsoft OneNote")));
    }

    #[test]
    fn microsoft_onenote_uses_bearer() {
        let injections = build_app_injections(
            "microsoft-onenote",
            "graph.microsoft.com",
            "eyJ0eXAi.onenote_test",
        );
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer eyJ0eXAi.onenote_test".to_string(),
            }
        );
    }

    #[test]
    fn microsoft_onenote_has_refresh_config() {
        let cfg = refresh_config("microsoft-onenote")
            .expect("microsoft-onenote should have refresh config");
        assert_eq!(
            cfg.token_url,
            "https://login.microsoftonline.com/common/oauth2/v2.0/token"
        );
    }

    #[test]
    fn microsoft_onenote_no_conflict_with_outlook_mail() {
        use crate::provider_for_host_and_path;
        let result = provider_for_host_and_path("graph.microsoft.com", "/v1.0/me/messages/abc123");
        assert_eq!(result, Some(("outlook-mail", "Outlook Mail")));
    }

    #[test]
    fn microsoft_onenote_no_conflict_with_outlook_calendar() {
        use crate::provider_for_host_and_path;
        let result = provider_for_host_and_path("graph.microsoft.com", "/v1.0/me/events/abc123");
        assert_eq!(result, Some(("outlook-calendar", "Outlook Calendar")));
    }

    // ── Dropbox ──────────────────────────────────────────────────

    #[test]
    fn providers_for_dropbox_api_host() {
        assert_eq!(providers_for_host("api.dropboxapi.com"), vec!["dropbox"]);
    }

    #[test]
    fn providers_for_dropbox_content_host() {
        assert_eq!(
            providers_for_host("content.dropboxapi.com"),
            vec!["dropbox"]
        );
    }

    #[test]
    fn provider_for_host_dropbox() {
        let result = provider_for_host("api.dropboxapi.com");
        assert_eq!(result, Some(("dropbox", "Dropbox")));
    }

    #[test]
    fn dropbox_api_uses_bearer() {
        let injections = build_app_injections("dropbox", "api.dropboxapi.com", "sl.test_token_abc");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer sl.test_token_abc".to_string(),
            }
        );
    }

    #[test]
    fn dropbox_content_uses_bearer() {
        let injections =
            build_app_injections("dropbox", "content.dropboxapi.com", "sl.test_token_abc");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer sl.test_token_abc".to_string(),
            }
        );
    }

    #[test]
    fn dropbox_refresh_uses_form_body_format() {
        let config = refresh_config("dropbox").expect("dropbox should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
        assert!(matches!(config.client_auth, ClientCredentialMethod::Body));
    }

    // ── Fly.io ──────────────────────────────────────────────────

    #[test]
    fn providers_for_flyio_machines_host() {
        assert_eq!(providers_for_host("api.machines.dev"), vec!["flyio"]);
    }

    #[test]
    fn providers_for_flyio_graphql_host() {
        assert_eq!(providers_for_host("api.fly.io"), vec!["flyio"]);
    }

    #[test]
    fn flyio_machines_api_uses_bearer() {
        let injections = build_app_injections("flyio", "api.machines.dev", "FlyV1 fm2_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer FlyV1 fm2_test123".to_string(),
            }
        );
    }

    #[test]
    fn flyio_graphql_api_uses_bearer() {
        let injections = build_app_injections("flyio", "api.fly.io", "FlyV1 fm2_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer FlyV1 fm2_test123".to_string(),
            }
        );
    }

    #[test]
    fn provider_for_host_flyio() {
        let result = provider_for_host("api.machines.dev");
        assert_eq!(result, Some(("flyio", "Fly.io")));
    }

    // ── Sentry ───────────────────────────────────────────────────

    #[test]
    fn providers_for_sentry_host() {
        assert_eq!(providers_for_host("sentry.io"), vec!["sentry"]);
    }

    #[test]
    fn providers_for_sentry_regional_hosts() {
        assert_eq!(providers_for_host("us.sentry.io"), vec!["sentry"]);
        assert_eq!(providers_for_host("de.sentry.io"), vec!["sentry"]);
    }

    #[test]
    fn sentry_suffix_no_false_positives() {
        assert!(providers_for_host(".sentry.io").is_empty());
    }

    #[test]
    fn provider_for_host_sentry() {
        let result = provider_for_host("sentry.io");
        assert_eq!(result, Some(("sentry", "Sentry")));
    }

    #[test]
    fn provider_for_host_sentry_regional() {
        let result = provider_for_host("us.sentry.io");
        assert_eq!(result, Some(("sentry", "Sentry")));
    }

    #[test]
    fn sentry_api_uses_bearer() {
        let injections = build_app_injections("sentry", "sentry.io", "test_token_abc");
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
    fn sentry_regional_api_uses_bearer() {
        let injections = build_app_injections("sentry", "us.sentry.io", "test_token_abc");
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
    fn sentry_refresh_uses_form_body_format() {
        let config = refresh_config("sentry").expect("sentry should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
    }

    // ── Granola ──────────────────────────────────────────────────────

    #[test]
    fn providers_for_granola_host() {
        assert_eq!(providers_for_host("public-api.granola.ai"), vec!["granola"]);
    }

    #[test]
    fn granola_api_uses_bearer() {
        let injections = build_app_injections("granola", "public-api.granola.ai", "grn_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer grn_test123".to_string(),
            }
        );
    }

    #[test]
    fn granola_has_no_refresh_config() {
        assert!(refresh_config("granola").is_none());
    }

    #[test]
    fn granola_no_false_positives() {
        assert!(providers_for_host("granola.ai").is_empty());
        assert!(providers_for_host("www.granola.ai").is_empty());
    }

    // ── Fireflies ──────────────────────────────────────────────────────

    #[test]
    fn providers_for_fireflies_host() {
        assert_eq!(providers_for_host("api.fireflies.ai"), vec!["fireflies"]);
    }

    #[test]
    fn providers_for_zoho_crm_host() {
        assert_eq!(providers_for_host("www.zohoapis.com"), vec!["zoho-crm"]);
    }

    #[test]
    fn zoho_crm_injects_its_oauthtoken_scheme() {
        let rules = build_app_injection_rules("zoho-crm", "www.zohoapis.com", "tok-1");
        assert_eq!(rules.len(), 1);
        match &rules[0].1[..] {
            [Injection::SetHeader { name, value }] => {
                assert_eq!(name, "authorization");
                assert_eq!(value, "Zoho-oauthtoken tok-1");
            }
            other => panic!("expected one auth header injection, got {other:?}"),
        }
    }

    #[test]
    fn zoho_crm_refresh_uses_form_body_credentials() {
        let config = refresh_config("zoho-crm").expect("zoho-crm should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
        assert!(matches!(config.client_auth, ClientCredentialMethod::Body));
    }

    #[test]
    fn provider_for_host_fireflies() {
        let result = provider_for_host("api.fireflies.ai");
        assert_eq!(result, Some(("fireflies", "Fireflies")));
    }

    #[test]
    fn fireflies_api_uses_bearer() {
        let injections = build_app_injections("fireflies", "api.fireflies.ai", "ff_test123");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ff_test123".to_string(),
            }
        );
    }

    #[test]
    fn fireflies_has_no_refresh_config() {
        assert!(refresh_config("fireflies").is_none());
    }

    #[test]
    fn fireflies_injects_on_both_graphql_and_mcp() {
        // A single host rule (path_prefix: None) covers both API surfaces.
        assert!(provider_matches_host_and_path(
            "fireflies",
            "api.fireflies.ai",
            "/graphql"
        ));
        assert!(provider_matches_host_and_path(
            "fireflies",
            "api.fireflies.ai",
            "/mcp"
        ));
    }

    // ── HubSpot ─────────────────────────────────────────────────────

    #[test]
    fn providers_for_hubspot_legacy_host() {
        assert_eq!(providers_for_host("api.hubapi.com"), vec!["hubspot"]);
    }

    #[test]
    fn providers_for_hubspot_new_host() {
        assert_eq!(providers_for_host("api.hubspot.com"), vec!["hubspot"]);
    }

    #[test]
    fn provider_for_host_hubspot() {
        let result = provider_for_host("api.hubapi.com");
        assert_eq!(result, Some(("hubspot", "HubSpot")));
    }

    #[test]
    fn hubspot_api_uses_bearer() {
        let injections = build_app_injections("hubspot", "api.hubapi.com", "test_token_abc");
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
    fn hubspot_new_host_uses_bearer() {
        let injections = build_app_injections("hubspot", "api.hubspot.com", "test_token_abc");
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
    fn hubspot_refresh_uses_form_body_format() {
        let config = refresh_config("hubspot").expect("hubspot should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
    }

    // ── Linear ───────────────────────────────────────────────────────

    #[test]
    fn providers_for_linear_host() {
        assert_eq!(providers_for_host("api.linear.app"), vec!["linear"]);
    }

    #[test]
    fn provider_for_host_linear() {
        let result = provider_for_host("api.linear.app");
        assert_eq!(result, Some(("linear", "Linear")));
    }

    #[test]
    fn linear_api_uses_bearer() {
        let injections = build_app_injections("linear", "api.linear.app", "lin_oauth_test");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer lin_oauth_test".to_string(),
            }
        );
    }

    #[test]
    fn linear_refresh_uses_form_body_format() {
        let config = refresh_config("linear").expect("linear should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
    }

    #[test]
    fn linear_does_not_match_other_linear_hosts() {
        assert!(providers_for_host("linear.app").is_empty());
        assert!(providers_for_host("linear.com").is_empty());
    }

    // ── Fathom ──────────────────────────────────────────────────────

    #[test]
    fn providers_for_fathom_host() {
        assert_eq!(providers_for_host("api.fathom.ai"), vec!["fathom"]);
    }

    #[test]
    fn provider_for_host_fathom() {
        let result = provider_for_host("api.fathom.ai");
        assert_eq!(result, Some(("fathom", "Fathom")));
    }

    #[test]
    fn fathom_api_uses_bearer() {
        let injections = build_app_injections("fathom", "api.fathom.ai", "test_token_abc");
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
    fn fathom_refresh_uses_form_body_format() {
        let config = refresh_config("fathom").expect("fathom should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
        assert!(matches!(config.client_auth, ClientCredentialMethod::Body));
    }

    #[test]
    fn fathom_needs_access_token() {
        assert!(needs_access_token("fathom"));
    }

    #[test]
    fn fathom_no_false_positives() {
        assert!(providers_for_host("fathom.ai").is_empty());
        assert!(providers_for_host("fathom.video").is_empty());
        assert!(providers_for_host("www.fathom.ai").is_empty());
    }

    // ── Attio ─────────────────────────────────────────────────────────

    #[test]
    fn providers_for_attio_host() {
        assert_eq!(providers_for_host("api.attio.com"), vec!["attio"]);
    }

    #[test]
    fn provider_for_host_attio() {
        let result = provider_for_host("api.attio.com");
        assert_eq!(result, Some(("attio", "Attio")));
    }

    #[test]
    fn attio_api_uses_bearer() {
        let injections = build_app_injections("attio", "api.attio.com", "test_token");
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer test_token".to_string(),
            }
        );
    }

    #[test]
    fn attio_does_not_match_other_attio_hosts() {
        assert!(providers_for_host("attio.com").is_empty());
        assert!(providers_for_host("app.attio.com").is_empty());
    }

    // ── X (Twitter) ─────────────────────────────────────────────────

    #[test]
    fn providers_for_x_api_host() {
        assert_eq!(providers_for_host("api.x.com"), vec!["x"]);
    }

    #[test]
    fn provider_for_host_x() {
        let result = provider_for_host("api.x.com");
        assert_eq!(result, Some(("x", "X")));
    }

    #[test]
    fn x_api_uses_bearer() {
        let injections = build_app_injections("x", "api.x.com", "test_token_abc");
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
    fn x_refresh_uses_form_and_basic_auth() {
        let config = refresh_config("x").expect("x should have refresh config");
        assert!(matches!(config.body_format, TokenBodyFormat::Form));
        assert!(matches!(
            config.client_auth,
            ClientCredentialMethod::BasicAuth
        ));
    }

    #[test]
    fn x_needs_access_token() {
        assert!(needs_access_token("x"));
    }

    #[test]
    fn x_no_false_positives() {
        assert!(providers_for_host("x.com").is_empty());
        assert!(providers_for_host("twitter.com").is_empty());
        assert!(providers_for_host("www.twitter.com").is_empty());
    }
}
