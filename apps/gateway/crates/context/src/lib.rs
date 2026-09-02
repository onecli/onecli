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

/// The loopback twin of an origin, when it has one (`localhost` ↔ `127.0.0.1`).
///
/// The zero-config install advertises `http://localhost:10254` while an
/// operator (and the e2e suite) may browse `http://127.0.0.1:10254`. They are
/// the same deployment, but distinct ORIGINS to a browser, so trusting only
/// the configured spelling turns a working dashboard into an unexplainable
/// CORS failure. Mirrors `loopbackTwin` in
/// `packages/api/src/lib/public-origins.ts`.
fn loopback_twin(origin: &str) -> Option<String> {
    let (scheme, rest) = origin.split_once("://")?;
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    let twin = match host {
        "localhost" => "127.0.0.1",
        "127.0.0.1" => "localhost",
        _ => return None,
    };
    Some(match port {
        Some(p) => format!("{scheme}://{twin}:{p}"),
        None => format!("{scheme}://{twin}"),
    })
}

/// Trim an operator-supplied origin to a bare `scheme://host[:port]`, or drop
/// it. Deliberately strict: this value is echoed into an
/// `Access-Control-Allow-Origin` header, so a path, a wildcard or a stray
/// control character must never survive into it.
fn normalize_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let (scheme, rest) = trimmed.split_once("://")?;
    // Schemes are case-insensitive (RFC 3986), so compare lowercased and emit
    // lowercased. The host is left as written: it is compared against the
    // browser's `Origin` header, which browsers already send lowercased.
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https") || rest.is_empty() {
        return None;
    }
    // A header value may not carry these, and an origin never legitimately
    // does: `/` would mean a path, `@` credentials, and the rest are either
    // header-splitting or plainly not a host.
    let bad = |c: char| {
        c == '/'
            || c == '@'
            || c == '?'
            || c == '#'
            || c == '*'
            || c.is_whitespace()
            || c.is_control()
    };
    if rest.contains(bad) {
        return None;
    }
    Some(format!("{scheme}://{rest}"))
}

/// Every browser origin this deployment answers credentialed CORS for.
///
/// The dashboard origin, its loopback twin, and any `ONECLI_TRUSTED_ORIGINS`
/// extras — the same set the Node side builds in `buildTrustedOrigins`, so an
/// origin that may sign in is exactly one that may call the gateway. Env-free
/// so it stays table-testable.
fn build_trusted_origins(dashboard: &str, extra_csv: Option<&str>) -> Vec<String> {
    let mut origins = Vec::new();
    let mut push = |value: String| {
        if !origins.contains(&value) {
            origins.push(value);
        }
    };
    if let Some(normalized) = normalize_origin(dashboard) {
        if let Some(twin) = loopback_twin(&normalized) {
            push(normalized.clone());
            push(twin);
        } else {
            push(normalized);
        }
    }
    for entry in extra_csv.unwrap_or("").split(',') {
        if let Some(normalized) = normalize_origin(entry) {
            push(normalized);
        }
    }
    origins
}

/// The browser origins the gateway's credentialed control plane trusts,
/// resolved once and cached alongside the dashboard URL.
///
/// SECURITY: the control plane authenticates browsers with the same
/// better-auth session cookie the API issues, so with `allow_credentials(true)`
/// the allow-list is the only thing standing between a page the user happens
/// to visit and the approvals API (read pending requests, submit decisions),
/// vault pairing, and cache invalidation. `SameSite=lax` does not cover it:
/// SameSite is SITE-scoped while CORS is ORIGIN-scoped, so a sibling subdomain
/// (or another port on the same host) is same-site and sends the cookie.
///
/// Reflecting the request's own origin, which is what this replaced, made
/// every such page an authenticated caller.
pub fn trusted_browser_origins() -> &'static [String] {
    static ORIGINS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ORIGINS.get_or_init(|| {
        build_trusted_origins(
            dashboard_url(),
            std::env::var("ONECLI_TRUSTED_ORIGINS").ok().as_deref(),
        )
    })
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

    // ── Trusted browser origins (the credentialed CORS boundary) ─────────
    //
    // This set is the ONLY fence on the gateway's browser control plane:
    // approvals (read + decide), vault pairing, cache invalidation. It
    // authenticates with the same session cookie the API issues, and
    // `SameSite=lax` does not help — SameSite is site-scoped while CORS is
    // origin-scoped, so a sibling subdomain is same-site and sends the cookie.

    /// The regression guard for the reflected-origin bypass. If an attacker's
    /// origin ever lands in this set, any page the user visits can drive the
    /// authenticated API — exactly what `AllowOrigin::mirror_request()` did.
    #[test]
    fn trusted_origins_exclude_foreign_origins() {
        let origins = build_trusted_origins("https://onecli.acme.com", None);
        for foreign in [
            "https://evil.example",
            // Same-site with the dashboard, and therefore the case that
            // matters most: the cookie rides along on its fetch.
            "https://blog.acme.com",
            // Another port of the same host is same-site too.
            "https://onecli.acme.com:8443",
            // Classic allow-list bypass shapes.
            "https://onecli.acme.com.evil.example",
            "https://evil-onecli.acme.com",
            // Scheme downgrade.
            "http://onecli.acme.com",
            "*",
            "null",
        ] {
            assert!(
                !origins.iter().any(|o| o == foreign),
                "{foreign} must never be trusted (origins: {origins:?})"
            );
        }
    }

    #[test]
    fn trusted_origins_hold_the_dashboard_and_its_loopback_twin() {
        // The zero-config install: configured as localhost, browsed as either.
        let origins = build_trusted_origins(DASHBOARD_URL_FALLBACK, None);
        assert!(origins.iter().any(|o| o == "http://localhost:10254"));
        assert!(origins.iter().any(|o| o == "http://127.0.0.1:10254"));

        // …and the reverse spelling yields the same pair, so an operator who
        // configures 127.0.0.1 is not locked out of `localhost`.
        let flipped = build_trusted_origins("http://127.0.0.1:10254", None);
        assert!(flipped.iter().any(|o| o == "http://localhost:10254"));
        assert!(flipped.iter().any(|o| o == "http://127.0.0.1:10254"));
    }

    /// A non-loopback dashboard has no twin to add — and must not gain one.
    #[test]
    fn trusted_origins_add_no_twin_for_a_real_host() {
        let origins = build_trusted_origins("https://onecli.acme.com", None);
        assert_eq!(origins, vec!["https://onecli.acme.com".to_string()]);
    }

    /// The documented escape hatch for an install reachable at two addresses
    /// (docs/self-hosting.md). Same var the Node auth layer reads, so an
    /// origin that may sign in is exactly one that may call the gateway.
    #[test]
    fn trusted_origins_accept_operator_listed_extras() {
        let origins = build_trusted_origins(
            "http://192.0.2.10:10254",
            Some("http://onecli.lan:10254, https://alt.acme.com"),
        );
        assert!(origins.iter().any(|o| o == "http://onecli.lan:10254"));
        assert!(origins.iter().any(|o| o == "https://alt.acme.com"));
    }

    /// A malformed entry is dropped, never partially honoured: this value is
    /// echoed into a response header, so a path, wildcard, or embedded CRLF
    /// must not survive into it.
    #[test]
    fn trusted_origins_drop_malformed_entries() {
        let origins = build_trusted_origins(
            "https://onecli.acme.com",
            Some("not-an-origin,javascript:alert(1),https://ok.example/path,*,,  ,https://good.example"),
        );
        assert_eq!(
            origins,
            vec![
                "https://onecli.acme.com".to_string(),
                "https://good.example".to_string()
            ]
        );
        for origin in &origins {
            assert!(
                hyper::header::HeaderValue::from_str(origin).is_ok(),
                "{origin} must be a valid header value"
            );
        }
    }

    #[test]
    fn trusted_origins_are_deduplicated() {
        let origins = build_trusted_origins(
            "https://onecli.acme.com",
            Some("https://onecli.acme.com,https://onecli.acme.com/"),
        );
        assert_eq!(origins, vec!["https://onecli.acme.com".to_string()]);
    }

    #[test]
    fn normalize_origin_rejects_header_injection_and_junk() {
        for bad in [
            "https://onecli.acme.com\r\nX-Injected: 1",
            "https://onecli.acme.com/path",
            "https://user:pw@onecli.acme.com",
            "ftp://onecli.acme.com",
            "javascript:alert(1)",
            "//onecli.acme.com",
            "onecli.acme.com",
            "",
            "   ",
        ] {
            assert_eq!(normalize_origin(bad), None, "{bad:?} must be rejected");
        }
        // Trailing slash and scheme case are normalization, not new trust.
        assert_eq!(
            normalize_origin("HTTPS://onecli.acme.com/"),
            Some("https://onecli.acme.com".to_string())
        );
    }
}
