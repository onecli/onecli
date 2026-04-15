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

/// Resolve the OneCLI dashboard base URL from `APP_URL`,
/// falling back to `http://localhost:10254`. Cached after first call.
fn dashboard_url() -> &'static str {
    static URL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    URL.get_or_init(|| {
        std::env::var("APP_URL")
            .unwrap_or_else(|_| "http://localhost:10254".to_string())
            .trim_end_matches('/')
            .to_string()
    })
}

/// Build a JSON error response with the given status code and body.
/// Used by `forward_request` (MITM and HTTP proxy forwarding path).
fn json_error<S>(status: StatusCode, body: serde_json::Value) -> Response<ForwardBody<S>> {
    let json = body.to_string();
    let mut response = Response::new(Either::Left(Full::new(Bytes::from(json))));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    response
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
    json_error_axum(StatusCode::CONFLICT, multiple_connections_json(connections))
}

/// JSON error response for requests to a known app that has no credentials configured.
///
/// Returned when `injection_count == 0` and the upstream returns 401/403 for a host
/// that matches a registered app provider. Tells the agent (and user) exactly what to do.
pub(crate) fn app_not_connected<S>(
    status: StatusCode,
    provider: &str,
    display_name: &str,
) -> Response<ForwardBody<S>> {
    let base = dashboard_url();
    let connect_url = format!("{base}/connections?connect={provider}");
    json_error(
        status,
        serde_json::json!({
            "error": "app_not_connected",
            "message": format!("{display_name} is not connected in OneCLI. Ask the user to open this URL to connect it: {connect_url}"),
            "provider": provider,
            "connect_url": connect_url,
        }),
    )
}

/// JSON error response when credentials exist for a host but the agent lacks access (selective mode).
/// Covers both manual secrets and app connections.
pub(crate) fn access_restricted<S>(
    status: StatusCode,
    provider: &str,
    display_name: &str,
    agent_id: Option<&str>,
) -> Response<ForwardBody<S>> {
    let base = dashboard_url();
    let manage_url = match agent_id {
        Some(id) => format!("{base}/agents?manage={}", id.get(..8).unwrap_or(id)),
        None => format!("{base}/agents"),
    };
    json_error(
        status,
        serde_json::json!({
            "error": "access_restricted",
            "message": format!("{display_name} credentials exist in OneCLI but this agent does not have access. Ask the user to grant access: {manage_url}"),
            "provider": provider,
            "manage_url": manage_url,
        }),
    )
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
) -> Response<ForwardBody<S>> {
    let base = dashboard_url();
    let encoded_host = utf8_percent_encode(hostname, NON_ALPHANUMERIC);
    let encoded_path = utf8_percent_encode(path, NON_ALPHANUMERIC);
    let secret_url = format!(
        "{base}/connections/secrets?create=generic&host={encoded_host}&path={encoded_path}"
    );
    json_error(
        status,
        serde_json::json!({
            "error": "credential_not_found",
            "message": format!(
                "No credentials configured for {hostname} in OneCLI.\n\n\
                 A pre-built link is provided in the `secret_url` field, pre-filled with:\n\
                 - host: {hostname}\n\
                 - path: {path}\n\n\
                 Before sending this link to the user, consider whether to adjust it. \
                 You can build a custom URL with any of these query parameters:\n\
                 {base}/connections/secrets?create=generic&host=<host>&path=<path>&name=<name>&header=<header>&format=<format>\n\n\
                 Available parameters:\n\
                 - `host` (required): hostname to match (e.g., api.example.com or *.example.com)\n\
                 - `path`: path pattern (e.g., /v1/* or /*). Defaults to the exact request path.\n\
                 - `name`: display name for the secret (e.g., 'Example API Key')\n\
                 - `header`: HTTP header name to inject (default: Authorization)\n\
                 - `format`: value format with {{value}} placeholder (default: Bearer {{value}})\n\n\
                 Examples of when to customize:\n\
                 - Change path to `/*` if the credential covers all endpoints on the host\n\
                 - Change header to `X-API-Key` if the API uses a custom header\n\
                 - Change format to `{{value}}` (raw) if the API expects the token without a prefix\n\n\
                 Once you've decided on the right link, ask the user to open it. \
                 They will see a pre-filled form where they paste their API key or token."
            ),
            "hostname": hostname,
            "path": path,
            "secret_url": secret_url,
        }),
    )
}

/// 409 Conflict — multiple connections exist for the same provider, agent must specify which one.
pub(crate) fn multiple_connections<S>(
    connections: &[crate::connect::ConnectionChoice],
) -> Response<ForwardBody<S>> {
    json_error(StatusCode::CONFLICT, multiple_connections_json(connections))
}

/// 404 Not Found — the requested connection ID does not exist.
pub(crate) fn connection_not_found<S>(
    connection_id: &str,
    connections: &[crate::connect::ConnectionChoice],
) -> Response<ForwardBody<S>> {
    let hdr = crate::connect::CONNECTION_ID_HEADER;
    json_error(
        StatusCode::NOT_FOUND,
        serde_json::json!({
            "error": "connection_not_found",
            "message": format!("Connection '{connection_id}' was not found or has been removed. Choose from the available connections."),
            "connections": connections,
            "header": hdr,
        }),
    )
}

/// 404 Not Found — the requested connection ID does not exist (axum body).
pub(super) fn connection_not_found_axum(
    connection_id: &str,
    connections: &[crate::connect::ConnectionChoice],
) -> Response<axum::body::Body> {
    let hdr = crate::connect::CONNECTION_ID_HEADER;
    json_error_axum(
        StatusCode::NOT_FOUND,
        serde_json::json!({
            "error": "connection_not_found",
            "message": format!("Connection '{connection_id}' was not found or has been removed. Choose from the available connections."),
            "connections": connections,
            "header": hdr,
        }),
    )
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
    json_error(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "manual_approval_denied",
            "message": format!("This request was {reason} by an OneCLI manual approval policy."),
            "approval_id": approval_id,
        }),
    )
}

/// 403 Forbidden — request blocked by a policy rule.
pub(crate) fn blocked_by_policy<S>(method: &str, path: &str) -> Response<ForwardBody<S>> {
    json_error(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "blocked_by_policy",
            "message": "This request was blocked by an OneCLI policy rule. Check your rules at https://onecli.sh or your OneCLI dashboard.",
            "method": method,
            "path": path,
        }),
    )
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
        let resp: Response<
            ForwardBody<
                futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
            >,
        > = app_not_connected(StatusCode::UNAUTHORIZED, "gmail", "Gmail");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
    }

    #[tokio::test]
    async fn app_not_connected_body_contains_provider_and_connect_url() {
        type TestBody = ForwardBody<
            futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
        >;
        let resp: Response<TestBody> = app_not_connected(StatusCode::FORBIDDEN, "github", "GitHub");
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

    #[test]
    fn access_restricted_preserves_status() {
        let resp: Response<
            ForwardBody<
                futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
            >,
        > = access_restricted(
            StatusCode::FORBIDDEN,
            "resend",
            "Resend",
            Some("abc12345-def"),
        );
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
    }

    #[tokio::test]
    async fn access_restricted_body_with_agent_id() {
        type TestBody = ForwardBody<
            futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
        >;
        let resp: Response<TestBody> = access_restricted(
            StatusCode::UNAUTHORIZED,
            "resend",
            "Resend",
            Some("abc12345-long-id"),
        );
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
        assert!(json["manage_url"]
            .as_str()
            .unwrap()
            .contains("/agents?manage=abc12345"));
    }

    #[tokio::test]
    async fn access_restricted_body_without_agent_id() {
        type TestBody = ForwardBody<
            futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
        >;
        let resp: Response<TestBody> =
            access_restricted(StatusCode::FORBIDDEN, "github", "GitHub", None);
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "access_restricted");
        assert!(json["manage_url"].as_str().unwrap().ends_with("/agents"));
    }

    #[tokio::test]
    async fn access_restricted_short_agent_id() {
        type TestBody = ForwardBody<
            futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
        >;
        let resp: Response<TestBody> =
            access_restricted(StatusCode::FORBIDDEN, "resend", "Resend", Some("abc"));
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert!(json["manage_url"]
            .as_str()
            .unwrap()
            .contains("/agents?manage=abc"));
    }

    #[tokio::test]
    async fn credential_not_found_includes_host_and_secret_url() {
        type TestBody = ForwardBody<
            futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
        >;
        let resp: Response<TestBody> = credential_not_found(
            StatusCode::UNAUTHORIZED,
            "api.custom-service.com",
            "/v1/send",
        );
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect full body").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        assert_eq!(json["error"], "credential_not_found");
        assert_eq!(json["hostname"], "api.custom-service.com");
        assert_eq!(json["path"], "/v1/send");
        assert!(json["secret_url"]
            .as_str()
            .unwrap()
            .contains("create=generic"));
        assert!(json["message"]
            .as_str()
            .unwrap()
            .contains("api.custom-service.com"));
    }

    #[tokio::test]
    async fn credential_not_found_encodes_special_characters() {
        type TestBody = ForwardBody<
            futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
        >;
        let resp: Response<TestBody> = credential_not_found(
            StatusCode::FORBIDDEN,
            "api.example.com",
            "/v1/send?to=user@test.com&subject=hello",
        );
        use http_body_util::BodyExt;
        let body = match resp.into_body() {
            Either::Left(full) => full.collect().await.expect("collect").to_bytes(),
            Either::Right(_) => panic!("expected Left"),
        };
        let json: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON");
        let secret_url = json["secret_url"].as_str().unwrap();
        // The & and = in the path should be encoded so they don't break the query string
        assert!(
            !secret_url.contains("&subject="),
            "path params must be encoded"
        );
        assert!(secret_url.contains("create=generic"));
        assert!(
            !secret_url.contains("method="),
            "method should not be in URL"
        );
    }

    #[tokio::test]
    async fn multiple_connections_returns_409_with_choices() {
        type TestBody = ForwardBody<
            futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
        >;
        let connections = vec![
            crate::connect::ConnectionChoice {
                id: "conn_1".to_string(),
                label: Some("alice@gmail.com".to_string()),
                provider: "gmail".to_string(),
            },
            crate::connect::ConnectionChoice {
                id: "conn_2".to_string(),
                label: Some("alice.work@company.com".to_string()),
                provider: "gmail".to_string(),
            },
        ];
        let resp: Response<TestBody> = multiple_connections(&connections);
        assert_eq!(resp.status(), StatusCode::CONFLICT);

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
        let resp: Response<
            ForwardBody<
                futures_util::stream::Empty<Result<hyper::body::Frame<Bytes>, reqwest::Error>>,
            >,
        > = multiple_connections(&[]);
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/json"
        );
    }
}
