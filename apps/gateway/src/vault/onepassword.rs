//! 1Password vault provider — OnePasswordVaultProvider.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use async_trait::async_trait;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tracing::{info, warn};

use crate::crypto::CryptoService;
use crate::db;
use crate::vault::{PairResult, ProviderStatus, VaultCredential, VaultError, VaultProvider};

use super::onepassword_op;

const CREDENTIAL_CACHE_TTL: Duration = Duration::from_secs(60);
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(30);
const ERROR_COOLDOWN: Duration = Duration::from_secs(60);
const EVICTION_INTERVAL: Duration = Duration::from_secs(300);
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(1800);

// ── Config & session types ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OnePasswordConfig {
    pub encrypted_service_account_token: String,
    /// hostname → op:// secret reference
    #[serde(default)]
    pub mappings: HashMap<String, String>,
}

struct CachedCredential {
    credential: Option<VaultCredential>,
    expires_at: Instant,
}

pub(crate) struct OnePasswordSession {
    config: ArcSwap<OnePasswordConfig>,
    decrypted_sa_token: String,
    credential_cache: DashMap<String, CachedCredential>,
    last_used: std::sync::Mutex<Instant>,
    last_error: std::sync::Mutex<Option<String>>,
    error_until: std::sync::Mutex<Option<Instant>>,
    /// Hostnames whose op:// reference failed with "not found" (deleted/renamed in 1Password)
    stale_mappings: std::sync::Mutex<Vec<String>>,
}

pub(crate) struct OnePasswordVaultProvider {
    pool: PgPool,
    crypto: Arc<CryptoService>,
    sessions: Arc<DashMap<String, Arc<OnePasswordSession>>>,
}

// ── Constructor with eviction task ──────────────────────────────────────

impl OnePasswordVaultProvider {
    pub fn new(pool: PgPool, crypto: Arc<CryptoService>) -> Self {
        let sessions: Arc<DashMap<String, Arc<OnePasswordSession>>> = Arc::new(DashMap::new());

        let sessions_clone = Arc::clone(&sessions);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(EVICTION_INTERVAL).await;
                let mut to_evict = Vec::new();
                for entry in sessions_clone.iter() {
                    let last = *entry.value().last_used.lock().unwrap();
                    if last.elapsed() > SESSION_IDLE_TIMEOUT {
                        to_evict.push(entry.key().clone());
                    }
                }
                for key in to_evict {
                    if let Some((_, session)) = sessions_clone.remove(&key) {
                        session.credential_cache.clear();
                        info!(account_id = %key, "evicted idle 1Password session");
                    }
                }
            }
        });

        Self {
            pool,
            crypto,
            sessions,
        }
    }
}

// ── Session loading ─────────────────────────────────────────────────────

impl OnePasswordVaultProvider {
    async fn load_session(
        &self,
        account_id: &str,
    ) -> Result<Option<Arc<OnePasswordSession>>, VaultError> {
        if let Some(session) = self.sessions.get(account_id) {
            *session.last_used.lock().unwrap() = Instant::now();
            return Ok(Some(Arc::clone(&session)));
        }

        let row = match db::find_vault_connection(&self.pool, account_id, "onepassword").await {
            Ok(Some(row)) => row,
            Ok(None) => return Ok(None),
            Err(e) => {
                return Err(VaultError::Internal(format!(
                    "failed to load vault connection: {e}"
                )))
            }
        };

        let connection_data = row.connection_data.ok_or_else(|| {
            VaultError::Internal("vault connection has no connection_data".into())
        })?;

        let config: OnePasswordConfig = serde_json::from_value(connection_data)
            .map_err(|e| VaultError::Internal(format!("malformed connection_data: {e}")))?;

        let sa_token = self
            .crypto
            .decrypt(&config.encrypted_service_account_token)
            .await
            .map_err(|e| {
                warn!(account_id, "failed to decrypt service account token: {e}");
                VaultError::Internal("token decryption failed — re-pair to fix".into())
            })?;

        let session = Arc::new(OnePasswordSession {
            config: ArcSwap::new(Arc::new(config)),
            decrypted_sa_token: sa_token,
            credential_cache: DashMap::new(),
            last_used: std::sync::Mutex::new(Instant::now()),
            last_error: std::sync::Mutex::new(None),
            error_until: std::sync::Mutex::new(None),
            stale_mappings: std::sync::Mutex::new(Vec::new()),
        });

        self.sessions
            .insert(account_id.to_string(), Arc::clone(&session));
        Ok(Some(session))
    }
}

// ── VaultProvider trait implementation ───────────────────────────────────

#[async_trait]
impl VaultProvider for OnePasswordVaultProvider {
    fn provider_name(&self) -> &'static str {
        "onepassword"
    }

    async fn pair(
        &self,
        account_id: &str,
        params: &serde_json::Value,
    ) -> Result<PairResult, VaultError> {
        let token = params
            .get("service_account_token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| VaultError::BadRequest("missing service_account_token".into()))?;

        // Validate: check op version + token
        onepassword_op::op_check_version()
            .await
            .map_err(|e| VaultError::BadRequest(e.to_string()))?;
        let auth = onepassword_op::OpAuth::ServiceAccount { token };
        onepassword_op::op_whoami(&auth)
            .await
            .map_err(|e| VaultError::BadRequest(format!("token validation failed: {e}")))?;

        // Encrypt token
        let encrypted = self
            .crypto
            .encrypt(token)
            .await
            .map_err(|e| VaultError::Internal(format!("encryption failed: {e}")))?;

        // Preserve existing mappings if re-pairing (e.g. token rotation).
        // Read directly from DB rather than load_session, because load_session
        // may fail on decrypt (which is exactly when the user is re-pairing).
        let existing_mappings =
            match db::find_vault_connection(&self.pool, account_id, "onepassword").await {
                Ok(Some(row)) => row
                    .connection_data
                    .and_then(|cd| serde_json::from_value::<OnePasswordConfig>(cd).ok())
                    .map(|c| {
                        // Normalize any pre-existing mixed-case keys to lowercase
                        c.mappings
                            .into_iter()
                            .map(|(k, v)| (k.to_ascii_lowercase(), v))
                            .collect()
                    })
                    .unwrap_or_default(),
                _ => HashMap::new(),
            };

        let config = OnePasswordConfig {
            encrypted_service_account_token: encrypted,
            mappings: existing_mappings,
        };

        let cd = serde_json::to_value(&config).map_err(|e| VaultError::Internal(e.to_string()))?;
        db::upsert_vault_connection(&self.pool, account_id, "onepassword", "paired", Some(&cd))
            .await
            .map_err(|e| VaultError::Internal(e.to_string()))?;

        self.sessions.remove(account_id);
        Ok(PairResult {
            display_name: Some("1Password".into()),
        })
    }

    async fn request_credential(
        &self,
        account_id: &str,
        hostname: &str,
    ) -> Option<VaultCredential> {
        let session = match self.load_session(account_id).await {
            Ok(Some(s)) => s,
            Ok(None) => return None,
            Err(e) => {
                warn!(account_id, error = %e, "failed to load 1Password session");
                return None;
            }
        };

        // Normalize hostname for consistent cache/mapping/stale lookups
        let hostname = hostname.to_ascii_lowercase();

        // Check credential cache
        if let Some(cached) = session.credential_cache.get(&hostname) {
            if cached.expires_at > Instant::now() {
                return cached.credential.clone();
            }
            drop(cached);
            session.credential_cache.remove(&hostname);
        }

        // Check error cooldown
        {
            let cooldown = session.error_until.lock().unwrap();
            if cooldown.is_some_and(|t| Instant::now() < t) {
                return None;
            }
        }

        // Look up op:// reference
        let config = session.config.load();
        let op_ref = config.mappings.get(&hostname)?;
        let op_ref = op_ref.clone();
        drop(config);

        let auth = onepassword_op::OpAuth::ServiceAccount {
            token: &session.decrypted_sa_token,
        };

        let result = match onepassword_op::op_read(&auth, &op_ref).await {
            Ok(value) if !value.is_empty() => {
                // Validate value is usable as an HTTP header at read time too,
                // since the 1Password field may have changed since mapping was created
                let val_lower = value.to_ascii_lowercase();
                if hyper::header::HeaderValue::from_str(&value).is_err()
                    || val_lower.starts_with("bearer ")
                    || val_lower.starts_with("basic ")
                {
                    warn!(
                        hostname,
                        op_ref, "op read returned value unusable as credential (invalid header or preformatted auth)"
                    );
                    // Track as stale so it surfaces in /status
                    let mut stale = session.stale_mappings.lock().unwrap();
                    if !stale.contains(&hostname) {
                        stale.push(hostname.clone());
                    }
                    None
                } else {
                    *session.last_error.lock().unwrap() = None;
                    session
                        .stale_mappings
                        .lock()
                        .unwrap()
                        .retain(|h| h != &hostname);
                    Some(VaultCredential {
                        username: None,
                        password: Some(value),
                    })
                }
            }
            Ok(_) => {
                warn!(hostname, op_ref, "op read returned empty value");
                let mut stale = session.stale_mappings.lock().unwrap();
                if !stale.contains(&hostname) {
                    stale.push(hostname.clone());
                }
                None
            }
            Err(e) => {
                let err_str = e.to_string();
                let is_not_found = err_str.contains("isn't an item")
                    || err_str.contains("not found")
                    || err_str.contains("could not be found");
                if is_not_found {
                    // Stale mapping — item deleted/renamed in 1Password
                    warn!(
                        hostname,
                        op_ref, "op:// reference not found — stale mapping"
                    );
                    let mut stale = session.stale_mappings.lock().unwrap();
                    if !stale.contains(&hostname) {
                        stale.push(hostname.clone());
                    }
                } else {
                    // Transient error — network, auth, timeout
                    warn!(hostname, error = %err_str, "op read failed — entering cooldown");
                    *session.last_error.lock().unwrap() = Some(err_str);
                    *session.error_until.lock().unwrap() = Some(Instant::now() + ERROR_COOLDOWN);
                }
                None
            }
        };

        // Cache result
        let ttl = if result.is_some() {
            CREDENTIAL_CACHE_TTL
        } else {
            NEGATIVE_CACHE_TTL
        };
        session.credential_cache.insert(
            hostname.clone(),
            CachedCredential {
                credential: result.clone(),
                expires_at: Instant::now() + ttl,
            },
        );

        result
    }

    async fn status(&self, account_id: &str) -> ProviderStatus {
        let session = match self.load_session(account_id).await {
            Ok(Some(s)) => s,
            Ok(None) => {
                return ProviderStatus {
                    connected: false,
                    name: None,
                    status_data: None,
                }
            }
            Err(e) => {
                return ProviderStatus {
                    connected: false,
                    name: None,
                    status_data: Some(serde_json::json!({"last_error": e.to_string()})),
                }
            }
        };

        // Honor error cooldown
        let in_cooldown = {
            let cooldown = session.error_until.lock().unwrap();
            cooldown.is_some_and(|t| Instant::now() < t)
        };

        let connected = if in_cooldown {
            false
        } else {
            let auth = onepassword_op::OpAuth::ServiceAccount {
                token: &session.decrypted_sa_token,
            };
            match onepassword_op::op_whoami(&auth).await {
                Ok(_) => {
                    *session.last_error.lock().unwrap() = None;
                    true
                }
                Err(e) => {
                    let err = e.to_string();
                    *session.last_error.lock().unwrap() = Some(err);
                    *session.error_until.lock().unwrap() = Some(Instant::now() + ERROR_COOLDOWN);
                    false
                }
            }
        };

        let config = session.config.load();
        let last_err = session.last_error.lock().unwrap().clone();
        let stale = session.stale_mappings.lock().unwrap().clone();

        ProviderStatus {
            connected,
            name: None,
            status_data: Some(serde_json::json!({
                "mapping_count": config.mappings.len(),
                "stale_mappings": stale,
                "last_error": last_err,
            })),
        }
    }

    async fn disconnect(&self, account_id: &str) -> Result<(), VaultError> {
        if let Some((_, session)) = self.sessions.remove(account_id) {
            session.credential_cache.clear();
        }
        Ok(())
    }

    async fn list_mappings(&self, account_id: &str) -> Result<serde_json::Value, VaultError> {
        let session = self
            .load_session(account_id)
            .await?
            .ok_or_else(|| VaultError::NotFound("not paired".into()))?;
        let config = session.config.load();
        serde_json::to_value(&config.mappings).map_err(|e| VaultError::Internal(e.to_string()))
    }

    async fn update_mapping(
        &self,
        account_id: &str,
        hostname: &str,
        mapping: &serde_json::Value,
    ) -> Result<(), VaultError> {
        // Validate hostname is a bare DNS name
        let hostname = hostname.trim();
        if hostname.is_empty()
            || hostname.contains("://")
            || hostname.contains(':')
            || hostname.contains('/')
            || hostname.contains('?')
            || hostname.contains(' ')
        {
            return Err(VaultError::BadRequest(
                "hostname must be a bare DNS name (e.g. 'api.openai.com'), without scheme, port, path, or query".into(),
            ));
        }

        let session = self
            .load_session(account_id)
            .await?
            .ok_or_else(|| VaultError::NotFound("not paired".into()))?;

        let op_ref = mapping
            .get("op_ref")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                VaultError::BadRequest("missing op_ref (e.g. op://vault/item/field)".into())
            })?;

        // Validate format
        onepassword_op::validate_op_ref(op_ref)
            .map_err(|e| VaultError::BadRequest(e.to_string()))?;

        // Validate accessibility — actually try reading it
        let auth = onepassword_op::OpAuth::ServiceAccount {
            token: &session.decrypted_sa_token,
        };
        let value = onepassword_op::op_read(&auth, op_ref)
            .await
            .map_err(|e| VaultError::BadRequest(format!("cannot read {op_ref}: {e}")))?;

        // Validate resolved value is usable as an HTTP header
        if value.is_empty() {
            return Err(VaultError::BadRequest(format!(
                "{op_ref} resolved to an empty value"
            )));
        }
        if hyper::header::HeaderValue::from_str(&value).is_err() {
            return Err(VaultError::BadRequest(format!(
                "{op_ref} resolved to a value that cannot be used as an HTTP header (contains newlines or non-ASCII)"
            )));
        }
        // Warn if value looks like a preformatted auth header — the gateway adds
        // "Bearer " automatically, so storing "Bearer sk-..." would double-prefix
        let lower = value.to_ascii_lowercase();
        if lower.starts_with("bearer ") || lower.starts_with("basic ") {
            return Err(VaultError::BadRequest(format!(
                "{op_ref} resolved to a value starting with 'Bearer'/'Basic'. \
                 Store the raw token — the gateway adds the auth prefix automatically."
            )));
        }

        // Store mapping (hostname normalized to lowercase for case-insensitive DNS matching)
        let hostname_lower = hostname.to_ascii_lowercase();
        let mut config = (*session.config.load_full()).clone();
        config
            .mappings
            .insert(hostname_lower.clone(), op_ref.to_string());
        let cd = serde_json::to_value(&config).map_err(|e| VaultError::Internal(e.to_string()))?;
        db::update_vault_connection_data(&self.pool, account_id, "onepassword", &cd)
            .await
            .map_err(|e| VaultError::Internal(e.to_string()))?;

        session.config.store(Arc::new(config));
        session.credential_cache.remove(&hostname_lower);
        session
            .stale_mappings
            .lock()
            .unwrap()
            .retain(|h| h != &hostname_lower);
        // Clear error cooldown — the op_read above proved the token works
        *session.last_error.lock().unwrap() = None;
        *session.error_until.lock().unwrap() = None;
        Ok(())
    }

    async fn delete_mapping(&self, account_id: &str, hostname: &str) -> Result<(), VaultError> {
        let session = self
            .load_session(account_id)
            .await?
            .ok_or_else(|| VaultError::NotFound("not paired".into()))?;

        let hostname_lower = hostname.to_ascii_lowercase();
        let mut config = (*session.config.load_full()).clone();
        if config.mappings.remove(&hostname_lower).is_none() {
            return Err(VaultError::NotFound(format!(
                "no mapping for hostname '{hostname}'"
            )));
        }
        let cd = serde_json::to_value(&config).map_err(|e| VaultError::Internal(e.to_string()))?;
        db::update_vault_connection_data(&self.pool, account_id, "onepassword", &cd)
            .await
            .map_err(|e| VaultError::Internal(e.to_string()))?;

        session.config.store(Arc::new(config));
        session.credential_cache.remove(&hostname_lower);
        session
            .stale_mappings
            .lock()
            .unwrap()
            .retain(|h| h != &hostname_lower);
        Ok(())
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trip() {
        let config = OnePasswordConfig {
            encrypted_service_account_token: "iv:tag:ct".into(),
            mappings: HashMap::from([
                (
                    "api.anthropic.com".into(),
                    "op://API Keys/Anthropic/credential".into(),
                ),
                (
                    "api.openai.com".into(),
                    "op://API Keys/OpenAI/api_key".into(),
                ),
            ]),
        };
        let json = serde_json::to_value(&config).unwrap();
        let back: OnePasswordConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.mappings.len(), 2);
        assert_eq!(
            back.mappings["api.anthropic.com"],
            "op://API Keys/Anthropic/credential"
        );
    }

    #[test]
    fn config_deserializes_with_empty_mappings() {
        let json = serde_json::json!({
            "encrypted_service_account_token": "iv:tag:ct"
        });
        let config: OnePasswordConfig = serde_json::from_value(json).unwrap();
        assert!(config.mappings.is_empty());
    }

    #[test]
    fn stale_detection_not_found_patterns() {
        // These are the error substrings op read emits for missing items
        let not_found_errors = [
            "isn't an item in the \"vault\" vault",
            "item not found",
            "could not be found",
        ];
        for err in not_found_errors {
            assert!(
                err.contains("isn't an item")
                    || err.contains("not found")
                    || err.contains("could not be found"),
                "pattern should match: {err}"
            );
        }
        // Transient errors should NOT match
        let transient = "op read failed: network timeout";
        assert!(
            !transient.contains("isn't an item")
                && !transient.contains("not found")
                && !transient.contains("could not be found")
        );
    }

    #[test]
    fn header_value_validation() {
        use hyper::header::HeaderValue;
        // Valid API keys
        assert!(HeaderValue::from_str("sk-ant-api03-abc123").is_ok());
        assert!(HeaderValue::from_str("Bearer token123").is_ok());
        // Invalid: multiline (document field pasted by accident)
        assert!(HeaderValue::from_str("line1\nline2").is_err());
        // Invalid: non-visible ASCII
        assert!(HeaderValue::from_str("value\x01with\x00control").is_err());
    }

    #[test]
    fn hostname_normalized_to_lowercase_in_config() {
        let mut config = OnePasswordConfig {
            encrypted_service_account_token: "iv:tag:ct".into(),
            mappings: HashMap::new(),
        };
        // Simulate what update_mapping does
        let hostname = "API.OpenAI.COM";
        let hostname_lower = hostname.to_ascii_lowercase();
        config
            .mappings
            .insert(hostname_lower.clone(), "op://v/i/f".into());

        // Lookup must use lowercase to match
        assert!(config.mappings.get("api.openai.com").is_some());
        assert!(config.mappings.get("API.OpenAI.COM").is_none());
    }

    #[test]
    fn re_pair_preserves_existing_mappings() {
        // Old config with mappings
        let old_config = OnePasswordConfig {
            encrypted_service_account_token: "old-encrypted".into(),
            mappings: HashMap::from([
                ("api.anthropic.com".into(), "op://v/i/f".into()),
                ("api.openai.com".into(), "op://v/i2/f".into()),
            ]),
        };
        // Simulate re-pair: new token, preserve mappings
        let new_config = OnePasswordConfig {
            encrypted_service_account_token: "new-encrypted".into(),
            mappings: old_config.mappings.clone(),
        };
        assert_eq!(new_config.mappings.len(), 2);
        assert_eq!(new_config.encrypted_service_account_token, "new-encrypted");
        assert_eq!(new_config.mappings["api.anthropic.com"], "op://v/i/f");
    }

    #[test]
    fn hostname_validation_rejects_non_bare() {
        // These should be rejected by the validation logic
        let bad = [
            ("https://api.openai.com", "has scheme"),
            ("http://foo.com", "has scheme"),
            ("api.com:443", "has port"),
            ("host:8080", "has port"),
            ("api.openai.com/v1", "has path"),
            ("api.openai.com?key=val", "has query"),
            ("", "empty"),
        ];
        for (h, reason) in bad {
            let trimmed = h.trim();
            assert!(
                trimmed.is_empty()
                    || trimmed.contains("://")
                    || trimmed.contains(':')
                    || trimmed.contains('/')
                    || trimmed.contains('?')
                    || trimmed.contains(' '),
                "should be rejected ({reason}): '{h}'"
            );
        }
        // Leading/trailing whitespace is trimmed before validation, so
        // " api.openai.com " is accepted (becomes "api.openai.com")
        let good = ["api.openai.com", "api.anthropic.com", "my-service.internal"];
        for h in good {
            let trimmed = h.trim();
            assert!(
                !trimmed.is_empty()
                    && !trimmed.contains("://")
                    && !trimmed.contains(':')
                    && !trimmed.contains('/')
                    && !trimmed.contains('?')
                    && !trimmed.contains(' '),
                "should be accepted: '{h}'"
            );
        }
    }

    #[test]
    fn bearer_prefix_detection() {
        let values = [
            ("Bearer sk-ant-123", true),
            ("bearer sk-ant-123", true),
            ("BEARER sk-ant-123", true),
            ("Basic dXNlcjpwYXNz", true),
            ("sk-ant-123", false),
            ("my-token-value", false),
        ];
        for (value, should_reject) in values {
            let lower = value.to_ascii_lowercase();
            let has_prefix = lower.starts_with("bearer ") || lower.starts_with("basic ");
            assert_eq!(has_prefix, should_reject, "value: {value}");
        }
    }
}
