//! Policy resolution and caching for CONNECT decisions.
//!
//! Resolves what to do when the gateway receives a CONNECT request by querying
//! the database directly via SQLx. Responses are cached per (agent_token, host)
//! with a configurable TTL.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::crypto::CryptoService;
use crate::db;
use crate::inject::{ConnectRule, Injection};
use dashmap::DashMap;

/// How long to cache resolved connect responses before re-checking.
const CACHE_TTL: Duration = Duration::from_secs(60);

// ── Data types ──────────────────────────────────────────────────────────

/// Result of policy resolution for a CONNECT request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ConnectResponse {
    pub intercept: bool,
    pub rules: Vec<ConnectRule>,
    pub user_id: Option<String>,
}

/// Errors from the connect resolution.
#[derive(Debug)]
pub(crate) enum ConnectError {
    /// Agent token is invalid (DB lookup found nothing).
    InvalidToken,
    /// An internal error occurred (DB query, decryption, etc.).
    Internal(String),
}

// ── Cache ───────────────────────────────────────────────────────────────

/// Cached connect response with expiry.
pub(crate) struct CachedConnect {
    response: ConnectResponse,
    expires_at: Instant,
}

/// Cache key: (agent_token, host).
pub(crate) type ConnectCacheKey = (String, String);

// ── PolicyEngine ───────────────────────────────────────────────────

/// Resolves CONNECT policy by querying the database directly via SQLx
/// and decrypting secrets in Rust.
pub(crate) struct PolicyEngine {
    pub pool: sqlx::PgPool,
    pub crypto: Arc<CryptoService>,
}

impl PolicyEngine {
    /// Resolve what to do for an agent + host combination (without caching).
    async fn resolve_uncached(
        &self,
        agent_token: &str,
        hostname: &str,
    ) -> Result<ConnectResponse, ConnectError> {
        // 1. Agent lookup
        let agent = db::find_agent_by_token(&self.pool, agent_token)
            .await
            .map_err(|e| ConnectError::Internal(format!("db error: {e}")))?
            .ok_or(ConnectError::InvalidToken)?;

        // 2. Secret lookup — branch on agent's secret mode
        let secrets = if agent.secret_mode == "selective" {
            db::find_secrets_by_agent(&self.pool, &agent.id).await
        } else {
            db::find_secrets_by_user(&self.pool, &agent.user_id).await
        }
        .map_err(|e| ConnectError::Internal(format!("db error: {e}")))?;

        // 3. Filter by host pattern
        let matching: Vec<_> = secrets
            .into_iter()
            .filter(|s| host_matches(hostname, &s.host_pattern))
            .collect();

        if matching.is_empty() {
            return Ok(ConnectResponse {
                intercept: false,
                rules: vec![],
                user_id: Some(agent.user_id.clone()),
            });
        }

        // 4. Decrypt and build injection rules
        let mut rules = Vec::with_capacity(matching.len());
        for secret in matching {
            let decrypted = self
                .crypto
                .decrypt(&secret.encrypted_value)
                .map_err(|e| ConnectError::Internal(format!("decrypt error: {e}")))?;

            let path_pattern = secret.path_pattern.unwrap_or_else(|| "*".to_string());
            let injections =
                build_injections(&secret.type_, &decrypted, secret.injection_config.as_ref());

            rules.push(ConnectRule {
                path_pattern,
                injections,
            });
        }

        Ok(ConnectResponse {
            intercept: true,
            rules,
            user_id: Some(agent.user_id),
        })
    }
}

// ── Cached resolution ───────────────────────────────────────────────────

/// Resolve with caching. Checks the cache first, then queries the DB if needed.
pub(crate) async fn resolve(
    agent_token: &str,
    hostname: &str,
    policy_engine: &PolicyEngine,
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

    // Query the database
    let response = policy_engine
        .resolve_uncached(agent_token, hostname)
        .await?;

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

// ── Host matching ───────────────────────────────────────────────────────

/// Check if a requested hostname matches a secret's host pattern.
/// Supports exact match and wildcard prefix (`*.example.com` matches `api.example.com`).
fn host_matches(request_host: &str, pattern: &str) -> bool {
    if request_host == pattern {
        return true;
    }

    if let Some(suffix) = pattern.strip_prefix('*') {
        // "*.example.com" → suffix = ".example.com"
        return request_host.ends_with(suffix) && request_host.len() > suffix.len();
    }

    false
}

// ── Injection building ──────────────────────────────────────────────────

/// Build injection instructions for a secret based on its type.
/// Mirrors the logic in `apps/web/src/app/api/gateway/connect/route.ts`.
fn build_injections(
    secret_type: &str,
    decrypted_value: &str,
    injection_config: Option<&serde_json::Value>,
) -> Vec<Injection> {
    match secret_type {
        "anthropic" => {
            let is_oauth = decrypted_value.starts_with("sk-ant-oat");
            if is_oauth {
                vec![
                    Injection::SetHeader {
                        name: "authorization".to_string(),
                        value: format!("Bearer {decrypted_value}"),
                    },
                    Injection::RemoveHeader {
                        name: "x-api-key".to_string(),
                    },
                ]
            } else {
                vec![
                    Injection::SetHeader {
                        name: "x-api-key".to_string(),
                        value: decrypted_value.to_string(),
                    },
                    Injection::RemoveHeader {
                        name: "authorization".to_string(),
                    },
                ]
            }
        }

        "generic" => {
            let config = injection_config.and_then(|v| v.as_object());
            let header_name = config
                .and_then(|c| c.get("headerName"))
                .and_then(|v| v.as_str());

            let Some(header_name) = header_name else {
                return vec![];
            };

            let value_format = config
                .and_then(|c| c.get("valueFormat"))
                .and_then(|v| v.as_str());

            let value = match value_format {
                Some(fmt) => fmt.replace("{value}", decrypted_value),
                None => decrypted_value.to_string(),
            };

            vec![Injection::SetHeader {
                name: header_name.to_string(),
                value,
            }]
        }

        _ => vec![],
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_returns_cached_response() {
        let cache: DashMap<ConnectCacheKey, CachedConnect> = DashMap::new();
        let key = ("aoc_token1".to_string(), "api.anthropic.com".to_string());
        let response = ConnectResponse {
            intercept: true,
            rules: vec![],
            user_id: None,
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
        let key = ("aoc_token1".to_string(), "api.anthropic.com".to_string());

        cache.insert(
            key.clone(),
            CachedConnect {
                response: ConnectResponse {
                    intercept: true,
                    rules: vec![],
                    user_id: None,
                },
                expires_at: Instant::now() - Duration::from_secs(1), // expired
            },
        );

        let entry = cache.get(&key).expect("cache has entry");
        assert!(entry.expires_at < Instant::now(), "entry should be expired");
    }

    // ── host_matches ────────────────────────────────────────────────────

    #[test]
    fn host_exact_match() {
        assert!(host_matches("api.anthropic.com", "api.anthropic.com"));
        assert!(!host_matches("api.anthropic.com", "other.com"));
    }

    #[test]
    fn host_wildcard_match() {
        assert!(host_matches("api.example.com", "*.example.com"));
        assert!(host_matches("sub.example.com", "*.example.com"));
        assert!(!host_matches("example.com", "*.example.com"));
        assert!(!host_matches("api.other.com", "*.example.com"));
    }

    #[test]
    fn host_wildcard_no_match_without_dot() {
        assert!(!host_matches("notexample.com", "*.example.com"));
    }

    // ── build_injections ────────────────────────────────────────────────

    #[test]
    fn build_injections_anthropic_api_key() {
        let injections = build_injections("anthropic", "sk-ant-api03-test", None);
        assert_eq!(injections.len(), 2);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: "sk-ant-api03-test".to_string(),
            }
        );
        assert_eq!(
            injections[1],
            Injection::RemoveHeader {
                name: "authorization".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_anthropic_oauth() {
        let injections = build_injections("anthropic", "sk-ant-oat-test-token", None);
        assert_eq!(injections.len(), 2);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer sk-ant-oat-test-token".to_string(),
            }
        );
        assert_eq!(
            injections[1],
            Injection::RemoveHeader {
                name: "x-api-key".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_with_format() {
        let config = serde_json::json!({
            "headerName": "authorization",
            "valueFormat": "Bearer {value}"
        });
        let injections = build_injections("generic", "my-secret", Some(&config));
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer my-secret".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_without_format() {
        let config = serde_json::json!({
            "headerName": "x-custom-key"
        });
        let injections = build_injections("generic", "raw-value", Some(&config));
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "x-custom-key".to_string(),
                value: "raw-value".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_missing_header_name() {
        let config = serde_json::json!({});
        let injections = build_injections("generic", "value", Some(&config));
        assert!(injections.is_empty());
    }

    #[test]
    fn build_injections_generic_no_config() {
        let injections = build_injections("generic", "value", None);
        assert!(injections.is_empty());
    }

    #[test]
    fn build_injections_unknown_type() {
        let injections = build_injections("unknown", "value", None);
        assert!(injections.is_empty());
    }
}
