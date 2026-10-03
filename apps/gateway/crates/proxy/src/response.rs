//! Pre-built gateway responses for common error conditions.

use http_body_util::{Either, Full};
use hyper::body::Bytes;
use hyper::header::HeaderValue;
use hyper::{Response, StatusCode};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

use crate::connect::RestrictedCredential;

/// 407 Proxy Authentication Required — agent token is missing or invalid.
pub fn proxy_auth_required() -> Response<axum::body::Body> {
    let mut resp = Response::new(axum::body::Body::empty());
    *resp.status_mut() = StatusCode::PROXY_AUTHENTICATION_REQUIRED;
    resp.headers_mut().insert(
        "proxy-authenticate",
        HeaderValue::from_static("Basic realm=\"OneCLI Gateway\""),
    );
    resp
}

/// Response body type used by [`super::forward::forward_request`].
pub type ForwardBody<S> = Either<Full<Bytes>, S>;

/// Shared by this crate's test modules: the body type the pre-built
/// responses are instantiated with in tests (the stream arm is never
/// produced by them), and the one way to read such a response back as JSON.
#[cfg(test)]
pub(crate) mod test_support {
    use super::{Either, ForwardBody};
    use hyper::body::{Bytes, Frame};
    use hyper::Response;

    pub(crate) type TestBody =
        ForwardBody<futures_util::stream::Empty<Result<Frame<Bytes>, reqwest::Error>>>;

    pub(crate) async fn body_json(resp: Response<TestBody>) -> serde_json::Value {
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect").to_bytes(),
            Either::Right(_) => panic!("expected a buffered body"),
        };
        serde_json::from_slice(&body).expect("valid JSON")
    }
}

// ── Guidance error codes ────────────────────────────────────────────────
//
// The stable `error` identifiers of the answers the gateway substitutes for
// an upstream auth failure on an uncredentialed request. Agents match on
// them, the gateway skill documents them, and the request log records which
// one a request received (`RequestDecision::NeedsConnection`), so the code in
// the body and the code in the log come from one definition.

/// A known app's host (or a provider's generic alias host) with no connection
/// attached: the agent is pointed at the native connect link.
pub const ERROR_APP_NOT_CONNECTED: &str = "app_not_connected";
/// Credentials exist, but this agent was not granted them.
pub const ERROR_ACCESS_RESTRICTED: &str = "access_restricted";
/// No credential of any kind for this host: the custom-secret nudge.
pub const ERROR_CREDENTIAL_NOT_FOUND: &str = "credential_not_found";
/// A host-bound connection exists, but the request went to another host.
pub const ERROR_CONNECTION_HOST_MISMATCH: &str = "connection_host_mismatch";

// The dashboard-URL resolution lives in `crate::context` (shared with `main`'s
// startup warnings and the ee agent-facing responses); re-exported so existing
// paths hold.
pub use context::{
    dashboard_url, resolved_dashboard, scoped_url, DashboardUrlSource, DASHBOARD_URL_FALLBACK,
};

/// Build a JSON response with the given status code and body.
/// Used directly for gateway-authored success responses (token-endpoint and
/// default interceptions) and via [`json_error`] for error responses.
pub fn json<S>(status: StatusCode, body: serde_json::Value) -> Response<ForwardBody<S>> {
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
pub fn json_error<S>(status: StatusCode, body: serde_json::Value) -> Response<ForwardBody<S>> {
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
pub fn with_no_retry<B>(mut resp: Response<B>) -> Response<B> {
    resp.headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    resp
}

/// 502 Bad Gateway — generic internal error (axum body).
pub fn bad_gateway() -> Response<axum::body::Body> {
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
pub fn multiple_connections_axum(
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
pub fn app_not_connected<S>(
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
            "error": ERROR_APP_NOT_CONNECTED,
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
pub fn app_not_connected_unknown_provider<S>(
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
            "error": ERROR_APP_NOT_CONNECTED,
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
///
/// `credential` is the kind the workspace holds for the host, and it alone
/// decides the link, because each kind is attached to an agent on a different
/// page. The host never does: a custom secret on a host a registered app also
/// serves (`app.posthog.com`) has no account on that app's page to attach.
/// Without an agent id, each kind falls back to its workspace list.
pub fn access_restricted<S>(
    status: StatusCode,
    credential: RestrictedCredential,
    hostname: &str,
    path: &str,
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    let app = apps::guidance_provider_for(hostname, path);
    let (provider, display_name) = app.unwrap_or((hostname, hostname));
    let agent_page = |section: &str, workspace_list: &str| match agent_id {
        Some(agent) => format!("/agents/{agent}{section}"),
        None => workspace_list.to_string(),
    };
    let (page, noun) = match (credential, app) {
        // The app's page: its account cards carry the "Agent access" dialog
        // (the attach surface since attach-model step 6), and it is the one
        // shape the chat renders as a connect card.
        (RestrictedCredential::AppConnection, Some((app_id, _))) => {
            (format!("/connections/apps/{app_id}"), "account")
        }
        // A connected app whose path names no app (an unregistered API on a
        // shared host): the agent's Apps tab.
        (RestrictedCredential::AppConnection, None) => {
            (agent_page("/connections", "/connections"), "account")
        }
        (RestrictedCredential::CustomSecret, _) => (
            agent_page("/connections?tab=custom", "/connections/custom"),
            "secret",
        ),
        (RestrictedCredential::LlmKey, _) => (agent_page("/models", "/connections/llms"), "key"),
    };
    let manage_url = scoped_url(dashboard_url(), &page, workspace_id);
    with_no_retry(json_error(
        status,
        serde_json::json!({
            "error": ERROR_ACCESS_RESTRICTED,
            "message": format!("{display_name} credentials exist in OneCLI but this agent does not have access. Ask the user to attach the {noun} to this agent: {manage_url}"),
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
pub fn credential_not_found<S>(
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
            "error": ERROR_CREDENTIAL_NOT_FOUND,
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
pub fn multiple_connections<S>(
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
pub fn multiple_providers_axum(
    connections: &[crate::connect::ConnectionChoice],
) -> Response<axum::body::Body> {
    with_no_retry(json_error_axum(
        StatusCode::CONFLICT,
        multiple_providers_json(connections),
    ))
}

/// 409 Conflict — multiple providers match the same request path.
pub fn multiple_providers<S>(
    connections: &[crate::connect::ConnectionChoice],
) -> Response<ForwardBody<S>> {
    with_no_retry(json_error(
        StatusCode::CONFLICT,
        multiple_providers_json(connections),
    ))
}

/// 404 Not Found — the requested connection ID does not exist.
pub fn connection_not_found<S>(
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
pub fn connection_not_found_axum(
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

/// Build the shared JSON body for a host-gated connection mismatch.
///
/// `connections` are the agent's OWN granted connections that refused the
/// request because it went to a host other than the one each credential is
/// bound to (`ConnectionChoice::host`). The message is written for the agent
/// that will read it: it names the bound host and, when there is exactly one,
/// spells out the corrected URL so the fix is a copy-paste. A connection with
/// no bound host at all (fail-closed) is told to reconnect rather than guess.
///
/// Every choice is of ONE provider: a host-gated suffix (`*.my.salesforce.com`,
/// `*.snowflakecomputing.com`, `*.jfrog.io`) belongs to exactly one provider
/// in the registry, and only connections matching the request host's suffix
/// reach resolution. `provider`/`display` are therefore taken from the first
/// choice and describe the whole set.
fn connection_host_mismatch_json(
    requested_host: &str,
    path: &str,
    connections: &[crate::connect::ConnectionChoice],
) -> serde_json::Value {
    let hdr = crate::connect::CONNECTION_ID_HEADER;
    let provider = connections.first().map(|c| c.provider.as_str());
    let display = connections
        .first()
        .and_then(|c| c.display_name)
        .or(provider)
        .unwrap_or("This app");
    // Distinct bound hosts, first-seen order: two accounts on the same org
    // (e.g. two Salesforce users of one instance) share a host, and the fix
    // for the agent is the same URL either way.
    let mut bound: Vec<&str> = Vec::new();
    for host in connections.iter().filter_map(|c| c.host.as_deref()) {
        if !bound.contains(&host) {
            bound.push(host);
        }
    }

    // A request to an alias host often carries a path the bound host does not
    // inject on either (login.salesforce.com/services/oauth2/userinfo): say
    // which API surface carries the credential so the retry is not a second
    // uncredentialed miss.
    let path_note = provider
        .and_then(apps::bound_host_path_prefix)
        .filter(|prefix| !path.starts_with(prefix))
        .map(|prefix| format!(" Credentials are only injected on {prefix}* paths."))
        .unwrap_or_default();

    let message = match bound.as_slice() {
        [] => format!(
            "{display} is connected, but the connection stores no bound host, so credentials cannot be injected for {requested_host}. \
             Ask the user to reconnect {display} in OneCLI, then retry."
        ),
        [host] if !path_note.is_empty() => format!(
            "Your {display} connection is bound to {host}, but this request went to {requested_host}. \
             Send your API requests to https://{host} instead.{path_note}"
        ),
        [host] => format!(
            "Your {display} connection is bound to {host}, but this request went to {requested_host}. \
             Credentials are only injected on the bound host. Re-send the same request to https://{host}{path}"
        ),
        many => format!(
            "Your {display} connections are bound to {}, but this request went to {requested_host}. \
             Credentials are only injected on a connection's bound host. Re-send the same request to the host of the account you mean, \
             and name that account with the {hdr} header.{path_note}",
            many.join(", ")
        ),
    };

    serde_json::json!({
        "error": ERROR_CONNECTION_HOST_MISMATCH,
        "message": message,
        "requested_host": requested_host,
        "provider": provider,
        "connections": connections,
        "header": hdr,
    })
}

/// 421 Misdirected Request — the request went to a host none of the agent's
/// granted connections is bound to. Same code as the deprecated-host hint
/// (`hints.rs`): the URL is wrong for this credential, not the credential for
/// this URL. Non-retryable: an unchanged retry cannot succeed.
pub fn connection_host_mismatch<S>(
    requested_host: &str,
    path: &str,
    connections: &[crate::connect::ConnectionChoice],
) -> Response<ForwardBody<S>> {
    with_no_retry(json_error(
        StatusCode::MISDIRECTED_REQUEST,
        connection_host_mismatch_json(requested_host, path, connections),
    ))
}

/// 421 Misdirected Request — host-gated connection mismatch (axum body).
pub fn connection_host_mismatch_axum(
    requested_host: &str,
    path: &str,
    connections: &[crate::connect::ConnectionChoice],
) -> Response<axum::body::Body> {
    with_no_retry(json_error_axum(
        StatusCode::MISDIRECTED_REQUEST,
        connection_host_mismatch_json(requested_host, path, connections),
    ))
}

/// 502 Bad Gateway — rule resolution failed mid-session.
pub fn resolution_failed<S>() -> Response<ForwardBody<S>> {
    json_error(
        StatusCode::BAD_GATEWAY,
        serde_json::json!({
            "error": "resolution_failed",
            "message": "OneCLI gateway failed to resolve rules for this request.",
        }),
    )
}

/// 502 Bad Gateway — the request never reached the upstream (DNS, connect,
/// or TLS failure). Named for what happened, so an agent that called a host
/// that does not exist (`api.snowflake.com`) learns THAT, instead of reading
/// a rule-resolution failure as "the gateway is broken" or "not connected".
pub fn upstream_unreachable<S>(host: &str) -> Response<ForwardBody<S>> {
    json_error(
        StatusCode::BAD_GATEWAY,
        serde_json::json!({
            "error": "upstream_unreachable",
            "message": format!(
                "Could not reach {host} (DNS, connection, or TLS failure). Check the hostname: \
                 it may not exist. This is not a credential or connection problem."
            ),
            "host": host,
        }),
    )
}

/// 504 Gateway Timeout — upstream accepted the request but never returned
/// response headers within the gateway's bound.
///
/// Sanitized on purpose: the stable `upstream_timeout` identifier is all a
/// client gets. The URL, the `reqwest` error and any transport detail stay in
/// the server-side log, since the request that stalled is exactly the kind
/// that carries an injected credential in its headers.
///
/// Marked non-retryable. A stalled request may still have been executed
/// upstream, so the honest signal is "outcome unknown, do not replay", not an
/// invitation to send it again.
pub fn upstream_timeout<S>() -> Response<ForwardBody<S>> {
    with_no_retry(json_error(
        StatusCode::GATEWAY_TIMEOUT,
        serde_json::json!({
            "error": "upstream_timeout",
            "message": "OneCLI gateway timed out waiting for upstream response headers. \
                        The request was not retried. The upstream may or may not have processed it.",
        }),
    ))
}

/// The outcome applies only to the held request, not future user-directed requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalRejection {
    Declined,
    Expired,
}

/// 403 Forbidden with automatic retries disabled; a new user request needs fresh approval.
pub fn manual_approval_denied<S>(
    approval_id: &str,
    outcome: ApprovalRejection,
) -> Response<ForwardBody<S>> {
    let (reason, description) = match outcome {
        ApprovalRejection::Declined => ("declined", "The reviewer declined this approval request."),
        ApprovalRejection::Expired => {
            ("expired", "This approval request expired without approval.")
        }
    };
    with_no_retry(json_error(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "manual_approval_denied",
            "reason": reason,
            "message": format!(
                "{description} The request was not forwarded to the service. \
                 This outcome applies only to this request, not a permanent policy block. \
                 Do not automatically retry or bypass approval. If the user asks for edits, \
                 revise the draft without sending. When the user explicitly asks to send or \
                 try again, submit a new request through the same gateway, even if the content \
                 is unchanged. The new request requires fresh approval before it can execute."
            ),
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
pub fn gateway_restarting<S>(approval_id: &str) -> Response<ForwardBody<S>> {
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
pub fn blocked_by_policy<S>(
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
pub fn blocked_by_default_policy<S>(
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
pub fn rate_limited<S>(
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

/// A held request could not receive a trustworthy approval decision.
/// Unlike a pre-hold failure, never invite an automatic retry of this attempt.
pub fn approval_wait_unavailable<S>(approval_id: &str) -> Response<ForwardBody<S>> {
    with_no_retry(json_error(
        StatusCode::BAD_GATEWAY,
        serde_json::json!({
            "error": "approval_store_unavailable",
            "message": "OneCLI could not obtain an approval decision because the manual approval service is temporarily unavailable. The request was not forwarded. Do not retry automatically. A new attempt requires an explicit user request and must go through the same gateway policy and approval checks.",
            "approval_id": approval_id,
        }),
    ))
}

/// 502 Bad Gateway — approval store unavailable before a hold is established.
pub fn approval_store_unavailable<S>() -> Response<ForwardBody<S>> {
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
    use super::test_support::{body_json, TestBody};
    use super::*;

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
        let resp: Response<TestBody> = access_restricted(
            StatusCode::FORBIDDEN,
            RestrictedCredential::AppConnection,
            "api.resend.com",
            "/emails",
            None,
            None,
        );
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[tokio::test]
    async fn access_restricted_body_points_at_the_attach_surface() {
        let resp: Response<TestBody> = access_restricted(
            StatusCode::UNAUTHORIZED,
            RestrictedCredential::AppConnection,
            "api.resend.com",
            "/emails",
            None,
            Some("agent-1"),
        );
        let json = body_json(resp).await;
        assert_eq!(json["error"], "access_restricted");
        assert_eq!(json["provider"], "resend");
        assert!(json["message"]
            .as_str()
            .unwrap()
            .contains("does not have access. Ask the user to attach the account"));
        // Since attach-model step 6 the workspace policy console does not exist,
        // so the remediation link must reach a surface that can actually grant
        // the credential: the app's connections page, whose account cards carry
        // the "Agent access" dialog. A link ending in "/policy" would 404.
        let manage_url = json["manage_url"].as_str().unwrap();
        assert!(manage_url.ends_with("/connections/apps/resend"));
        assert!(!manage_url.contains("/policy"));
    }

    /// The `access_restricted` body for `credential` on `url` (host + path) in
    /// workspace `ws1`, as (`manage_url` minus the dashboard origin, message).
    async fn restricted_link(
        credential: RestrictedCredential,
        url: &str,
        agent: Option<&str>,
    ) -> (String, String) {
        let (host, path) = url.split_at(url.find('/').unwrap_or(url.len()));
        let resp: Response<TestBody> = access_restricted(
            StatusCode::FORBIDDEN,
            credential,
            host,
            path,
            Some("ws1"),
            agent,
        );
        let json = body_json(resp).await;
        let manage_url = json["manage_url"].as_str().unwrap();
        let message = json["message"].as_str().unwrap();
        assert!(message.ends_with(manage_url), "{message}");
        (
            manage_url
                .strip_prefix(dashboard_url())
                .unwrap()
                .to_string(),
            message.to_string(),
        )
    }

    /// The link follows the denied credential's KIND, never the host. The prod
    /// incident: a custom PostHog secret, on a host that is also a registered
    /// app. Linking by host sent the user to the PostHog app page, which has no
    /// account to attach. Custom secrets and LLM keys are attached on the
    /// agent's own pages, and each falls back to its workspace list.
    #[tokio::test]
    async fn access_restricted_links_the_page_that_attaches_the_denied_credential() {
        use RestrictedCredential::{AppConnection, CustomSecret, LlmKey};
        let agent = Some("ag-1");
        let posthog = "app.posthog.com/api/projects";

        let (custom, message) = restricted_link(CustomSecret, posthog, agent).await;
        assert_eq!(custom, "/w/ws1/agents/ag-1/connections?tab=custom");
        assert!(
            message.contains("attach the secret to this agent"),
            "{message}"
        );
        let (custom, _) = restricted_link(CustomSecret, posthog, None).await;
        assert_eq!(custom, "/w/ws1/connections/custom");

        let anthropic = "api.anthropic.com/v1/messages";
        let (key, message) = restricted_link(LlmKey, anthropic, agent).await;
        assert_eq!(key, "/w/ws1/agents/ag-1/models");
        assert!(
            message.contains("attach the key to this agent"),
            "{message}"
        );
        let (key, _) = restricted_link(LlmKey, anthropic, None).await;
        assert_eq!(key, "/w/ws1/connections/llms");

        let (app, message) = restricted_link(AppConnection, posthog, agent).await;
        assert_eq!(app, "/w/ws1/connections/apps/posthog");
        assert!(
            message.contains("attach the account to this agent"),
            "{message}"
        );
        // An alias host names its owning app, as app_not_connected does.
        let alias = "login.salesforce.com/services/oauth2/userinfo";
        let (app, _) = restricted_link(AppConnection, alias, agent).await;
        assert_eq!(app, "/w/ws1/connections/apps/salesforce");
        // A shared host whose path names no app: the agent's Apps tab.
        let shared = "www.googleapis.com/unregistered/v1/x";
        let (app, _) = restricted_link(AppConnection, shared, agent).await;
        assert_eq!(app, "/w/ws1/agents/ag-1/connections");
        let (app, _) = restricted_link(AppConnection, shared, None).await;
        assert_eq!(app, "/w/ws1/connections");
    }

    /// `provider` keeps naming what the host is, whatever the kind: the app
    /// id where a registered app serves the host, else the host itself.
    #[tokio::test]
    async fn access_restricted_provider_names_the_app_or_the_host() {
        for (host, provider) in [("app.posthog.com", "posthog"), ("127.0.0.1", "127.0.0.1")] {
            let resp: Response<TestBody> = access_restricted(
                StatusCode::FORBIDDEN,
                RestrictedCredential::CustomSecret,
                host,
                "/",
                None,
                None,
            );
            assert_eq!(body_json(resp).await["provider"], provider, "{host}");
        }
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
                host: None,
            },
            crate::connect::ConnectionChoice {
                id: "conn_2".to_string(),
                label: Some("alice.work@company.com".to_string()),
                provider: "gmail".to_string(),
                display_name: Some("Gmail"),
                host: None,
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
                host: None,
            },
            crate::connect::ConnectionChoice {
                id: "conn_confluence".to_string(),
                label: Some("dev@company.com".to_string()),
                provider: "confluence".to_string(),
                display_name: Some("Confluence"),
                host: None,
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
            host: None,
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
        let resp: Response<TestBody> =
            manual_approval_denied("approval-123", ApprovalRejection::Declined);
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
    }

    #[tokio::test]
    async fn approval_rejection_scopes_outcome_to_one_request() {
        use http_body_util::BodyExt;
        for (outcome, reason, description) in [
            (
                ApprovalRejection::Declined,
                "declined",
                "The reviewer declined this approval request.",
            ),
            (
                ApprovalRejection::Expired,
                "expired",
                "This approval request expired without approval.",
            ),
        ] {
            let resp: Response<TestBody> = manual_approval_denied("approval-123", outcome);
            assert_eq!(resp.status(), StatusCode::FORBIDDEN);
            assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
            let bytes = match resp.into_body() {
                Either::Left(full) => full.collect().await.expect("collect body").to_bytes(),
                Either::Right(_) => panic!("expected full response"),
            };
            let body: serde_json::Value = serde_json::from_slice(&bytes).expect("valid JSON");
            assert_eq!(body["error"], "manual_approval_denied");
            assert_eq!(body["approval_id"], "approval-123");
            assert_eq!(body["reason"], reason);
            let message = body["message"].as_str().expect("message");
            assert!(message.starts_with(description));
            for guidance in [
                "not forwarded to the service",
                "Do not automatically retry or bypass approval",
                "revise the draft without sending",
                "When the user explicitly asks to send or try again",
                "even if the content is unchanged",
                "requires fresh approval",
            ] {
                assert!(message.contains(guidance), "missing guidance: {guidance}");
            }
        }
    }

    #[tokio::test]
    async fn approval_wait_failure_is_not_a_decline_or_expiry() {
        use http_body_util::BodyExt;
        let resp: Response<TestBody> = approval_wait_unavailable("approval-123");
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
        let bytes = match resp.into_body() {
            Either::Left(full) => full.collect().await.unwrap().to_bytes(),
            Either::Right(_) => panic!("expected full response"),
        };
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "approval_store_unavailable");
        assert_eq!(body["approval_id"], "approval-123");
        assert!(body.get("reason").is_none());
        let message = body["message"].as_str().unwrap();
        for guidance in [
            "request was not forwarded",
            "Do not retry automatically",
            "explicit user request",
            "same gateway policy and approval checks",
        ] {
            assert!(message.contains(guidance), "missing guidance: {guidance}");
        }
        assert!(!message.contains("expired"));
        assert!(!message.contains("declined"));
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

    #[tokio::test]
    async fn upstream_timeout_is_a_sanitized_non_retryable_504() {
        let resp: Response<TestBody> = upstream_timeout();

        assert_eq!(resp.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            resp.headers()
                .get("x-should-retry")
                .and_then(|v| v.to_str().ok()),
            Some("false"),
            "an ambiguous timeout must not invite the client to replay it",
        );

        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");

        assert_eq!(
            json["error"], "upstream_timeout",
            "the stable identifier is what callers match on",
        );

        // Sanitized: the body carries the stable id and a human message and
        // nothing else. No upstream URL, no transport or `reqwest` detail, and
        // nothing that could echo an injected credential back to the client.
        let object = json.as_object().expect("object body");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["error", "message"]);

        let rendered = String::from_utf8_lossy(&body).to_string();
        for leak in ["http://", "https://", "reqwest", "Bearer", "token\":"] {
            assert!(
                !rendered.contains(leak),
                "timeout body must not expose {leak:?}: {rendered}",
            );
        }
    }

    // ── connection_host_mismatch ─────────────────────────────────────────

    fn choice(id: &str, provider: &str, host: Option<&str>) -> crate::connect::ConnectionChoice {
        crate::connect::ConnectionChoice {
            id: id.to_string(),
            label: Some(format!("{id}@example.com")),
            provider: provider.to_string(),
            display_name: apps::display_name_for_provider(provider),
            host: host.map(str::to_string),
        }
    }

    /// The prod incident shape: the agent went to `login.salesforce.com` with
    /// an OAuth path. The answer names the bound host AND the API surface
    /// that actually carries the credential, so the retry is not another miss.
    #[tokio::test]
    async fn connection_host_mismatch_on_off_api_path_names_the_api_prefix() {
        let connections = vec![choice(
            "conn_sf",
            "salesforce",
            Some("acme.my.salesforce.com"),
        )];
        let resp: Response<TestBody> = connection_host_mismatch(
            "login.salesforce.com",
            "/services/oauth2/userinfo",
            &connections,
        );
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
        let json = body_json(resp).await;
        let message = json["message"].as_str().unwrap();
        assert!(
            message.contains("https://acme.my.salesforce.com"),
            "{message}"
        );
        assert!(message.contains("/services/data/* paths"), "{message}");
        assert!(
            !message.contains("acme.my.salesforce.com/services/oauth2"),
            "must not suggest re-sending to a path that never injects: {message}"
        );
    }

    /// The #1137 shape: one Salesforce connection, request to the docs'
    /// placeholder host. The agent must get a 421 it can act on alone: the
    /// bound host, and the exact corrected URL to re-send to.
    #[tokio::test]
    async fn connection_host_mismatch_single_connection_names_corrected_url() {
        let connections = vec![choice(
            "conn_sf",
            "salesforce",
            Some("acme.my.salesforce.com"),
        )];
        let resp: Response<TestBody> = connection_host_mismatch(
            "your-domain.my.salesforce.com",
            "/services/data/v60.0/sobjects/Opportunity",
            &connections,
        );
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );

        let json = body_json(resp).await;
        assert_eq!(json["error"], "connection_host_mismatch");
        assert_eq!(json["requested_host"], "your-domain.my.salesforce.com");
        assert_eq!(json["provider"], "salesforce");
        assert_eq!(json["header"], crate::connect::CONNECTION_ID_HEADER);
        let conns = json["connections"].as_array().unwrap();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0]["id"], "conn_sf");
        assert_eq!(conns[0]["host"], "acme.my.salesforce.com");
        let message = json["message"].as_str().unwrap();
        assert!(
            message.contains("bound to acme.my.salesforce.com"),
            "{message}"
        );
        assert!(
            message.contains("went to your-domain.my.salesforce.com"),
            "{message}"
        );
        assert!(
            message.contains(
                "https://acme.my.salesforce.com/services/data/v60.0/sobjects/Opportunity"
            ),
            "the fix must be a copy-pasteable URL: {message}"
        );
    }

    /// Several bound hosts: list them all and point at the account header,
    /// rather than guessing one URL.
    #[tokio::test]
    async fn connection_host_mismatch_many_connections_lists_hosts_and_header() {
        let connections = vec![
            choice("conn_prod", "salesforce", Some("acme.my.salesforce.com")),
            choice(
                "conn_sandbox",
                "salesforce",
                Some("acme--dev.sandbox.my.salesforce.com"),
            ),
        ];
        let resp: Response<TestBody> =
            connection_host_mismatch("wrong.my.salesforce.com", "/services/data/", &connections);
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
        let json = body_json(resp).await;
        let message = json["message"].as_str().unwrap();
        assert!(message.contains("acme.my.salesforce.com"), "{message}");
        assert!(
            message.contains("acme--dev.sandbox.my.salesforce.com"),
            "{message}"
        );
        assert!(
            message.contains(crate::connect::CONNECTION_ID_HEADER),
            "{message}"
        );
        assert_eq!(json["connections"].as_array().unwrap().len(), 2);
    }

    /// Two accounts of the SAME org share a bound host. The agent's fix is one
    /// URL either way, so the message must collapse to the single-host form
    /// (and not read "bound to acme, acme").
    #[tokio::test]
    async fn connection_host_mismatch_dedupes_a_shared_bound_host() {
        let connections = vec![
            choice("conn_jane", "salesforce", Some("acme.my.salesforce.com")),
            choice("conn_bob", "salesforce", Some("acme.my.salesforce.com")),
        ];
        let resp: Response<TestBody> = connection_host_mismatch(
            "wrong.my.salesforce.com",
            "/services/data/v60.0/query",
            &connections,
        );
        let json = body_json(resp).await;
        let message = json["message"].as_str().unwrap();
        assert!(
            message.contains("https://acme.my.salesforce.com/services/data/v60.0/query"),
            "{message}"
        );
        assert_eq!(
            message.matches("acme.my.salesforce.com").count(),
            2,
            "named once as the bound host and once in the URL, never listed twice: {message}"
        );
        // Both accounts still ride along for the header-pinning protocol.
        assert_eq!(json["connections"].as_array().unwrap().len(), 2);
    }

    /// A fail-closed connection (no stored host) must not be handed a guess:
    /// the guidance is to reconnect, and the choice carries no `host` key.
    #[tokio::test]
    async fn connection_host_mismatch_without_bound_host_asks_to_reconnect() {
        let connections = vec![choice("conn_jf", "jfrog-artifactory", None)];
        let resp: Response<TestBody> =
            connection_host_mismatch("other.jfrog.io", "/artifactory/api/npm/npm/", &connections);
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
        let json = body_json(resp).await;
        let message = json["message"].as_str().unwrap();
        assert!(message.contains("reconnect"), "{message}");
        assert!(!message.contains("https://"), "no URL to copy: {message}");
        assert!(
            json["connections"][0].get("host").is_none(),
            "an absent host must be absent from the wire, not null"
        );
    }

    /// The `host` field is opt-in on the wire: choices without one serialize
    /// exactly as before, so the existing 409/404 bodies and the
    /// `x-onecli-connections` header are unchanged for non-gated providers.
    #[test]
    fn connection_choice_without_host_serializes_as_before() {
        let json = serde_json::to_value(choice("conn_1", "gmail", None)).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["display_name", "id", "label", "provider"]);
    }

    #[test]
    fn connection_host_mismatch_axum_matches_forward_variant() {
        let connections = vec![choice(
            "conn_sf",
            "salesforce",
            Some("acme.my.salesforce.com"),
        )];
        let resp = connection_host_mismatch_axum("wrong.my.salesforce.com", "/", &connections);
        assert_eq!(resp.status(), StatusCode::MISDIRECTED_REQUEST);
        assert_eq!(resp.headers().get("x-should-retry").unwrap(), "false");
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
    }
}
