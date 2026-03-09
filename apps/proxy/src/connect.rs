//! API resolution and caching for CONNECT decisions.
//!
//! When the proxy receives a CONNECT request, it calls `POST /api/proxy/connect`
//! to determine whether to intercept (MITM) or tunnel the connection, and what
//! injection rules to apply. Responses are cached per (agent_token, host) with
//! a configurable TTL.

use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

use crate::inject::ConnectRule;

/// How long to cache resolved connect responses before re-checking.
const CACHE_TTL: Duration = Duration::from_secs(60);

// ── Data types ──────────────────────────────────────────────────────────

/// Response from `POST /api/proxy/connect`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub(crate) struct ConnectResponse {
    pub intercept: bool,
    #[serde(default)]
    pub rules: Vec<ConnectRule>,
}

/// Request body sent to `POST /api/proxy/connect`.
#[derive(Serialize)]
struct ConnectRequest<'a> {
    agent_token: &'a str,
    host: &'a str,
}

/// Errors from the connect resolution.
#[derive(Debug)]
pub(crate) enum ConnectError {
    /// API returned 401 — invalid agent token.
    InvalidToken,
    /// API is unreachable or returned an unexpected error.
    ApiUnreachable(String),
}

// ── Cache ───────────────────────────────────────────────────────────────

/// Cached connect response with expiry.
pub(crate) struct CachedConnect {
    response: ConnectResponse,
    expires_at: Instant,
}

/// Cache key: (agent_token, host).
pub(crate) type ConnectCacheKey = (String, String);

// ── Resolution ──────────────────────────────────────────────────────────

/// Resolve what to do for an agent + host combination.
/// Checks the cache first, then calls `POST /api/proxy/connect` if needed.
pub(crate) async fn resolve(
    agent_token: &str,
    hostname: &str,
    http_client: &reqwest::Client,
    api_url: &str,
    proxy_secret: Option<&str>,
    cache: &DashMap<ConnectCacheKey, CachedConnect>,
) -> Result<ConnectResponse, ConnectError> {
    let cache_key = (agent_token.to_string(), hostname.to_string());

    // Check cache
    if let Some(entry) = cache.get(&cache_key) {
        if entry.expires_at > Instant::now() {
            return Ok(entry.response.clone());
        }
    }
    // Drop the ref before the await (entry borrows from DashMap)
    cache.remove(&cache_key);

    // Call the API
    let response = call_api(agent_token, hostname, http_client, api_url, proxy_secret).await?;

    // Cache the response
    cache.insert(
        cache_key,
        CachedConnect {
            response: response.clone(),
            expires_at: Instant::now() + CACHE_TTL,
        },
    );

    Ok(response)
}

/// Call `POST /api/proxy/connect` to resolve agent + host → intercept decision + rules.
async fn call_api(
    agent_token: &str,
    hostname: &str,
    http_client: &reqwest::Client,
    api_url: &str,
    proxy_secret: Option<&str>,
) -> Result<ConnectResponse, ConnectError> {
    let url = format!("{api_url}/api/proxy/connect");

    let mut request = http_client.post(&url).json(&ConnectRequest {
        agent_token,
        host: hostname,
    });

    // Attach proxy secret if available
    if let Some(secret) = proxy_secret {
        request = request.header("x-proxy-secret", secret);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| ConnectError::ApiUnreachable(format!("request failed: {e}")))?;

    match resp.status() {
        status if status.is_success() => {
            let body = resp
                .json::<ConnectResponse>()
                .await
                .map_err(|e| ConnectError::ApiUnreachable(format!("invalid response body: {e}")))?;
            Ok(body)
        }
        status if status == reqwest::StatusCode::UNAUTHORIZED => Err(ConnectError::InvalidToken),
        status if status == reqwest::StatusCode::FORBIDDEN => Err(ConnectError::ApiUnreachable(
            "proxy secret rejected (403)".to_string(),
        )),
        status => Err(ConnectError::ApiUnreachable(format!(
            "unexpected status: {status}"
        ))),
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_intercept_true() {
        let json = r#"{
            "intercept": true,
            "rules": [
                {
                    "path_pattern": "*",
                    "injections": [
                        { "action": "set_header", "name": "x-api-key", "value": "sk-ant-123" },
                        { "action": "remove_header", "name": "authorization" }
                    ]
                }
            ]
        }"#;

        let resp: ConnectResponse = serde_json::from_str(json).expect("parse");
        assert!(resp.intercept);
        assert_eq!(resp.rules.len(), 1);
        assert_eq!(resp.rules[0].path_pattern, "*");
        assert_eq!(resp.rules[0].injections.len(), 2);
        assert_eq!(
            resp.rules[0].injections[0],
            crate::inject::Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: "sk-ant-123".to_string(),
            }
        );
        assert_eq!(
            resp.rules[0].injections[1],
            crate::inject::Injection::RemoveHeader {
                name: "authorization".to_string(),
            }
        );
    }

    #[test]
    fn deserialize_intercept_false() {
        let json = r#"{ "intercept": false }"#;
        let resp: ConnectResponse = serde_json::from_str(json).expect("parse");
        assert!(!resp.intercept);
        assert!(resp.rules.is_empty());
    }

    #[test]
    fn deserialize_empty_rules() {
        let json = r#"{ "intercept": true, "rules": [] }"#;
        let resp: ConnectResponse = serde_json::from_str(json).expect("parse");
        assert!(resp.intercept);
        assert!(resp.rules.is_empty());
    }

    #[test]
    fn deserialize_multiple_rules() {
        let json = r#"{
            "intercept": true,
            "rules": [
                {
                    "path_pattern": "/v1/*",
                    "injections": [
                        { "action": "set_header", "name": "x-api-key", "value": "key1" }
                    ]
                },
                {
                    "path_pattern": "/v2/*",
                    "injections": [
                        { "action": "set_header", "name": "authorization", "value": "Bearer key2" }
                    ]
                }
            ]
        }"#;

        let resp: ConnectResponse = serde_json::from_str(json).expect("parse");
        assert_eq!(resp.rules.len(), 2);
        assert_eq!(resp.rules[0].path_pattern, "/v1/*");
        assert_eq!(resp.rules[1].path_pattern, "/v2/*");
    }

    #[test]
    fn cache_hit_returns_cached_response() {
        let cache: DashMap<ConnectCacheKey, CachedConnect> = DashMap::new();
        let key = ("oat_token1".to_string(), "api.anthropic.com".to_string());
        let response = ConnectResponse {
            intercept: true,
            rules: vec![],
        };

        cache.insert(
            key.clone(),
            CachedConnect {
                response: response.clone(),
                expires_at: Instant::now() + Duration::from_secs(30),
            },
        );

        let entry = cache.get(&key).expect("cache hit");
        assert!(entry.expires_at > Instant::now());
        assert_eq!(entry.response, response);
    }

    #[test]
    fn cache_expired_entry_is_stale() {
        let cache: DashMap<ConnectCacheKey, CachedConnect> = DashMap::new();
        let key = ("oat_token1".to_string(), "api.anthropic.com".to_string());

        cache.insert(
            key.clone(),
            CachedConnect {
                response: ConnectResponse {
                    intercept: true,
                    rules: vec![],
                },
                expires_at: Instant::now() - Duration::from_secs(1), // expired
            },
        );

        let entry = cache.get(&key).expect("cache has entry");
        assert!(entry.expires_at < Instant::now(), "entry should be expired");
    }
}
