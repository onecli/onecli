//! Pre-built gateway responses for common error conditions.

use http_body_util::{Either, Full};
use hyper::body::Bytes;
use hyper::header::HeaderValue;
use hyper::{Response, StatusCode};

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
/// falling back to `http://localhost:10254`.
fn dashboard_url() -> String {
    std::env::var("APP_URL").unwrap_or_else(|_| "http://localhost:10254".to_string())
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
    let body = serde_json::json!({
        "error": "app_not_connected",
        "message": format!("{display_name} is not connected in OneCLI. Ask the user to connect it."),
        "provider": provider,
        "connect_url": format!("{base}/connections?connect={provider}"),
    })
    .to_string();

    let mut response = Response::new(Either::Left(Full::new(Bytes::from(body))));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    response
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
}
