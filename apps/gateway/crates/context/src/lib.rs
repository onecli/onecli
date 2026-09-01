//! Shared server context: the state handed to every request handler and the
//! per-tunnel proxy context.
//!
//! Lives outside the `gateway` server module so feature code (`ee/`) and the
//! control-plane routes can name these types without depending on the server
//! itself — the direction the crate DAG enforces.

pub mod auth;

use std::pin::Pin;
use std::sync::Arc;

use http_body_util::{Either, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use tokio_rustls::TlsConnector;

use approval::ApprovalStore;
use ca::CertificateAuthority;
use cache::CacheStore;
use crypto::CryptoService;
use vault::onepassword::OnePasswordVaultProvider;

/// Context for a proxied request, resolved at CONNECT time.
/// Wrapped in `Arc` and shared across all requests within a MITM session.
#[derive(Debug)]
pub struct ProxyContext {
    pub workspace_id: Option<String>,
    pub organization_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub agent_identifier: Option<String>,
    /// The proxy credential this session authenticated with. Always present:
    /// both proxy handlers refuse untokened requests before building a context.
    pub agent_token: String,
}

/// Shared state for the gateway, passed to all request handlers.
#[derive(Clone)]
pub struct GatewayState {
    pub ca: Arc<CertificateAuthority>,
    /// Standard upstream client — validates TLS certificates.
    pub http_client: reqwest::Client,
    /// No-verify upstream client — skips TLS certificate validation.
    /// Selected for hosts matched by `skip_verify_hosts`.
    pub http_client_no_verify: reqwest::Client,
    /// Hostname patterns for which TLS certificate validation is skipped.
    /// Supports exact match (`internal.corp`) and wildcard prefix (`*.internal.corp`).
    /// Populated from `GATEWAY_SKIP_VERIFY_HOSTS` (comma-separated).
    pub skip_verify_hosts: Arc<Vec<String>>,
    /// Standard upstream connector for the WebSocket leg, which reqwest does
    /// not serve — validates TLS certificates.
    pub ws_connector: TlsConnector,
    /// No-verify WebSocket connector — skips TLS certificate validation.
    /// Selected for hosts matched by `skip_verify_hosts`, exactly as
    /// `http_client_no_verify` is.
    pub ws_connector_no_verify: TlsConnector,
    pub policy_engine: Arc<PolicyEngine>,
    pub cache: Arc<dyn CacheStore>,
    /// Provider-agnostic vault service for credential fetching.
    pub vault_service: Arc<vault::VaultService>,
    /// Manual approval store for held requests.
    pub approval_store: Arc<dyn ApprovalStore>,
}

/// Resolves CONNECT policy by querying the database directly via SQLx
/// and decrypting secrets in Rust.
pub struct PolicyEngine {
    pub pool: sqlx::PgPool,
    pub crypto: Arc<CryptoService>,
    /// Resolves `op://` references for secrets with `value_source = "onepassword"`.
    /// The same `Arc` is also registered as a `VaultService` provider (where it
    /// acts only as a connection holder — it never races on hostname).
    pub onepassword: Arc<OnePasswordVaultProvider>,
}

// ── Response stream aliases ─────────────────────────────────────────────

/// The streamed upstream response body, as the forward path re-frames it.
pub type BodyStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Frame<Bytes>, reqwest::Error>> + Send>>;

/// A forwarded response body: a buffered gateway-authored payload or the
/// upstream stream.
pub type ForwardResponseBody = Either<Full<Bytes>, StreamBody<BodyStream>>;

// ── Dashboard URL resolution ────────────────────────────────────────────

/// Where dashboard links point when nothing configures a public URL. Right
/// for a loopback install, wrong for anyone reaching OneCLI on another
/// address — which is why `main` warns at startup rather than letting it
/// pass silently.
pub const DASHBOARD_URL_FALLBACK: &str = "http://localhost:10254";

/// The configured public URL, or `None` when there isn't one.
///
/// Present-but-blank counts as absent: an `APP_URL=` line, or a compose
/// passthrough that resolved to nothing, must not read as configuration. Mirrors
/// `configuredAppUrl()` on the Node side so both halves agree on what "set"
/// means. Split out from [`dashboard_url`] so it is testable — that one caches
/// in a `OnceLock` and cannot be re-evaluated under a different environment.
fn normalize_app_url(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim().trim_end_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// How the dashboard URL was decided. Drives the startup warnings in `main`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DashboardUrlSource {
    /// `ONECLI_EXTERNAL_URL`, the canonical var.
    Canonical,
    /// The legacy `APP_URL` alias (kept working, forever).
    Alias,
    /// Seeded from a non-loopback `ONECLI_BIND_HOST` — the pre-refactor
    /// compose behavior, preserved for one release and warned. Deleted next
    /// major.
    LegacyBind,
    /// Nothing configured: [`DASHBOARD_URL_FALLBACK`].
    Fallback,
}

pub struct ResolvedDashboardUrl {
    pub url: String,
    pub source: DashboardUrlSource,
    /// The losing `APP_URL` value when it disagreed with the canonical var.
    pub alias_conflict: Option<String>,
}

/// LEGACY(next-major): a bind host that used to seed the compose URL
/// defaults: non-blank, non-loopback, non-wildcard. Everything else never
/// seeded anything. Delete with the ledger in
/// packages/api/src/lib/public-origins.ts.
fn seedable_bind_host(raw: Option<&str>) -> Option<&str> {
    let trimmed = raw?.trim();
    const NEVER_SEEDS: [&str; 7] = [
        "",
        "127.0.0.1",
        "::1",
        "[::1]",
        "localhost",
        "0.0.0.0",
        "::",
    ];
    (!NEVER_SEEDS.contains(&trimmed) && trimmed != "[::]").then_some(trimmed)
}

/// The pure mirror of the Node resolver's chain head:
/// `ONECLI_EXTERNAL_URL ?? APP_URL ?? legacy-bind-seed ?? fallback`.
/// Env-free so it is table-testable ([`dashboard_url`] caches in a `OnceLock`
/// and cannot be re-evaluated under a different environment).
fn resolve_dashboard_url(
    external: Option<&str>,
    app_url: Option<&str>,
    bind_host: Option<&str>,
    app_port: Option<&str>,
) -> ResolvedDashboardUrl {
    let alias = normalize_app_url(app_url);
    if let Some(url) = normalize_app_url(external) {
        let alias_conflict = alias.filter(|a| *a != url);
        return ResolvedDashboardUrl {
            url,
            source: DashboardUrlSource::Canonical,
            alias_conflict,
        };
    }
    if let Some(url) = alias {
        return ResolvedDashboardUrl {
            url,
            source: DashboardUrlSource::Alias,
            alias_conflict: None,
        };
    }
    if let Some(bind) = seedable_bind_host(bind_host) {
        let port = app_port
            .map(str::trim)
            .filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or("10254");
        // Bracket a bare IPv6 literal so it can carry the port.
        let host = if bind.contains(':') && !bind.starts_with('[') {
            format!("[{bind}]")
        } else {
            bind.to_string()
        };
        return ResolvedDashboardUrl {
            url: format!("http://{host}:{port}"),
            source: DashboardUrlSource::LegacyBind,
            alias_conflict: None,
        };
    }
    ResolvedDashboardUrl {
        url: DASHBOARD_URL_FALLBACK.to_string(),
        source: DashboardUrlSource::Fallback,
        alias_conflict: None,
    }
}

/// The process-wide resolution, cached after first call — a post-first-read
/// env change is invisible by contract.
pub fn resolved_dashboard() -> &'static ResolvedDashboardUrl {
    static RESOLVED: std::sync::OnceLock<ResolvedDashboardUrl> = std::sync::OnceLock::new();
    RESOLVED.get_or_init(|| {
        resolve_dashboard_url(
            std::env::var("ONECLI_EXTERNAL_URL").ok().as_deref(),
            std::env::var("APP_URL").ok().as_deref(),
            std::env::var("ONECLI_BIND_HOST").ok().as_deref(),
            std::env::var("ONECLI_APP_PORT").ok().as_deref(),
        )
    })
}

/// The OneCLI dashboard base URL. Cached after first call.
///
/// `main`'s startup warnings branch on [`resolved_dashboard`]'s source
/// directly — derived from the same cached resolution as this value, so the
/// warning always describes the URL actually in use and cannot drift from it
/// if the env changes after the cache is populated.
pub fn dashboard_url() -> &'static str {
    &resolved_dashboard().url
}

pub fn scoped_url(base: &str, path: &str, workspace_id: Option<&str>) -> String {
    match workspace_id {
        Some(pid) => format!("{base}/w/{pid}{path}"),
        None => format!("{base}{path}"),
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

impl PolicyEngine {
    /// Test-only engine whose pool is lazy and never dereferenced -
    /// resolution tests that stay on cache-hit paths need no Postgres.
    /// Not `#[cfg(test)]`: a dependency's test cfg is invisible to a
    /// dependent's test build. Hidden instead - test support, not API.
    #[doc(hidden)]
    pub fn test_stub() -> Self {
        use crypto::CryptoService;
        use vault::onepassword::OnePasswordVaultProvider;

        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:9/unused")
            .expect("lazy pool");
        let crypto = Arc::new(
            CryptoService::from_base64_key("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
                .expect("test key"),
        );
        let onepassword = Arc::new(OnePasswordVaultProvider::new(
            pool.clone(),
            Arc::clone(&crypto),
        ));
        PolicyEngine {
            pool,
            crypto,
            onepassword,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_app_url_treats_blank_as_unset() {
        assert_eq!(normalize_app_url(None), None);
        assert_eq!(normalize_app_url(Some("")), None);
        assert_eq!(normalize_app_url(Some("   ")), None);
        assert_eq!(normalize_app_url(Some("\t\n")), None);
        // A lone slash trims to nothing; it is not a URL.
        assert_eq!(normalize_app_url(Some("/")), None);
    }

    #[test]
    fn normalize_app_url_trims_whitespace_and_trailing_slashes() {
        assert_eq!(
            normalize_app_url(Some("  https://onecli.example.com//  ")),
            Some("https://onecli.example.com".to_string())
        );
        assert_eq!(
            normalize_app_url(Some("http://172.17.0.1:10254")),
            Some("http://172.17.0.1:10254".to_string())
        );
    }

    #[test]
    fn resolve_dashboard_url_brackets_a_bare_ipv6_bind() {
        let r = resolve_dashboard_url(None, None, Some("fd00::7"), None);
        assert_eq!(r.url, "http://[fd00::7]:10254");
    }

    #[test]
    fn resolve_dashboard_url_keeps_the_alias_working() {
        let r = resolve_dashboard_url(None, Some("http://172.17.0.1:10254"), None, None);
        assert_eq!(r.url, "http://172.17.0.1:10254");
        assert_eq!(r.source, DashboardUrlSource::Alias);
    }

    #[test]
    fn resolve_dashboard_url_never_seeds_from_loopback_or_wildcard_binds() {
        for bind in ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::", " ", ""] {
            let r = resolve_dashboard_url(None, None, Some(bind), None);
            assert_eq!(r.url, DASHBOARD_URL_FALLBACK, "bind {bind:?} must not seed");
            assert_eq!(r.source, DashboardUrlSource::Fallback);
        }
    }

    #[test]
    fn resolve_dashboard_url_prefers_the_canonical_var() {
        let r = resolve_dashboard_url(
            Some("http://canonical.example:10254"),
            Some("http://alias.example:10254"),
            None,
            None,
        );
        assert_eq!(r.url, "http://canonical.example:10254");
        assert_eq!(r.source, DashboardUrlSource::Canonical);
        assert_eq!(
            r.alias_conflict.as_deref(),
            Some("http://alias.example:10254")
        );
    }

    #[test]
    fn resolve_dashboard_url_reports_no_conflict_when_alias_agrees() {
        let r = resolve_dashboard_url(
            Some("http://same.example:10254"),
            Some("http://same.example:10254/"),
            None,
            None,
        );
        assert_eq!(r.source, DashboardUrlSource::Canonical);
        assert_eq!(r.alias_conflict, None);
    }

    #[test]
    fn resolve_dashboard_url_seeds_from_a_non_loopback_bind() {
        let r = resolve_dashboard_url(None, None, Some("10.0.0.5"), Some("24812"));
        assert_eq!(r.url, "http://10.0.0.5:24812");
        assert_eq!(r.source, DashboardUrlSource::LegacyBind);

        // Default port when the port var is absent or malformed.
        let r = resolve_dashboard_url(None, None, Some("172.17.0.1"), Some("nope"));
        assert_eq!(r.url, "http://172.17.0.1:10254");
    }

    #[test]
    fn resolve_dashboard_url_treats_blank_heads_as_unset() {
        let r = resolve_dashboard_url(Some("  "), Some(""), None, None);
        assert_eq!(r.url, DASHBOARD_URL_FALLBACK);
        assert_eq!(r.source, DashboardUrlSource::Fallback);
    }
}
