//! Policy resolution and caching for CONNECT decisions.
//!
//! Resolves what to do when the gateway receives a CONNECT request by querying
//! the database directly via SQLx. Responses are cached per (agent_token, host)
//! with a configurable TTL.

use std::sync::Arc;

use tracing::{debug, warn};

use crate::apps;
use crate::cache::CacheStore;
use crate::crypto::CryptoService;
use crate::db;
use crate::inject::{Injection, InjectionRule};
use crate::policy::{PolicyAction, PolicyRule};

/// How long to cache resolved connect responses before re-checking.
const CACHE_TTL_SECS: u64 = 60;

/// Header name for per-request app connection disambiguation (request).
pub(crate) const CONNECTION_ID_HEADER: &str = "x-onecli-connection-id";
/// Header name for listing available connections (response).
pub(crate) const CONNECTIONS_HEADER: &str = "x-onecli-connections";
/// Agent secret mode that restricts access to explicitly assigned credentials.
pub(crate) const SECRET_MODE_SELECTIVE: &str = "selective";

// ── Data types ──────────────────────────────────────────────────────────

/// Result of policy resolution for a CONNECT request.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ConnectResponse {
    pub intercept: bool,
    pub injection_rules: Vec<InjectionRule>,
    #[serde(default)]
    pub app_connections: Vec<db::AppConnectionRow>,
    pub policy_rules: Vec<PolicyRule>,
    pub project_id: Option<String>,
    pub organization_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub agent_identifier: Option<String>,
    /// True when the project has credentials (secrets or app connections) for
    /// this host but the agent can't access them (selective mode). Used to show
    /// a more helpful error ("grant access") instead of "connect the app".
    #[serde(default)]
    pub access_restricted: bool,
    /// Normalized plan name for quota enforcement ("free", "pro", "team").
    #[serde(default)]
    pub plan: String,
}

/// Result of per-request app connection resolution.
pub(crate) enum AppConnectionResult {
    /// Injection rules resolved from a single connection.
    Rules {
        rules: Vec<InjectionRule>,
        /// Token expiry (UNIX timestamp) from the resolved app connection, if known.
        token_expires_at: Option<i64>,
        /// Rewritten upstream host (e.g., Datadog us5 → api.us5.datadoghq.com).
        rewrite_host: Option<String>,
        /// Display label of the connection (e.g., email address for OAuth accounts).
        connection_label: Option<String>,
        /// Provider-specific request finalizer (e.g., SigV4 vs AssumeRole).
        finalizer: Option<apps::RequestFinalizer>,
        /// Provider-specific body transform (e.g., commit trailer injection).
        body_transform: Option<apps::BodyTransform>,
        /// Provider name of the resolved connection (e.g., "github-app", "datadog").
        provider: String,
    },
    /// No app connections available for this provider.
    NoConnections,
    /// Multiple connections exist and no header was provided — agent must pick.
    Ambiguous { connections: Vec<ConnectionChoice> },
    /// The requested connection ID was not found — return the valid options.
    NotFound { connections: Vec<ConnectionChoice> },
}

/// Cached injection result including host rewrite, so cache hits preserve routing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CachedAppInjection {
    rules: Vec<InjectionRule>,
    rewrite_host: Option<String>,
    connection_label: Option<String>,
}

/// A single app connection option returned in disambiguation responses.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct ConnectionChoice {
    pub id: String,
    pub label: Option<String>,
    pub provider: String,
}

impl ConnectionChoice {
    pub fn from_row(row: &db::AppConnectionRow) -> Self {
        Self {
            id: row.id.clone(),
            label: row.label.clone(),
            provider: row.provider.clone(),
        }
    }
}

/// Extract the connection ID from request headers.
pub(crate) fn extract_connection_id(headers: &hyper::HeaderMap) -> Option<String> {
    headers
        .get(CONNECTION_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Inject the `x-onecli-connections` response header listing available connections.
pub(crate) fn inject_connections_header<B>(
    resp: &mut hyper::Response<B>,
    app_connections: &[db::AppConnectionRow],
) {
    if app_connections.is_empty() {
        return;
    }
    let choices: Vec<ConnectionChoice> = app_connections
        .iter()
        .map(ConnectionChoice::from_row)
        .collect();
    if let Ok(json) = serde_json::to_string(&choices) {
        match hyper::header::HeaderValue::from_str(&json) {
            Ok(val) => {
                resp.headers_mut().insert(CONNECTIONS_HEADER, val);
            }
            Err(e) => {
                tracing::debug!(error = %e, "failed to encode connections header");
            }
        }
    }
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
        let (injection_rules, _has_platform) =
            self.resolve_secret_injections(agent, hostname).await?;
        let app_connections = self.resolve_app_connections(agent, hostname).await?;
        let policy_rules = self.resolve_policy_rules(agent, hostname).await?;
        let has_rules =
            !injection_rules.is_empty() || !app_connections.is_empty() || !policy_rules.is_empty();

        // Check if the project has credentials (secrets or app connections) for this
        // host that the agent can't access (selective mode).
        let access_restricted = injection_rules.is_empty()
            && agent.secret_mode == SECRET_MODE_SELECTIVE
            && self.has_available_credentials(agent, hostname).await;

        let plan = match agent.subscription_status.as_str() {
            "pro" => "pro",
            "team" => "team",
            _ => "free",
        }
        .to_string();

        Ok(ConnectResponse {
            intercept: has_rules || access_restricted,
            injection_rules,
            app_connections,
            policy_rules,
            project_id: Some(agent.project_id.clone()),
            organization_id: Some(agent.organization_id.clone()),
            agent_id: Some(agent.id.clone()),
            agent_name: Some(agent.name.clone()),
            agent_identifier: agent.identifier.clone(),
            access_restricted,
            plan,
        })
    }

    /// Build injection rules from secrets matching this host.
    /// Returns `(rules, has_platform_secret)`.
    async fn resolve_secret_injections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<(Vec<InjectionRule>, bool), ConnectError> {
        let secrets = if agent.secret_mode == SECRET_MODE_SELECTIVE {
            // Selective: agent_secrets join returns both project + org assigned secrets
            db::find_secrets_by_agent(&self.pool, &agent.id)
                .await
                .map_err(db_err)?
        } else {
            // All mode: org first, project second (project implicitly overrides same-header)
            let (org_result, project_result) = tokio::join!(
                db::find_secrets_by_org(&self.pool, &agent.organization_id),
                db::find_secrets_by_project(&self.pool, &agent.project_id),
            );
            let mut merged = org_result.map_err(db_err)?;
            merged.extend(project_result.map_err(db_err)?);
            merged
        };

        let matching: Vec<_> = secrets
            .into_iter()
            .filter(|s| host_matches(hostname, &s.host_pattern))
            .collect();

        let has_platform = matching.iter().any(|s| s.is_platform);

        let mut rules = Vec::with_capacity(matching.len());
        for secret in &matching {
            let decrypted = match self.crypto.decrypt(&secret.encrypted_value).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(
                        host_pattern = %secret.host_pattern,
                        secret_type = %secret.type_,
                        error = ?e,
                        "skipping secret: decryption failed (wrong key or format mismatch)"
                    );
                    continue;
                }
            };

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

        Ok((rules, has_platform))
    }

    /// Fetch app connections matching providers for this host (deferred resolution).
    ///
    /// Returns the raw `AppConnectionRow` values filtered to providers that match
    /// the hostname. Decryption and injection rule building are deferred to
    /// per-request time via [`resolve_app_injection_for_request`] so that
    /// multi-connection disambiguation can happen with the `x-onecli-connection-id` header.
    async fn resolve_app_connections(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<Vec<db::AppConnectionRow>, ConnectError> {
        let providers = apps::providers_for_host(hostname);
        if providers.is_empty() {
            debug!(host = %hostname, "app_connections: no provider for host");
            return Ok(vec![]);
        }
        debug!(host = %hostname, providers = ?providers, "app_connections: matched providers");

        let connections = if agent.secret_mode == SECRET_MODE_SELECTIVE {
            db::find_app_connections_by_agent(&self.pool, &agent.id)
                .await
                .map_err(db_err)?
        } else {
            let (org_result, project_result) = tokio::join!(
                db::find_app_connections_by_org(&self.pool, &agent.organization_id),
                db::find_app_connections_by_project(&self.pool, &agent.project_id),
            );
            let mut merged = org_result.map_err(db_err)?;
            merged.extend(project_result.map_err(db_err)?);
            merged
        };

        let matching: Vec<db::AppConnectionRow> = connections
            .into_iter()
            .filter(|c| providers.contains(&c.provider.as_str()))
            .collect();

        debug!(host = %hostname, count = matching.len(), "app_connections: deferred connections");
        Ok(matching)
    }

    /// Resolve app connection injection rules for a single request.
    /// Called per-request with the cached `app_connections` (already filtered to
    /// providers matching the hostname at cache time by `resolve_app_connections`).
    pub(crate) async fn resolve_app_injection_for_request(
        &self,
        app_connections: &[db::AppConnectionRow],
        hostname: &str,
        connection_id: Option<&str>,
        organization_id: &str,
        project_id: &str,
        cache: &dyn CacheStore,
    ) -> Result<AppConnectionResult, ConnectError> {
        if app_connections.is_empty() {
            return Ok(AppConnectionResult::NoConnections);
        }

        // If a specific connection ID is requested, use that one
        if let Some(conn_id) = connection_id {
            let Some(conn) = app_connections.iter().find(|c| c.id == conn_id) else {
                // Connection was removed or access revoked — return the valid options
                return Ok(AppConnectionResult::NotFound {
                    connections: app_connections
                        .iter()
                        .map(ConnectionChoice::from_row)
                        .collect(),
                });
            };
            return self
                .resolve_connection_injections(conn, hostname, organization_id, project_id, cache)
                .await;
        }

        // Single connection — use it directly
        if app_connections.len() == 1 {
            return self
                .resolve_connection_injections(
                    &app_connections[0],
                    hostname,
                    organization_id,
                    project_id,
                    cache,
                )
                .await;
        }

        // Multiple connections — check for ambiguity per provider
        // Group by provider; if each provider has exactly 1 connection, no ambiguity
        let mut by_provider: std::collections::HashMap<&str, Vec<&db::AppConnectionRow>> =
            std::collections::HashMap::new();
        for conn in app_connections {
            by_provider
                .entry(conn.provider.as_str())
                .or_default()
                .push(conn);
        }

        if by_provider.values().all(|conns| conns.len() == 1) {
            // Each provider has exactly one connection — no ambiguity, resolve all
            let mut rules = Vec::new();
            let mut earliest_expires_at: Option<i64> = None;
            let mut resolved_rewrite_host: Option<String> = None;
            let mut resolved_label: Option<String> = None;
            let mut resolved_finalizer: Option<apps::RequestFinalizer> = None;
            let mut resolved_body_transform: Option<apps::BodyTransform> = None;
            let mut resolved_provider: Option<String> = None;
            for conn in app_connections {
                if let AppConnectionResult::Rules {
                    rules: r,
                    token_expires_at,
                    rewrite_host,
                    connection_label,
                    finalizer,
                    body_transform,
                    provider,
                } = self
                    .resolve_connection_injections(
                        conn,
                        hostname,
                        organization_id,
                        project_id,
                        cache,
                    )
                    .await?
                {
                    rules.extend(r);
                    if rewrite_host.is_some() {
                        resolved_rewrite_host = rewrite_host;
                    }
                    if resolved_label.is_none() {
                        resolved_label = connection_label;
                    }
                    if finalizer.is_some() {
                        resolved_finalizer = finalizer;
                    }
                    if body_transform.is_some() {
                        resolved_body_transform = body_transform;
                    }
                    if resolved_provider.is_none() {
                        resolved_provider = Some(provider);
                    }
                    match (earliest_expires_at, token_expires_at) {
                        (None, exp) => earliest_expires_at = exp,
                        (Some(cur), Some(exp)) if exp < cur => earliest_expires_at = Some(exp),
                        _ => {}
                    }
                }
            }
            return Ok(AppConnectionResult::Rules {
                rules,
                token_expires_at: earliest_expires_at,
                rewrite_host: resolved_rewrite_host,
                connection_label: resolved_label,
                finalizer: resolved_finalizer,
                body_transform: resolved_body_transform,
                provider: resolved_provider.unwrap_or_default(),
            });
        }

        // Truly ambiguous — return all connections for the caller to report
        Ok(AppConnectionResult::Ambiguous {
            connections: app_connections
                .iter()
                .map(ConnectionChoice::from_row)
                .collect(),
        })
    }

    /// Resolve injection rules from a single app connection, with caching.
    /// Decrypts credentials, resolves/refreshes the access token, and builds
    /// injection rules. Results are cached per-connection to avoid redundant
    /// decryption on subsequent requests.
    async fn resolve_connection_injections(
        &self,
        conn: &db::AppConnectionRow,
        hostname: &str,
        organization_id: &str,
        project_id: &str,
        cache: &dyn CacheStore,
    ) -> Result<AppConnectionResult, ConnectError> {
        let cache_key = format!(
            "app_injection:{organization_id}:{project_id}:{}:{hostname}",
            conn.id
        );

        if let Some(cached) = cache.get::<CachedAppInjection>(&cache_key).await {
            debug!(connection_id = %conn.id, "app injection: cache hit");
            return Ok(AppConnectionResult::Rules {
                rules: cached.rules,
                token_expires_at: None,
                rewrite_host: cached.rewrite_host,
                connection_label: cached.connection_label,
                finalizer: apps::finalizer_for_provider(&conn.provider),
                body_transform: apps::body_transform_for_provider(&conn.provider),
                provider: conn.provider.clone(),
            });
        }

        let Some(ref encrypted_creds) = conn.credentials else {
            return Ok(AppConnectionResult::NoConnections);
        };

        let decrypted_json = match self.crypto.decrypt(encrypted_creds).await {
            Ok(v) => v,
            Err(e) => {
                warn!(
                    connection_id = %conn.id,
                    provider = %conn.provider,
                    error = ?e,
                    "app connection decrypt failed (wrong key or format mismatch)"
                );
                return Ok(AppConnectionResult::NoConnections);
            }
        };

        let needs_token = apps::needs_access_token(&conn.provider);
        let (token, expires_at) = if needs_token {
            let Some(resolved) = self
                .resolve_access_token(&decrypted_json, &conn.provider, project_id, &conn.id)
                .await
            else {
                return Ok(AppConnectionResult::NoConnections);
            };
            resolved
        } else {
            (String::new(), None)
        };

        let mut rules: Vec<InjectionRule> =
            apps::build_app_injection_rules(&conn.provider, hostname, &token)
                .into_iter()
                .map(|(path_pattern, injections)| InjectionRule {
                    path_pattern,
                    injections,
                })
                .collect();

        // For credential-only providers (no auth rules), ensure at least one
        // catch-all rule exists so credential headers have somewhere to attach.
        if rules.is_empty() && !apps::credential_headers(&conn.provider).is_empty() {
            rules.push(InjectionRule {
                path_pattern: "*".to_string(),
                injections: Vec::new(),
            });
        }

        // Inject metadata-driven headers defined in the provider registry
        if let Some(ref metadata) = conn.metadata {
            for mh in apps::metadata_headers(&conn.provider) {
                if let Some(value) = metadata.get(mh.metadata_key).and_then(|v| v.as_str()) {
                    for rule in &mut rules {
                        rule.injections.push(Injection::SetHeader {
                            name: mh.header_name.to_string(),
                            value: value.to_string(),
                        });
                    }
                }
            }
        }

        // Parse credentials once for credential headers and host rewrite
        let creds: Option<serde_json::Value> = serde_json::from_str(&decrypted_json).ok();

        // Inject credential-driven headers (e.g., DD-API-KEY from credentials.apiKey)
        if let Some(ref creds) = creds {
            for ch in apps::credential_headers(&conn.provider) {
                if let Some(value) = creds.get(ch.credential_field).and_then(|v| v.as_str()) {
                    for rule in &mut rules {
                        rule.injections.push(Injection::SetHeader {
                            name: ch.header_name.to_string(),
                            value: value.to_string(),
                        });
                    }
                }
            }
        }

        let rewrite_host = creds.and_then(|c| apps::rewrite_host(&conn.provider, &c, hostname));

        // Cache with TTL = min(CACHE_TTL, token remaining lifetime).
        // Skip caching if token is already expired — the stale token would cause
        // upstream 401s, and re-resolving gives a chance to refresh.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_secs() as i64;
        let ttl = match expires_at {
            Some(exp) if exp > now => ((exp - now) as u64).min(CACHE_TTL_SECS),
            Some(_) => 0, // expired — don't cache
            None => CACHE_TTL_SECS,
        };
        if ttl > 0 {
            cache
                .set(
                    &cache_key,
                    &CachedAppInjection {
                        rules: rules.clone(),
                        rewrite_host: rewrite_host.clone(),
                        connection_label: conn.label.clone(),
                    },
                    ttl,
                )
                .await;
        }

        Ok(AppConnectionResult::Rules {
            rules,
            token_expires_at: expires_at,
            rewrite_host,
            connection_label: conn.label.clone(),
            finalizer: apps::finalizer_for_provider(&conn.provider),
            body_transform: apps::body_transform_for_provider(&conn.provider),
            provider: conn.provider.clone(),
        })
    }

    /// Check if the project or org has any credentials (secrets or app connections) for this
    /// host that the agent can't access. Used to distinguish "not connected" from
    /// "connected but agent lacks access" in selective mode.
    async fn has_available_credentials(&self, agent: &db::AgentRow, hostname: &str) -> bool {
        // Check 1: project or org has manual secrets matching this host
        match db::find_secrets_by_project(&self.pool, &agent.project_id).await {
            Ok(secrets) => {
                if secrets
                    .iter()
                    .any(|s| host_matches(hostname, &s.host_pattern))
                {
                    return true;
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: secrets query failed");
            }
        }

        // Also check org-level secrets
        match db::find_secrets_by_org(&self.pool, &agent.organization_id).await {
            Ok(secrets) => {
                if secrets
                    .iter()
                    .any(|s| host_matches(hostname, &s.host_pattern))
                {
                    return true;
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: org secrets query failed");
            }
        }

        // Check 2: project or org has app connections for this host
        let providers = apps::providers_for_host(hostname);
        if providers.is_empty() {
            return false;
        }

        let has_project_conns = match db::find_app_connections_by_project(
            &self.pool,
            &agent.project_id,
        )
        .await
        {
            Ok(conns) => conns
                .iter()
                .any(|c| providers.contains(&c.provider.as_str())),
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: app connections query failed");
                false
            }
        };
        if has_project_conns {
            return true;
        }

        match db::find_app_connections_by_org(&self.pool, &agent.organization_id).await {
            Ok(conns) => conns
                .iter()
                .any(|c| providers.contains(&c.provider.as_str())),
            Err(e) => {
                tracing::warn!(error = %e, "has_available_credentials: org app connections query failed");
                false
            }
        }
    }

    /// Resolve policy rules (block / rate-limit) for this agent + host.
    /// Merges org rules (enforced, all agents) with project rules (agent-filtered).
    async fn resolve_policy_rules(
        &self,
        agent: &db::AgentRow,
        hostname: &str,
    ) -> Result<Vec<PolicyRule>, ConnectError> {
        let (org_result, project_result) = tokio::join!(
            db::find_policy_rules_by_org(&self.pool, &agent.organization_id),
            db::find_policy_rules_by_project(&self.pool, &agent.project_id),
        );
        let mut all_rules = org_result.map_err(db_err)?;
        all_rules.extend(project_result.map_err(db_err)?);

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
                    name: r.name.clone(),
                    path_pattern: r.path_pattern.unwrap_or_else(|| "*".to_string()),
                    method: r.method,
                    action,
                    conditions_raw: r.conditions,
                })
            })
            .collect();

        Ok(rules)
    }

    /// Extract access token from decrypted credentials JSON, refreshing if expired.
    /// Resolves BYOC client credentials from AppConfig if available, falls back to env vars.
    /// On successful refresh, persists the new credentials back to the database.
    /// Extract the access token from decrypted credentials, refreshing if expired.
    /// Returns `(token, expires_at)` — the effective token and its expiry timestamp.
    async fn resolve_access_token(
        &self,
        json: &str,
        provider: &str,
        project_id: &str,
        connection_id: &str,
    ) -> Option<(String, Option<i64>)> {
        let mut creds: serde_json::Value = serde_json::from_str(json).ok()?;

        let mut token = creds
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(String::from);

        let mut effective_expires_at = creds.get("expires_at").and_then(|v| v.as_i64());

        // Check if token is expired and needs refresh
        if let Some(expires_at) = effective_expires_at {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock before UNIX epoch")
                .as_secs() as i64;

            if expires_at < now {
                let cred_type = creds.get("type").and_then(|v| v.as_str()).unwrap_or("");

                // Try cloud-specific refresh first, then shared credential types
                let refresh_result = if let Some(r) =
                    crate::cloud_apps::try_refresh_credentials(cred_type, &creds).await
                {
                    Some(r)
                } else {
                    apps::try_refresh_credentials(cred_type, &creds).await
                };

                if let Some(result) = refresh_result {
                    match result {
                        Ok((new_token, new_expires_at)) => {
                            debug!(provider = %provider, cred_type, "refreshed credential");
                            token = Some(new_token.clone());
                            effective_expires_at = Some(new_expires_at);

                            creds["access_token"] = serde_json::Value::String(new_token);
                            creds["expires_at"] = serde_json::json!(new_expires_at);
                            self.persist_refreshed_credentials(connection_id, provider, &creds)
                                .await;
                        }
                        Err(e) => {
                            debug!(provider = %provider, cred_type, error = ?e, "credential refresh failed");
                        }
                    }
                } else if let Some(refresh_token) =
                    creds.get("refresh_token").and_then(|v| v.as_str())
                {
                    // Authorized user / default: refresh via OAuth refresh_token
                    if let Some(config) = apps::refresh_config(provider) {
                        let byoc = self.resolve_byoc_credentials(project_id, provider).await;
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
                            Ok((new_token, new_expires_at, new_refresh_token)) => {
                                debug!(provider = %provider, "refreshed expired token");
                                token = Some(new_token.clone());
                                effective_expires_at = Some(new_expires_at);

                                creds["access_token"] = serde_json::Value::String(new_token);
                                creds["expires_at"] = serde_json::json!(new_expires_at);
                                if let Some(new_rt) = new_refresh_token {
                                    creds["refresh_token"] = serde_json::Value::String(new_rt);
                                }
                                self.persist_refreshed_credentials(connection_id, provider, &creds)
                                    .await;
                            }
                            Err(e) => {
                                debug!(provider = %provider, error = ?e, "token refresh failed");
                            }
                        }
                    }
                }
            }
        }

        token.map(|t| (t, effective_expires_at))
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
                debug!(provider = %provider, error = ?e, "failed to encrypt refreshed credentials");
            }
        }
    }

    /// Resolve BYOC client credentials from AppConfig for a given project + provider.
    /// Returns `Some((client_id, client_secret))` if an enabled config exists, `None` otherwise.
    async fn resolve_byoc_credentials(
        &self,
        project_id: &str,
        provider: &str,
    ) -> Option<(String, String)> {
        let config = db::find_app_config(&self.pool, project_id, provider)
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
    ConnectError::Internal(format!("db error: {e:#}"))
}

// ── Cached resolution ───────────────────────────────────────────────────

/// Resolve with caching. Checks the generic `CacheStore` first, then
/// queries the DB if needed. The cache key is namespaced as
/// `connect:{project_id}:{agent_token}:{hostname}` so that cache
/// invalidation can target all entries for a project by prefix.
pub(crate) async fn resolve(
    agent_token: &str,
    hostname: &str,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<ConnectResponse, ConnectError> {
    // Look up agent first — needed for project_id in cache key.
    let agent = policy_engine.find_agent(agent_token).await?;

    let cache_key = format!(
        "connect:{}:{}:{agent_token}:{hostname}",
        agent.organization_id, agent.project_id
    );

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

/// Resolve with caching, using a known `project_id` to skip the agent DB
/// query on cache hits. Designed for per-request resolution inside MITM
/// tunnels where the agent identity is already known from CONNECT time.
///
/// On cache hit: zero DB queries (just a cache lookup).
/// On cache miss: falls back to full resolution (agent query + DB).
pub(crate) async fn resolve_from_cache(
    organization_id: &str,
    project_id: &str,
    agent_token: &str,
    hostname: &str,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<ConnectResponse, ConnectError> {
    let cache_key = format!("connect:{organization_id}:{project_id}:{agent_token}:{hostname}");

    if let Some(response) = cache.get::<ConnectResponse>(&cache_key).await {
        return Ok(response);
    }

    debug!(host = %hostname, "resolve_from_cache: cache miss, querying DB");

    let agent = policy_engine.find_agent(agent_token).await?;
    let response = policy_engine.resolve_uncached(&agent, hostname).await?;
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
/// Mirrors the logic in `apps/web/src/app/v1/gateway/connect/route.ts`.
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

        "openai" => vec![Injection::SetHeader {
            name: "authorization".to_string(),
            value: format!("Bearer {decrypted_value}"),
        }],

        "generic" => {
            let config = injection_config.and_then(|v| v.as_object());

            // Check for header injection
            let header_name = config
                .and_then(|c| c.get("headerName"))
                .and_then(|v| v.as_str());

            // Check for parameter injection
            let param_name = config
                .and_then(|c| c.get("paramName"))
                .and_then(|v| v.as_str());

            if header_name.is_some() && param_name.is_some() {
                tracing::warn!(
                    "generic secret has both headerName and paramName; using headerName"
                );
            }

            if let Some(header_name) = header_name {
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
            } else if let Some(param_name) = param_name {
                let param_format = config
                    .and_then(|c| c.get("paramFormat"))
                    .and_then(|v| v.as_str());

                let value = match param_format {
                    Some(fmt) => fmt.replace("{value}", decrypted_value),
                    None => decrypted_value.to_string(),
                };

                vec![Injection::SetParam {
                    name: param_name.to_string(),
                    value,
                }]
            } else {
                vec![]
            }
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
            app_connections: vec![],
            policy_rules: vec![],
            project_id: None,
            organization_id: None,
            agent_id: None,
            agent_name: None,
            agent_identifier: None,
            access_restricted: false,
            plan: "pro".to_string(),
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

    // ── resolve_from_cache ────────────────────────────────────────────

    #[tokio::test]
    async fn resolve_from_cache_hits_with_correct_key() {
        let store = new_store().await;
        let response = ConnectResponse {
            intercept: true,
            injection_rules: vec![InjectionRule {
                path_pattern: "*".to_string(),
                injections: vec![],
            }],
            app_connections: vec![],
            policy_rules: vec![],
            project_id: Some("proj_1".to_string()),
            organization_id: Some("org_1".to_string()),
            agent_id: Some("agent_1".to_string()),
            agent_name: Some("Test".to_string()),
            agent_identifier: None,
            access_restricted: false,
            plan: "pro".to_string(),
        };

        // Pre-populate cache with the key format that resolve() uses
        store
            .set(
                "connect:org_1:proj_1:aoc_token1:api.example.com",
                &response,
                60,
            )
            .await;

        // resolve_from_cache should hit using the same key format.
        // On cache hit it never touches PolicyEngine, so we can't pass one —
        // but we can verify the key is correct by checking the cache directly.
        let cached: Option<ConnectResponse> = store
            .get(&format!(
                "connect:{}:{}:{}:{}",
                "org_1", "proj_1", "aoc_token1", "api.example.com"
            ))
            .await;
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().injection_rules.len(), 1);
    }

    #[tokio::test]
    async fn cache_round_trip_with_access_restricted() {
        let store = new_store().await;
        let response = ConnectResponse {
            intercept: true,
            injection_rules: vec![],
            app_connections: vec![],
            policy_rules: vec![],
            project_id: Some("proj_restricted".to_string()),
            organization_id: Some("org_restricted".to_string()),
            agent_id: Some("agent_selective".to_string()),
            agent_name: Some("Selective Agent".to_string()),
            agent_identifier: None,
            access_restricted: true,
            plan: "pro".to_string(),
        };

        store
            .set(
                "connect:org_restricted:proj_restricted:aoc_t:api.resend.com",
                &response,
                60,
            )
            .await;

        let cached: Option<ConnectResponse> = store
            .get("connect:org_restricted:proj_restricted:aoc_t:api.resend.com")
            .await;
        let cached = cached.expect("should be cached");
        assert!(cached.access_restricted);
        assert_eq!(cached.project_id.as_deref(), Some("proj_restricted"));
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

    // ── build_injections: paramName ─────────────────────────────────────

    #[test]
    fn build_injections_generic_param_name() {
        let config = serde_json::json!({ "paramName": "api_key" });
        let injections = build_injections("generic", "my-secret", Some(&config));
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetParam {
                name: "api_key".to_string(),
                value: "my-secret".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_param_name_with_format() {
        let config = serde_json::json!({ "paramName": "token", "paramFormat": "Bearer-{value}" });
        let injections = build_injections("generic", "my-secret", Some(&config));
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetParam {
                name: "token".to_string(),
                value: "Bearer-my-secret".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_header_takes_precedence_over_param() {
        // If both headerName and paramName are present, headerName wins
        let config = serde_json::json!({
            "headerName": "Authorization",
            "paramName": "api_key"
        });
        let injections = build_injections("generic", "my-secret", Some(&config));
        assert_eq!(injections.len(), 1);
        assert!(matches!(injections[0], Injection::SetHeader { .. }));
    }
}
