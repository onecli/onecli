//! Policy resolution and caching for CONNECT decisions.
//!
//! Resolves what to do when the gateway receives a CONNECT request by querying
//! the database directly via SQLx. Responses are cached per (agent_token, host)
//! with a configurable TTL.

use std::sync::Arc;

use crate::cache::CacheStore;
use crate::crypto::CryptoService;
use crate::db;
use crate::inject::{Injection, InjectionRule};
use crate::policy::{PolicyAction, PolicyRule};

/// How long to cache resolved connect responses before re-checking.
const CACHE_TTL_SECS: u64 = 60;

// ── Data types ──────────────────────────────────────────────────────────

/// Result of policy resolution for a CONNECT request.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ConnectResponse {
    pub intercept: bool,
    pub injection_rules: Vec<InjectionRule>,
    pub policy_rules: Vec<PolicyRule>,
    pub account_id: Option<String>,
}

/// Errors from the connect resolution.
#[derive(Debug)]
pub(crate) enum ConnectError {
    /// Agent token is invalid (DB lookup found nothing).
    InvalidToken,
    /// An internal error occurred (DB query, decryption, etc.).
    Internal(String),
}

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
            db::find_secrets_by_account(&self.pool, &agent.account_id).await
        }
        .map_err(|e| ConnectError::Internal(format!("db error: {e}")))?;

        // 3. Filter secrets by host pattern
        let matching_secrets: Vec<_> = secrets
            .into_iter()
            .filter(|s| host_matches(hostname, &s.host_pattern))
            .collect();

        // 4. Policy rule lookup — global (agentId IS NULL) + agent-specific
        let all_rules = db::find_policy_rules_by_account(&self.pool, &agent.account_id)
            .await
            .map_err(|e| ConnectError::Internal(format!("db error: {e}")))?;

        let matching_policy_rules: Vec<PolicyRule> = all_rules
            .into_iter()
            .filter(|r| {
                host_matches(hostname, &r.host_pattern)
                    && (r.agent_id.is_none() || r.agent_id.as_deref() == Some(&agent.id))
            })
            .filter_map(|r| {
                let action = match r.action.as_str() {
                    "block" => PolicyAction::Block,
                    "rate_limit" => {
                        let max_requests = r.rate_limit.filter(|&v| v > 0)? as u64;
                        let window = r.rate_limit_window.as_deref()?;
                        let window_secs = match window {
                            "minute" => 60,
                            "hour" => 3600,
                            "day" => 86400,
                            _ => return None,
                        };
                        PolicyAction::RateLimit {
                            rule_id: r.id.clone(),
                            max_requests,
                            window_secs,
                        }
                    }
                    _ => return None,
                };
                Some(PolicyRule {
                    path_pattern: r.path_pattern.unwrap_or_else(|| "*".to_string()),
                    method: r.method,
                    action,
                })
            })
            .collect();

        if matching_secrets.is_empty() && matching_policy_rules.is_empty() {
            return Ok(ConnectResponse {
                intercept: false,
                injection_rules: vec![],
                policy_rules: vec![],
                account_id: Some(agent.account_id.clone()),
            });
        }

        // 5. Decrypt and build injection rules
        let mut injection_rules = Vec::with_capacity(matching_secrets.len());
        for secret in matching_secrets {
            let decrypted = self
                .crypto
                .decrypt(&secret.encrypted_value)
                .await
                .map_err(|e| ConnectError::Internal(format!("decrypt error: {e}")))?;

            let path_pattern = secret.path_pattern.unwrap_or_else(|| "*".to_string());
            let injections =
                build_injections(&secret.type_, &decrypted, secret.injection_config.as_ref());

            injection_rules.push(InjectionRule {
                path_pattern,
                injections,
            });
        }

        Ok(ConnectResponse {
            intercept: true,
            injection_rules,
            policy_rules: matching_policy_rules,
            account_id: Some(agent.account_id),
        })
    }
}

// ── Cached resolution ───────────────────────────────────────────────────

/// Resolve with caching. Checks the generic `CacheStore` first, then
/// queries the DB if needed. The cache key is namespaced as
/// `connect:{agent_token}:{hostname}`.
pub(crate) async fn resolve(
    agent_token: &str,
    hostname: &str,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<ConnectResponse, ConnectError> {
    let cache_key = format!("connect:{agent_token}:{hostname}");

    // Check cache
    if let Some(response) = cache.get::<ConnectResponse>(&cache_key).await {
        return Ok(response);
    }

    // Query the database
    let response = policy_engine
        .resolve_uncached(agent_token, hostname)
        .await?;

    // Cache the response
    cache.set(&cache_key, &response, CACHE_TTL_SECS).await;

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
                // OAuth: replace Authorization when the SDK sends the exchange
                // request. The temp API key from the exchange passes through
                // untouched on subsequent requests.
                vec![Injection::ReplaceHeader {
                    name: "authorization".to_string(),
                    value: format!("Bearer {decrypted_value}"),
                }]
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
    async fn new_store() -> std::sync::Arc<dyn crate::cache::CacheStore> {
        crate::cache::create_store().await.unwrap()
    }

    #[tokio::test]
    async fn cache_hit_returns_cached_response() {
        let store = new_store().await;
        let response = ConnectResponse {
            intercept: true,
            injection_rules: vec![],
            policy_rules: vec![],
            account_id: None,
        };

        store
            .set("connect:aoc_token1:api.anthropic.com", &response, 60)
            .await;

        let cached: Option<ConnectResponse> =
            store.get("connect:aoc_token1:api.anthropic.com").await;
        assert_eq!(cached, Some(response));
    }

    #[tokio::test]
    async fn cache_miss_returns_none() {
        let store = new_store().await;
        let cached: Option<ConnectResponse> = store.get("connect:missing:host").await;
        assert!(cached.is_none());
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
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::ReplaceHeader {
                name: "authorization".to_string(),
                value: "Bearer sk-ant-oat-test-token".to_string(),
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
