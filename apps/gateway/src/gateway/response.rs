//! Pre-built gateway responses for common error conditions.

use http_body_util::{Either, Full};
use hyper::body::Bytes;
use hyper::header::HeaderValue;
use hyper::{Response, StatusCode};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

/// 407 Proxy Authentication Required — agent token is missing or invalid.
pub(super) fn proxy_auth_required() -> Response<axum::body::Body> {
    let mut resp = Response::new(axum::body::Body::empty());
    *resp.status_mut() = StatusCode::PROXY_AUTHENTICATION_REQUIRED;
    resp.headers_mut().insert(
        "proxy-authenticate",
        HeaderValue::from_static("Basic realm=\"OneCLI Gateway\""),
    );
    resp
}

/// Response body type used by [`super::forward::forward_request`].
pub(crate) type ForwardBody<S> = Either<Full<Bytes>, S>;

/// Where dashboard links point when nothing configures a public URL. Right
/// for a loopback install, wrong for anyone reaching OneCLI on another
/// address — which is why `main` warns at startup rather than letting it
/// pass silently.
pub(crate) const DASHBOARD_URL_FALLBACK: &str = "http://localhost:10254";

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
pub(crate) enum DashboardUrlSource {
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

pub(crate) struct ResolvedDashboardUrl {
    pub(crate) url: String,
    pub(crate) source: DashboardUrlSource,
    /// The losing `APP_URL` value when it disagreed with the canonical var.
    pub(crate) alias_conflict: Option<String>,
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
pub(crate) fn resolved_dashboard() -> &'static ResolvedDashboardUrl {
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
pub(crate) fn dashboard_url() -> &'static str {
    &resolved_dashboard().url
}

fn scoped_url(base: &str, path: &str, workspace_id: Option<&str>) -> String {
    match workspace_id {
        Some(pid) => format!("{base}/w/{pid}{path}"),
        None => format!("{base}{path}"),
    }
}

/// Build a JSON response with the given status code and body.
/// Used directly for gateway-authored success responses (token-endpoint and
/// default interceptions) and via [`json_error`] for error responses.
pub(super) fn json<S>(status: StatusCode, body: serde_json::Value) -> Response<ForwardBody<S>> {
    let json = body.to_string();
    let mut response = Response::new(Either::Left(Full::new(Bytes::from(json))));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    response
}

/// Build a JSON error response with the given status code and body.
/// Used by `forward_request` (MITM and HTTP proxy forwarding path).
pub(super) fn json_error<S>(
    status: StatusCode,
    body: serde_json::Value,
) -> Response<ForwardBody<S>> {
    json(status, body)
}

/// Build a JSON error response with `axum::body::Body`.
/// Used by `handle_connect` and `handle_http_proxy` (before forwarding).
fn json_error_axum(status: StatusCode, body: serde_json::Value) -> Response<axum::body::Body> {
    let json = body.to_string();
    let mut response = Response::new(axum::body::Body::from(json));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    response
}

/// Mark a response as non-transient so clients know not to retry.
pub(super) fn with_no_retry<B>(mut resp: Response<B>) -> Response<B> {
    resp.headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    resp
}

/// 502 Bad Gateway — generic internal error (axum body).
pub(super) fn bad_gateway() -> Response<axum::body::Body> {
    json_error_axum(
        StatusCode::BAD_GATEWAY,
        serde_json::json!({
            "error": "bad_gateway",
            "message": "OneCLI gateway internal error.",
        }),
    )
}

/// Build the shared JSON body for multiple-connections responses.
fn multiple_connections_json(
    connections: &[crate::connect::ConnectionChoice],
) -> serde_json::Value {
    let hdr = crate::connect::CONNECTION_ID_HEADER;
    serde_json::json!({
        "error": "multiple_connections",
        "message": format!("Multiple connections exist for this provider. Specify which one to use with the {hdr} header."),
        "connections": connections,
        "header": hdr,
        "example": format!("{hdr}: {}", connections.first().map(|c| c.id.as_str()).unwrap_or("CONNECTION_ID")),
    })
}

/// 409 Conflict — multiple connections, agent must specify which one (axum body).
pub(super) fn multiple_connections_axum(
    connections: &[crate::connect::ConnectionChoice],
) -> Response<axum::body::Body> {
    with_no_retry(json_error_axum(
        StatusCode::CONFLICT,
        multiple_connections_json(connections),
    ))
}

/// JSON error response for requests to a known app that has no credentials configured.
///
/// Returned when `injection_count == 0` and the upstream returns 401/403 for a host
/// that matches a registered app provider. Tells the agent (and user) exactly what to do.
pub(crate) fn app_not_connected<S>(
    status: StatusCode,
    provider: &str,
    display_name: &str,
    agent_name: Option<&str>,
    workspace_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    let base = scoped_url(dashboard_url(), "", workspace_id);
    let connect_url = match agent_name {
        Some(name) => format!(
            "{base}/connections?connect={provider}&source=agent&agent_name={}",
            utf8_percent_encode(name, NON_ALPHANUMERIC)
        ),
        None => format!("{base}/connections?connect={provider}"),
    };
    with_no_retry(json_error(
        status,
        serde_json::json!({
            "error": "app_not_connected",
            "message": format!("{display_name} is not connected in OneCLI. Ask the user to open this URL to connect it: {connect_url}"),
            "provider": provider,
            "connect_url": connect_url,
        }),
    ))
}

/// JSON error response for requests to a known app host where the specific API path
/// doesn't match any registered provider (e.g., an unregistered Google API on
/// `www.googleapis.com`). Directs the user to the apps page with the "Request an
/// app" dialog pre-opened and pre-filled with the hostname.
pub(crate) fn app_not_connected_unknown_provider<S>(
    status: StatusCode,
    hostname: &str,
    agent_name: Option<&str>,
    workspace_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    let base = scoped_url(dashboard_url(), "", workspace_id);
    let encoded_host = utf8_percent_encode(hostname, NON_ALPHANUMERIC);
    let connect_url = match agent_name {
        Some(name) => format!(
            "{base}/connections?request={encoded_host}&source=agent&agent_name={}",
            utf8_percent_encode(name, NON_ALPHANUMERIC)
        ),
        None => format!("{base}/connections?request={encoded_host}"),
    };
    with_no_retry(json_error(
        status,
        serde_json::json!({
            "error": "app_not_connected",
            "message": format!(
                "No app is connected for this API on {hostname}. \
                 A pre-built link is provided in the `connect_url` field. \
                 Before sending it to the user, append `&request_name=<name>` with the \
                 human-readable app/service name (e.g., `&request_name=Google%20Custom%20Search`). \
                 Then ask the user to open the link to request it."
            ),
            "hostname": hostname,
            "connect_url": connect_url,
        }),
    ))
}

/// JSON error response when credentials exist for a host but the agent lacks access (selective mode).
/// Covers both manual secrets and app connections.
pub(crate) fn access_restricted<S>(
    status: StatusCode,
    provider: &str,
    display_name: &str,
    workspace_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    // Point at the app's connections page: since attach-model step 6 the
    // workspace policy console is gone, and each account card there carries the
    // "Agent access" dialog — the surface that actually attaches a credential
    // to an agent. (Before step 6 this pointed at the policy console, which
    // was then the only place a grant could be authored.)
    let manage_url = scoped_url(
        dashboard_url(),
        &format!("/connections/apps/{provider}"),
        workspace_id,
    );
    with_no_retry(json_error(
        status,
        serde_json::json!({
            "error": "access_restricted",
            "message": format!("{display_name} credentials exist in OneCLI but this agent does not have access. Ask the user to attach the account to this agent: {manage_url}"),
            "provider": provider,
            "manage_url": manage_url,
        }),
    ))
}

/// JSON error response when no credentials are configured for an unknown host.
///
/// Returned when `injection_count == 0`, upstream returns 401/403, the host is NOT a known
/// app provider, and the agent is authenticated. Provides a link to create a generic secret
/// with pre-populated host and path.
pub(crate) fn credential_not_found<S>(
    status: StatusCode,
    hostname: &str,
    path: &str,
    workspace_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    let base = scoped_url(dashboard_url(), "", workspace_id);
    let encoded_host = utf8_percent_encode(hostname, NON_ALPHANUMERIC);
    let secret_url =
        format!("{base}/connections/custom?create=generic&host={encoded_host}&path=%2F%2A");
    with_no_retry(json_error(
        status,
        serde_json::json!({
            "error": "credential_not_found",
            "message": format!(
                "No credentials configured for {hostname} in OneCLI.\n\
                 A pre-built link is provided in the `secret_url` field. \
                 Before sending this link to the user, append a display name: \
                 &name=<name> (e.g., &name=Stripe%20API%20Key).\n\
                 Then ask the user to open the link to add their API key.\n\n\
                 If you know this API's auth method, you can also customize:\n\
                 - Custom header: append &header=<name> (default: Authorization)\n\
                 - Custom format: append &format=<format> using {{value}} as placeholder \
                 (default: Bearer {{value}}, use just {{value}} for raw token)\n\
                 - Query param auth instead of header: append &param=<name> (e.g., &param=api_key)"
            ),
            "hostname": hostname,
            "path": path,
            "secret_url": secret_url,
        }),
    ))
}

/// 409 Conflict — multiple connections exist for the same provider, agent must specify which one.
pub(crate) fn multiple_connections<S>(
    connections: &[crate::connect::ConnectionChoice],
) -> Response<ForwardBody<S>> {
    with_no_retry(json_error(
        StatusCode::CONFLICT,
        multiple_connections_json(connections),
    ))
}

/// Build the shared JSON body for multiple-providers responses.
fn multiple_providers_json(connections: &[crate::connect::ConnectionChoice]) -> serde_json::Value {
    let hdr = crate::connect::CONNECTION_ID_HEADER;
    serde_json::json!({
        "error": "multiple_providers",
        "message": format!(
            "Multiple app integrations are connected that can handle this API request. \
             If you can determine the correct provider from context, specify it using the {hdr} header. \
             Otherwise, ask the user which provider to use."
        ),
        "connections": connections,
        "header": hdr,
        "example": format!("{hdr}: {}", connections.first().map(|c| c.id.as_str()).unwrap_or("CONNECTION_ID")),
    })
}

/// 409 Conflict — multiple providers match the same request path (axum body).
pub(super) fn multiple_providers_axum(
    connections: &[crate::connect::ConnectionChoice],
) -> Response<axum::body::Body> {
    with_no_retry(json_error_axum(
        StatusCode::CONFLICT,
        multiple_providers_json(connections),
    ))
}

/// 409 Conflict — multiple providers match the same request path.
pub(crate) fn multiple_providers<S>(
    connections: &[crate::connect::ConnectionChoice],
) -> Response<ForwardBody<S>> {
    with_no_retry(json_error(
        StatusCode::CONFLICT,
        multiple_providers_json(connections),
    ))
}

/// 404 Not Found — the requested connection ID does not exist.
pub(crate) fn connection_not_found<S>(
    connection_id: &str,
    connections: &[crate::connect::ConnectionChoice],
) -> Response<ForwardBody<S>> {
    let hdr = crate::connect::CONNECTION_ID_HEADER;
    with_no_retry(json_error(
        StatusCode::NOT_FOUND,
        serde_json::json!({
            "error": "connection_not_found",
            "message": format!("Connection '{connection_id}' was not found or has been removed. Choose from the available connections."),
            "connections": connections,
            "header": hdr,
        }),
    ))
}

/// 404 Not Found — the requested connection ID does not exist (axum body).
pub(super) fn connection_not_found_axum(
    connection_id: &str,
    connections: &[crate::connect::ConnectionChoice],
) -> Response<axum::body::Body> {
    let hdr = crate::connect::CONNECTION_ID_HEADER;
    with_no_retry(json_error_axum(
        StatusCode::NOT_FOUND,
        serde_json::json!({
            "error": "connection_not_found",
            "message": format!("Connection '{connection_id}' was not found or has been removed. Choose from the available connections."),
            "connections": connections,
            "header": hdr,
        }),
    ))
}

/// 502 Bad Gateway — rule resolution failed mid-session.
pub(crate) fn resolution_failed<S>() -> Response<ForwardBody<S>> {
    json_error(
        StatusCode::BAD_GATEWAY,
        serde_json::json!({
            "error": "resolution_failed",
            "message": "OneCLI gateway failed to resolve rules for this request.",
        }),
    )
}

/// 403 Forbidden — manual approval denied or timed out.
pub(crate) fn manual_approval_denied<S>(
    approval_id: &str,
    reason: &str,
) -> Response<ForwardBody<S>> {
    with_no_retry(json_error(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "manual_approval_denied",
            "message": format!("This request was {reason} by an OneCLI manual approval policy."),
            "approval_id": approval_id,
        }),
    ))
}

/// 503 Service Unavailable — the gateway is shutting down while this request
/// was held for manual approval.
///
/// Deliberately not the 403 a denial produces: nobody decided anything here,
/// and an agent that reads a restart as a policy denial will stop retrying
/// something it was never refused. Retryable on purpose — the replacement
/// instance can serve it.
pub(crate) fn gateway_restarting<S>(approval_id: &str) -> Response<ForwardBody<S>> {
    let mut resp = json_error(
        StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({
            "error": "gateway_restarting",
            "message": "OneCLI gateway is restarting and released this request \
                        before it was reviewed. Retry it.",
            "approval_id": approval_id,
        }),
    );
    resp.headers_mut()
        .insert("retry-after", HeaderValue::from_static("1"));
    resp
}

/// 403 Forbidden — request blocked by a policy rule.
pub(crate) fn blocked_by_policy<S>(
    method: &str,
    path: &str,
    rule_name: &str,
    workspace_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    // The agents page: a workspace-scope block now comes from the agent's own
    // grants (changeable there) or from an organization guardrail (which a
    // workspace member cannot change at all) — so the link informs rather than
    // promising an edit.
    let agents_url = scoped_url(dashboard_url(), "/agents", workspace_id);
    with_no_retry(json_error(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "blocked_by_policy",
            "message": format!(
                "Blocked by OneCLI policy rule \"{rule_name}\". \
                 {method} {path} is not allowed. \
                 Review this agent's access in your OneCLI dashboard."
            ),
            "rule_name": rule_name,
            "method": method,
            "path": path,
            "dashboard_url": agents_url,
        }),
    ))
}

/// 403 Forbidden — no allow rule matched in deny-by-default mode.
pub(crate) fn blocked_by_default_policy<S>(
    method: &str,
    path: &str,
    host: &str,
    workspace_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    let agents_url = scoped_url(dashboard_url(), "/agents", workspace_id);
    let hostname = host.split(':').next().unwrap_or(host);
    with_no_retry(json_error(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "blocked_by_default_policy",
            "message": format!(
                "A default-deny policy blocked this request. \
                 {method} {hostname}{path} is not permitted for this agent. \
                 Attach the credential it needs, or ask an organization \
                 administrator to allow the destination."
            ),
            "method": method,
            "host": hostname,
            "path": path,
            "dashboard_url": agents_url,
        }),
    ))
}

/// 429 Too Many Requests — request rate-limited by a policy rule.
pub(crate) fn rate_limited<S>(
    limit: u64,
    window: &str,
    retry_after_secs: u64,
) -> Response<ForwardBody<S>> {
    let mut resp = json_error(
        StatusCode::TOO_MANY_REQUESTS,
        serde_json::json!({
            "error": "rate_limited",
            "message": "This request was rate-limited by an OneCLI policy rule.",
            "limit": limit,
            "window": window,
        }),
    );
    if let Ok(val) = HeaderValue::try_from(retry_after_secs.to_string()) {
        resp.headers_mut().insert("retry-after", val);
    }
    resp
}

/// 502 Bad Gateway — approval store unavailable.
pub(crate) fn approval_store_unavailable<S>() -> Response<ForwardBody<S>> {
    json_error(
        StatusCode::BAD_GATEWAY,
        serde_json::json!({
            "error": "approval_store_unavailable",
            "message": "OneCLI manual approval service is temporarily unavailable.",
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestBody =
        ForwardBody<futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>>;

    // House copy style: no em dashes in user-facing text (the web app pins
    // the same rule in ui-copy-guard.test.ts). Gateway refusal messages are
    // relayed verbatim by agents into chat and Slack, so they are user-facing
    // copy too. This scans THIS FILE's source for em dashes inside string
    // literals — comments keep theirs (not copy).
    #[test]
    fn response_messages_hold_no_em_dashes() {
        let source = include_str!("response.rs");
        for (i, line) in source.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with('*') {
                continue;
            }
            // Only flag lines where the dash sits inside a quoted run.
            if line.contains('\u{2014}') {
                let in_string = line
                    .split('"')
                    .enumerate()
                    .any(|(idx, seg)| idx % 2 == 1 && seg.contains('\u{2014}'));
                assert!(
                    !in_string,
                    "em dash in a user-facing message at response.rs:{}: {}",
                    i + 1,
                    line.trim()
                );
            }
        }
    }

    // A blank value must read as "unconfigured", not as a configured empty
    // string — otherwise every dashboard link becomes "/connections" with no
    // host, and the startup warning that would have flagged it stays quiet.
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

    // `main`'s warnings branch on the cached resolution's source. Asserting
    // that `dashboard_url` and the source come from ONE resolution is what
    // keeps the warning honest: a Fallback source must mean the fallback URL
    // is actually in use.
    //
    // Env-free: the resolution caches in a `OnceLock`, so whichever value this
    // process resolved first is the one under test either way — and mutating
    // env vars here would race the rest of the suite.
    #[test]
    fn startup_warning_source_agrees_with_the_url_actually_in_use() {
        let resolved = resolved_dashboard();
        assert_eq!(dashboard_url(), resolved.url);
        if resolved.source == DashboardUrlSource::Fallback {
            assert_eq!(dashboard_url(), DASHBOARD_URL_FALLBACK);
        }
    }

    // The chain head, table-tested env-free (the pure mirror of the Node
    // resolver): canonical beats alias, alias keeps working, a non-loopback
    // bind seeds (warned via source), loopback and wildcard binds never do.
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
    fn resolve_dashboard_url_keeps_the_alias_working() {
        let r = resolve_dashboard_url(None, Some("http://172.17.0.1:10254"), None, None);
        assert_eq!(r.url, "http://172.17.0.1:10254");
        assert_eq!(r.source, DashboardUrlSource::Alias);
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
    fn resolve_dashboard_url_never_seeds_from_loopback_or_wildcard_binds() {
        for bind in ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::", " ", ""] {
            let r = resolve_dashboard_url(None, None, Some(bind), None);
            assert_eq!(r.url, DASHBOARD_URL_FALLBACK, "bind {bind:?} must not seed");
            assert_eq!(r.source, DashboardUrlSource::Fallback);
        }
    }

    #[test]
    fn resolve_dashboard_url_brackets_a_bare_ipv6_bind() {
        let r = resolve_dashboard_url(None, None, Some("fd00::7"), None);
        assert_eq!(r.url, "http://[fd00::7]:10254");
    }

    #[test]
    fn resolve_dashboard_url_treats_blank_heads_as_unset() {
        let r = resolve_dashboard_url(Some("  "), Some(""), None, None);
        assert_eq!(r.url, DASHBOARD_URL_FALLBACK);
        assert_eq!(r.source, DashboardUrlSource::Fallback);
    }

    #[test]
    fn proxy_auth_required_has_correct_status_and_header() {
        let resp = proxy_auth_required();
        assert_eq!(resp.status(), StatusCode::PROXY_AUTHENTICATION_REQUIRED);
        let auth_header = resp
            .headers()
            .get("proxy-authenticate")
            .expect("should have Proxy-Authenticate header");
        assert_eq!(auth_header, "Basic realm=\"OneCLI Gateway\"");
    }

    #[test]
    fn app_not_connected_preserves_status() {
        let resp: Response<TestBody> =
            app_not_connected(StatusCode::UNAUTHORIZED, "gmail", "Gmail", None, None);
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[tokio::test]
    async fn app_not_connected_body_contains_provider_and_connect_url() {
        let resp: Response<TestBody> =
            app_not_connected(StatusCode::FORBIDDEN, "github", "GitHub", None, None);
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Extract body bytes from Either::Left(Full<Bytes>)
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => {
                let collected = full.collect().await.expect("collect full body").to_bytes();
                collected
            }
            Either::Right(_) => panic!("expected Left (full body), got Right (stream)"),
        };

        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "app_not_connected");
        assert_eq!(json["provider"], "github");
        assert!(json["message"]
            .as_str()
            .unwrap()
            .contains("GitHub is not connected"),);
        assert!(json["connect_url"]
            .as_str()
            .unwrap()
            .ends_with("/connections?connect=github"),);
    }

    #[tokio::test]
    async fn app_not_connected_includes_agent_name_in_url() {
        let resp: Response<TestBody> = app_not_connected(
            StatusCode::UNAUTHORIZED,
            "gmail",
            "Gmail",
            Some("ChartDB Assistant"),
            None,
        );
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        let url = json["connect_url"].as_str().unwrap();
        assert!(
            url.contains("&source=agent&agent_name=ChartDB%20Assistant"),
            "connect_url should include encoded agent_name, got: {url}"
        );
    }

    #[tokio::test]
    async fn app_not_connected_encodes_special_chars_in_agent_name() {
        let resp: Response<TestBody> = app_not_connected(
            StatusCode::UNAUTHORIZED,
            "gmail",
            "Gmail",
            Some("Agent & Co=1"),
            None,
        );
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        let url = json["connect_url"].as_str().unwrap();
        // & and = must be encoded so they don't break the query string structure
        assert!(
            !url.contains("& Co"),
            "raw & in agent_name would inject extra query params, got: {url}"
        );
        assert!(
            url.contains("agent_name=Agent%20%26%20Co%3D1"),
            "connect_url should percent-encode & and = in agent_name, got: {url}"
        );
    }

    #[tokio::test]
    async fn app_not_connected_unknown_provider_opens_request_dialog() {
        let resp: Response<TestBody> = app_not_connected_unknown_provider(
            StatusCode::UNAUTHORIZED,
            "www.googleapis.com",
            Some("Claude Code"),
            None,
        );
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "app_not_connected");
        let url = json["connect_url"].as_str().unwrap();
        assert!(
            url.contains("/connections?request="),
            "connect_url should open request dialog, got: {url}"
        );
        assert!(
            url.contains("agent_name=Claude%20Code"),
            "connect_url should include agent_name, got: {url}"
        );
    }

    #[tokio::test]
    async fn app_not_connected_unknown_provider_without_agent_name() {
        let resp: Response<TestBody> = app_not_connected_unknown_provider(
            StatusCode::FORBIDDEN,
            "www.googleapis.com",
            None,
            None,
        );
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        let url = json["connect_url"].as_str().unwrap();
        assert!(
            url.contains("/connections?request="),
            "connect_url should open request dialog, got: {url}"
        );
        assert!(
            !url.contains("agent_name"),
            "connect_url should not include agent_name, got: {url}"
        );
    }

    #[test]
    fn access_restricted_preserves_status() {
        let resp: Response<TestBody> =
            access_restricted(StatusCode::FORBIDDEN, "resend", "Resend", None);
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[tokio::test]
    async fn access_restricted_body_points_at_the_attach_surface() {
        let resp: Response<TestBody> =
            access_restricted(StatusCode::UNAUTHORIZED, "resend", "Resend", None);
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "access_restricted");
        assert_eq!(json["provider"], "resend");
        assert!(json["message"]
            .as_str()
            .unwrap()
            .contains("does not have access"));
        // Since attach-model step 6 the workspace policy console does not exist,
        // so the remediation link must reach a surface that can actually grant
        // the credential: the app's connections page, whose account cards carry
        // the "Agent access" dialog. A link ending in "/policy" would 404.
        let manage_url = json["manage_url"].as_str().unwrap();
        assert!(manage_url.ends_with("/connections/apps/resend"));
        assert!(!manage_url.contains("/policy"));
    }

    #[tokio::test]
    async fn credential_not_found_includes_host_and_secret_url() {
        let resp: Response<TestBody> = credential_not_found(
            StatusCode::UNAUTHORIZED,
            "api.custom-service.com",
            "/v1/send",
            None,
        );
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");

        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "credential_not_found");
        assert_eq!(json["hostname"], "api.custom-service.com");
        assert_eq!(json["path"], "/v1/send");
        let secret_url = json["secret_url"].as_str().unwrap();
        assert!(secret_url.contains("create=generic"));
        assert!(
            secret_url.contains("path=%2F%2A"),
            "secret_url should use wildcard path, got: {secret_url}"
        );
        assert!(json["message"]
            .as_str()
            .unwrap()
            .contains("api.custom-service.com"));
    }

    #[tokio::test]
    async fn credential_not_found_uses_wildcard_path_and_preserves_request_path() {
        let resp: Response<TestBody> = credential_not_found(
            StatusCode::FORBIDDEN,
            "api.example.com",
            "/v1/send?to=user@test.com&subject=hello",
            None,
        );
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        let secret_url = json["secret_url"].as_str().unwrap();
        assert!(secret_url.contains("create=generic"));
        assert!(
            secret_url.contains("path=%2F%2A"),
            "secret_url should always use wildcard path, got: {secret_url}"
        );
        assert_eq!(
            json["path"], "/v1/send?to=user@test.com&subject=hello",
            "original request path should be preserved in request_path field"
        );
    }

    #[tokio::test]
    async fn multiple_connections_returns_409_with_choices() {
        let connections = vec![
            crate::connect::ConnectionChoice {
                id: "conn_1".to_string(),
                label: Some("alice@gmail.com".to_string()),
                provider: "gmail".to_string(),
                display_name: Some("Gmail"),
            },
            crate::connect::ConnectionChoice {
                id: "conn_2".to_string(),
                label: Some("alice.work@company.com".to_string()),
                provider: "gmail".to_string(),
                display_name: Some("Gmail"),
            },
        ];
        let resp: Response<TestBody> = multiple_connections(&connections);
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");

        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "multiple_connections");
        assert_eq!(json["header"], crate::connect::CONNECTION_ID_HEADER);
        let conns = json["connections"].as_array().unwrap();
        assert_eq!(conns.len(), 2);
        assert_eq!(conns[0]["id"], "conn_1");
        assert_eq!(conns[0]["label"], "alice@gmail.com");
        assert_eq!(conns[1]["id"], "conn_2");
        let example = json["example"].as_str().unwrap();
        assert!(example.contains(crate::connect::CONNECTION_ID_HEADER));
        assert!(example.contains("conn_1"));
    }

    #[test]
    fn multiple_connections_empty_list() {
        let resp: Response<TestBody> = multiple_connections(&[]);
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[tokio::test]
    async fn multiple_providers_returns_409_with_choices() {
        let connections = vec![
            crate::connect::ConnectionChoice {
                id: "conn_jira".to_string(),
                label: Some("dev@company.com".to_string()),
                provider: "jira".to_string(),
                display_name: Some("Jira"),
            },
            crate::connect::ConnectionChoice {
                id: "conn_confluence".to_string(),
                label: Some("dev@company.com".to_string()),
                provider: "confluence".to_string(),
                display_name: Some("Confluence"),
            },
        ];
        let resp: Response<TestBody> = multiple_providers(&connections);
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");

        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "multiple_providers");
        assert_eq!(json["header"], crate::connect::CONNECTION_ID_HEADER);
        let conns = json["connections"].as_array().unwrap();
        assert_eq!(conns.len(), 2);
        assert_eq!(conns[0]["provider"], "jira");
        assert_eq!(conns[0]["display_name"], "Jira");
        assert_eq!(conns[1]["provider"], "confluence");
        assert_eq!(conns[1]["display_name"], "Confluence");
        let example = json["example"].as_str().unwrap();
        assert!(example.contains("conn_jira"));
    }

    #[tokio::test]
    async fn multiple_connections_includes_display_name() {
        let connections = vec![crate::connect::ConnectionChoice {
            id: "conn_1".to_string(),
            label: Some("alice@gmail.com".to_string()),
            provider: "gmail".to_string(),
            display_name: Some("Gmail"),
        }];
        let resp: Response<TestBody> = multiple_connections(&connections);
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        let conns = json["connections"].as_array().unwrap();
        assert_eq!(conns[0]["display_name"], "Gmail");
    }

    #[test]
    fn connection_not_found_has_correct_status_and_headers() {
        let resp: Response<TestBody> = connection_not_found("conn-xyz", &[]);
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[test]
    fn manual_approval_denied_has_correct_status_and_headers() {
        let resp: Response<TestBody> = manual_approval_denied("approval-123", "denied");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[test]
    fn blocked_by_policy_has_correct_status_and_headers() {
        let resp: Response<TestBody> =
            blocked_by_policy("POST", "/api/v1/send", "Block sending", None);
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }
}
