//! Policy resolution and caching for CONNECT decisions.
//!
//! Resolves what to do when the gateway receives a CONNECT request by querying
//! the database directly via SQLx. Responses are cached per (agent_token, host)
//! with a configurable TTL.

use std::sync::Arc;

use tracing::debug;

use crate::apps;
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
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
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
    /// Look up agent by access token.
    async fn find_agent(&self, agent_token: &str) -> Result<db::AgentRow, ConnectError> {
        db::find_agent_by_token(&self.pool, agent_token)
            .await
            .map_err(db_err)?
            .ok_or(ConnectError::InvalidToken)
    }

    /// Resolve what to do for an agent + host combination (without caching).
    async fn resolve_uncached(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<ConnectResponse, ConnectError> {
        let injection_rules = self.resolve_injections(agent, hostname).await?;
        let policy_rules = self.resolve_policy_rules(agent, hostname).await?;
        let has_rules = !injection_rules.is_empty() || !policy_rules.is_empty();

        Ok(ConnectResponse {
            intercept: has_rules,
            injection_rules,
            policy_rules,
            account_id: Some(agent.account_id.clone()),
            agent_id: Some(agent.id.clone()),
            agent_name: Some(agent.name.clone()),
        })
    }

    /// Resolve all injection rules: secrets first, then app connections as fallback.
    async fn resolve_injections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<Vec<InjectionRule>, ConnectError> {
        let secret_rules = self.resolve_secret_injections(agent, hostname).await?;
        if !secret_rules.is_empty() {
            debug!(host = %hostname, count = secret_rules.len(), "resolve: using secrets");
            return Ok(secret_rules);
        }

        // Secrets take priority — only try app connections when no secret matched.
        let app_rules = self.resolve_app_injections(agent, hostname).await?;
        debug!(host = %hostname, count = app_rules.len(), "resolve: using app connections");
        Ok(app_rules)
    }

    /// Build injection rules from secrets matching this host.
    async fn resolve_secret_injections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<Vec<InjectionRule>, ConnectError> {
        let secrets = if agent.secret_mode == "selective" {
            db::find_secrets_by_agent(&self.pool, &agent.id).await
        } else {
            db::find_secrets_by_account(&self.pool, &agent.account_id).await
        }
        .map_err(db_err)?;

        let matching: Vec<_> = secrets
            .into_iter()
            .filter(|s| host_matches(hostname, &s.host_pattern))
            .collect();

        let mut rules = Vec::with_capacity(matching.len());
        for secret in &matching {
            let decrypted = self
                .crypto
                .decrypt(&secret.encrypted_value)
                .await
                .map_err(decrypt_err)?;

            let injections =
                build_injections(&secret.type_, &decrypted, secret.injection_config.as_ref());

            rules.push(InjectionRule {
                path_pattern: secret
                    .path_pattern
                    .clone()
                    .unwrap_or_else(|| "*".to_string()),
                injections,
            });
        }

        Ok(rules)
    }

    /// Build injection rules from app connections for this host.
    /// Only called when no secret matched (secrets take priority).
    ///
    /// Multiple providers can share a host with different path prefixes
    /// (e.g., Gmail on `/gmail/*` and Calendar on `/calendar/*`). Returns one
    /// `InjectionRule` per matching connection, each scoped to its path pattern.
    async fn resolve_app_injections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<Vec<InjectionRule>, ConnectError> {
        let providers = apps::providers_for_host(hostname);
        if providers.is_empty() {
            debug!(host = %hostname, "app_connections: no provider for host");
            return Ok(vec![]);
        }
        debug!(host = %hostname, providers = ?providers, "app_connections: matched providers");

        let connections = if agent.secret_mode == "selective" {
            db::find_app_connections_by_agent(&self.pool, &agent.id).await
        } else {
            db::find_app_connections_by_account(&self.pool, &agent.account_id).await
        }
        .map_err(db_err)?;

        let mut rules = Vec::new();
        for provider in &providers {
            let Some(conn) = connections.iter().find(|c| c.provider == *provider) else {
                continue;
            };
            let Some(ref encrypted_creds) = conn.credentials else {
                continue;
            };

            let decrypted_json = self
                .crypto
                .decrypt(encrypted_creds)
                .await
                .map_err(decrypt_err)?;

            let Some(token) = self
                .resolve_access_token(&decrypted_json, provider, &agent.account_id, &conn.id)
                .await
            else {
                continue;
            };

            for (path_pattern, injections) in
                apps::build_app_injection_rules(provider, hostname, &token)
            {
                rules.push(InjectionRule {
                    path_pattern,
                    injections,
                });
            }
        }

        Ok(rules)
    }

    /// Resolve policy rules (block / rate-limit) for this agent + host.
    async fn resolve_policy_rules(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<Vec<PolicyRule>, ConnectError> {
        let all_rules = db::find_policy_rules_by_account(&self.pool, &agent.account_id)
            .await
            .map_err(db_err)?;

        let rules = all_rules
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
                    "manual_approval" => PolicyAction::ManualApproval {
                        rule_id: r.id.clone(),
                    },
                    _ => return None,
                };
                Some(PolicyRule {
                    path_pattern: r.path_pattern.unwrap_or_else(|| "*".to_string()),
                    method: r.method,
                    action,
                })
            })
            .collect();

        Ok(rules)
    }

    /// Extract access token from decrypted credentials JSON, refreshing if expired.
    /// Resolves BYOC client credentials from AppConfig if available, falls back to env vars.
    /// On successful refresh, persists the new credentials back to the database.
    async fn resolve_access_token(
        &self,
        json: &str,
        provider: &str,
        account_id: &str,
        connection_id: &str,
    ) -> Option<String> {
        let mut creds: serde_json::Value = serde_json::from_str(json).ok()?;

        let mut token = creds
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(String::from);

        // Check if token is expired and needs refresh
        if let Some(expires_at) = creds.get("expires_at").and_then(|v| v.as_i64()) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before UNIX epoch")
                .as_secs() as i64;

            if expires_at < now {
                if let Some(refresh_token) = creds.get("refresh_token").and_then(|v| v.as_str()) {
                    if let Some(config) = apps::refresh_config(provider) {
                        // Resolve client credentials: BYOC AppConfig first, env vars as fallback
                        let byoc = self.resolve_byoc_credentials(account_id, provider).await;
                        let (byoc_id, byoc_secret) = match &byoc {
                            Some((id, secret)) => (Some(id.as_str()), Some(secret.as_str())),
                            None => (None, None),
                        };

                        match apps::refresh_access_token(
                            config,
                            refresh_token,
                            byoc_id,
                            byoc_secret,
                        )
                        .await
                        {
                            Ok((new_token, new_expires_at)) => {
                                debug!(provider = %provider, "refreshed expired token");
                                token = Some(new_token.clone());

                                // Persist refreshed credentials to DB so subsequent
                                // requests don't re-refresh until the new token expires.
                                creds["access_token"] = serde_json::Value::String(new_token);
                                creds["expires_at"] = serde_json::json!(new_expires_at);
                                self.persist_refreshed_credentials(connection_id, provider, &creds)
                                    .await;
                            }
                            Err(e) => {
                                debug!(provider = %provider, error = %e, "token refresh failed");
                            }
                        }
                    }
                }
            }
        }

        token
    }

    /// Encrypt and persist refreshed credentials back to the database.
    /// Failures are logged but do not prevent the current request from succeeding —
    /// the refreshed token is already available in memory.
    async fn persist_refreshed_credentials(
        &self,
        connection_id: &str,
        provider: &str,
        creds: &serde_json::Value,
    ) {
        let Ok(json) = serde_json::to_string(creds) else {
            debug!(provider = %provider, "failed to serialize refreshed credentials");
            return;
        };
        match self.crypto.encrypt(&json).await {
            Ok(encrypted) => {
                match db::update_app_connection_credentials(&self.pool, connection_id, &encrypted)
                    .await
                {
                    Ok(()) => {
                        debug!(provider = %provider, "persisted refreshed credentials");
                    }
                    Err(e) => {
                        debug!(provider = %provider, error = %e, "failed to persist refreshed credentials");
                    }
                }
            }
            Err(e) => {
                debug!(provider = %provider, error = %e, "failed to encrypt refreshed credentials");
            }
        }
    }

    /// Resolve BYOC client credentials from AppConfig for a given account + provider.
    /// Returns `Some((client_id, client_secret))` if an enabled config exists, `None` otherwise.
    async fn resolve_byoc_credentials(
        &self,
        account_id: &str,
        provider: &str,
    ) -> Option<(String, String)> {
        let config = db::find_app_config(&self.pool, account_id, provider)
            .await
            .ok()
            .flatten()?;

        // clientId is in settings (plain JSON)
        let client_id = config
            .settings
            .as_ref()
            .and_then(|s| s.get("clientId"))
            .and_then(|v| v.as_str())
            .map(String::from)?;

        // clientSecret is in credentials (encrypted)
        let encrypted = config.credentials.as_deref()?;
        let decrypted = self.crypto.decrypt(encrypted).await.ok()?;
        let secrets: serde_json::Value = serde_json::from_str(&decrypted).ok()?;
        let client_secret = secrets
            .get("clientSecret")
            .and_then(|v| v.as_str())
            .map(String::from)?;

        Some((client_id, client_secret))
    }
}

// ── Error helpers ──────────────────────────────────────────────────────

fn db_err(e: anyhow::Error) -> ConnectError {
    ConnectError::Internal(format!("db error: {e}"))
}

fn decrypt_err(e: anyhow::Error) -> ConnectError {
    ConnectError::Internal(format!("decrypt error: {e}"))
}

// ── Cached resolution ───────────────────────────────────────────────────

/// Resolve with caching. Checks the generic `CacheStore` first, then
/// queries the DB if needed. The cache key is namespaced as
/// `connect:{account_id}:{agent_token}:{hostname}` so that cache
/// invalidation can target all entries for an account by prefix.
pub(crate) async fn resolve(
    agent_token: &str,
    hostname: &str,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<ConnectResponse, ConnectError> {
    // Look up agent first — needed for account_id in cache key.
    let agent = policy_engine.find_agent(agent_token).await?;

    let cache_key = format!("connect:{}:{agent_token}:{hostname}", agent.account_id);

    // Check cache
    if let Some(response) = cache.get::<ConnectResponse>(&cache_key).await {
        debug!(host = %hostname, intercept = response.intercept, "resolve: cache hit");
        return Ok(response);
    }

    debug!(host = %hostname, "resolve: cache miss, querying DB");

    // Query the database (agent already resolved, avoids re-querying)
    let response = policy_engine.resolve_uncached(&agent, hostname).await?;

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
            agent_id: None,
            agent_name: None,
        };

        store
            .set(
                "connect:acc_123:aoc_token1:api.anthropic.com",
                &response,
                60,
            )
            .await;

        let cached: Option<ConnectResponse> = store
            .get("connect:acc_123:aoc_token1:api.anthropic.com")
            .await;
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
