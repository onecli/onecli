//! 1Password vault provider.
//!
//! Owns the connection — the encrypted Service-Account token stored in
//! `vault_connection` — plus the per-project session and a small resolve cache.
//! 1Password is **not** a hostname-matched vault racer like Bitwarden; it is a
//! *value source* for explicit secrets. A secret with `value_source =
//! "onepassword"` carries an `op://vault/item/field` reference that the
//! [`PolicyEngine`](crate::connect::PolicyEngine) resolves here at request time
//! (instead of decrypting a stored `encrypted_value`).
//!
//! The actual 1Password SDK work (validate token, resolve `op://`, browse
//! vaults/items/fields for the picker) is delegated to the Node "1Password SDK
//! service" via [`super::onepassword_api`]; the gateway never runs the `op` CLI.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tracing::{info, warn};

use super::onepassword_api::{self, OpError};
use super::{PairResult, ProviderStatus, VaultCredential, VaultError, VaultProvider};
use crate::crypto::CryptoService;
use crate::db;

const RESOLVE_CACHE_TTL: Duration = Duration::from_secs(60);
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(30);
const ERROR_COOLDOWN: Duration = Duration::from_secs(60);
/// How long a successful `status` connectivity check is trusted before re-checking.
const STATUS_OK_TTL: Duration = Duration::from_secs(30);
const EVICTION_INTERVAL: Duration = Duration::from_secs(300);
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(1800);

// ── Config & session types ──────────────────────────────────────────────

/// Persisted in `vault_connection.connection_data`. Rows written before the
/// value-source refactor also carry a `mappings` key; serde ignores it.
///
/// Deliberately no `Debug`/`Clone`: the struct carries only a credential (the
/// encrypted SA token), so it must not be `{:?}`-logged or cloned around.
#[derive(Serialize, Deserialize)]
pub(crate) struct OnePasswordConfig {
    pub encrypted_service_account_token: String,
}

/// A cached `op://` resolution. `value: None` is a negative cache entry (the
/// reference resolved to nothing / failed) held for a shorter TTL.
struct CachedRef {
    value: Option<String>,
    expires_at: Instant,
}

struct OnePasswordSession {
    decrypted_sa_token: String,
    /// `op://vault/item/field` → resolved value, with positive/negative TTLs.
    ref_cache: DashMap<String, CachedRef>,
    last_used: Mutex<Instant>,
    last_error: Mutex<Option<String>>,
    error_until: Mutex<Option<Instant>>,
    /// Timestamp of the last successful connectivity check (positive `status` cache).
    last_ok: Mutex<Option<Instant>>,
}

impl OnePasswordSession {
    /// Whether the session is still within its post-error cooldown window (set
    /// when a `Transient` 1Password failure was last seen).
    fn in_error_cooldown(&self) -> bool {
        self.error_until
            .lock()
            .expect("session lock poisoned")
            .is_some_and(|t| Instant::now() < t)
    }
}

pub(crate) struct OnePasswordVaultProvider {
    pool: PgPool,
    crypto: Arc<CryptoService>,
    sessions: Arc<DashMap<String, Arc<OnePasswordSession>>>,
}

// ── Constructor with idle-session eviction ──────────────────────────────

impl OnePasswordVaultProvider {
    pub fn new(pool: PgPool, crypto: Arc<CryptoService>) -> Self {
        let sessions: Arc<DashMap<String, Arc<OnePasswordSession>>> = Arc::new(DashMap::new());

        let sessions_clone = Arc::clone(&sessions);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(EVICTION_INTERVAL).await;
                let mut to_evict = Vec::new();
                for entry in sessions_clone.iter() {
                    let last = *entry
                        .value()
                        .last_used
                        .lock()
                        .expect("session lock poisoned");
                    if last.elapsed() > SESSION_IDLE_TIMEOUT {
                        to_evict.push(entry.key().clone());
                    }
                }
                for key in to_evict {
                    if let Some((_, session)) = sessions_clone.remove(&key) {
                        session.ref_cache.clear();
                        info!(project_id = %key, "evicted idle 1Password session");
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

    /// Load an existing session from memory or DB. Returns `None` if the project
    /// has never paired. Decrypts the SA token into memory (held for resolution).
    async fn load_session(
        &self,
        project_id: &str,
    ) -> Result<Option<Arc<OnePasswordSession>>, VaultError> {
        if let Some(session) = self.sessions.get(project_id) {
            *session.last_used.lock().expect("session lock poisoned") = Instant::now();
            return Ok(Some(Arc::clone(&session)));
        }

        let row = match db::find_vault_connection(&self.pool, project_id, "onepassword").await {
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
                warn!(project_id, "failed to decrypt service account token: {e}");
                VaultError::Internal("token decryption failed — re-pair to fix".into())
            })?;

        let session = Arc::new(OnePasswordSession {
            decrypted_sa_token: sa_token,
            ref_cache: DashMap::new(),
            last_used: Mutex::new(Instant::now()),
            last_error: Mutex::new(None),
            error_until: Mutex::new(None),
            last_ok: Mutex::new(None),
        });
        self.sessions
            .insert(project_id.to_string(), Arc::clone(&session));
        Ok(Some(session))
    }

    // ── Value-source resolution (the secret-injection path) ──────────────

    /// Resolve an `op://vault/item/field` reference to its secret value for a
    /// project's 1Password connection. Cached by `op_ref` with the same TTL /
    /// cooldown as before. Errors classify so the caller can skip the secret the
    /// same way it skips one whose stored value fails to decrypt.
    ///
    /// There is one 1Password connection per project, so the reference resolves
    /// via that project's connection (the `project_id` session).
    pub(crate) async fn resolve_ref(
        &self,
        project_id: &str,
        op_ref: &str,
    ) -> Result<String, VaultError> {
        let session = self
            .load_session(project_id)
            .await?
            .ok_or_else(|| VaultError::NotFound("1Password is not connected".into()))?;

        if let Some(cached) = session.ref_cache.get(op_ref) {
            if cached.expires_at > Instant::now() {
                return cached
                    .value
                    .clone()
                    .ok_or_else(|| VaultError::BadRequest(format!("cannot resolve {op_ref}")));
            }
            drop(cached);
            session.ref_cache.remove(op_ref);
        }

        if session.in_error_cooldown() {
            return Err(VaultError::Internal(
                "1Password temporarily unavailable (cooldown)".into(),
            ));
        }

        match onepassword_api::resolve(&session.decrypted_sa_token, op_ref).await {
            Ok(value) if !value.is_empty() => {
                *session.last_error.lock().expect("session lock poisoned") = None;
                session.ref_cache.insert(
                    op_ref.to_string(),
                    CachedRef {
                        value: Some(value.clone()),
                        expires_at: Instant::now() + RESOLVE_CACHE_TTL,
                    },
                );
                Ok(value)
            }
            Ok(_) => {
                self.cache_negative(&session, op_ref);
                Err(VaultError::BadRequest(format!(
                    "{op_ref} resolved to an empty value"
                )))
            }
            Err(OpError::NotFound(msg)) | Err(OpError::BadRequest(msg)) => {
                self.cache_negative(&session, op_ref);
                Err(VaultError::BadRequest(msg))
            }
            Err(OpError::Transient(msg)) => {
                *session.last_error.lock().expect("session lock poisoned") = Some(msg.clone());
                *session.error_until.lock().expect("session lock poisoned") =
                    Some(Instant::now() + ERROR_COOLDOWN);
                Err(VaultError::Internal(msg))
            }
        }
    }

    fn cache_negative(&self, session: &OnePasswordSession, op_ref: &str) {
        session.ref_cache.insert(
            op_ref.to_string(),
            CachedRef {
                value: None,
                expires_at: Instant::now() + NEGATIVE_CACHE_TTL,
            },
        );
    }

    // ── Picker passthroughs (browse vaults → items → fields) ─────────────
    // The browser never sees the SA token or field values — it gets only the
    // labels/types the Node service returns.

    pub(crate) async fn list_vaults(
        &self,
        project_id: &str,
    ) -> Result<serde_json::Value, VaultError> {
        let session = self.picker_session(project_id).await?;
        onepassword_api::list_vaults(&session.decrypted_sa_token)
            .await
            .map_err(op_err_to_vault)
    }

    pub(crate) async fn list_items(
        &self,
        project_id: &str,
        vault_id: &str,
    ) -> Result<serde_json::Value, VaultError> {
        let session = self.picker_session(project_id).await?;
        onepassword_api::list_items(&session.decrypted_sa_token, vault_id)
            .await
            .map_err(op_err_to_vault)
    }

    pub(crate) async fn list_fields(
        &self,
        project_id: &str,
        vault_id: &str,
        item_id: &str,
    ) -> Result<serde_json::Value, VaultError> {
        let session = self.picker_session(project_id).await?;
        onepassword_api::list_fields(&session.decrypted_sa_token, vault_id, item_id)
            .await
            .map_err(op_err_to_vault)
    }

    /// Load a connected session for picker calls, or 404 if not paired. Returns
    /// the session so callers borrow the SA token instead of cloning it.
    async fn picker_session(
        &self,
        project_id: &str,
    ) -> Result<Arc<OnePasswordSession>, VaultError> {
        self.load_session(project_id)
            .await?
            .ok_or_else(|| VaultError::NotFound("1Password is not connected".into()))
    }
}

// ── VaultProvider implementation ─────────────────────────────────────────

#[async_trait]
impl VaultProvider for OnePasswordVaultProvider {
    fn provider_name(&self) -> &'static str {
        "onepassword"
    }

    async fn pair(&self, project_id: &str, params: &serde_json::Value) -> Result<PairResult> {
        let token = params
            .get("service_account_token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("missing service_account_token"))?;

        // Validate the token via the Node SDK service before persisting it.
        onepassword_api::validate(token)
            .await
            .map_err(|e| anyhow!("token validation failed: {e}"))?;

        let encrypted = self
            .crypto
            .encrypt(token)
            .await
            .map_err(|e| anyhow!("encryption failed: {e}"))?;

        let config = OnePasswordConfig {
            encrypted_service_account_token: encrypted,
        };
        let cd = serde_json::to_value(&config)?;
        db::upsert_vault_connection(&self.pool, project_id, "onepassword", "paired", Some(&cd))
            .await?;

        // Drop any cached session so the next request reloads the new token.
        self.sessions.remove(project_id);
        Ok(PairResult {
            display_name: Some("1Password".into()),
        })
    }

    /// 1Password is a value-source for explicit secrets (resolved via the
    /// PolicyEngine secret-injection path), not a hostname-matched vault racer,
    /// so it never participates in the Bitwarden-style credential race.
    async fn request_credential(
        &self,
        _project_id: &str,
        _hostname: &str,
    ) -> Option<VaultCredential> {
        None
    }

    async fn status(&self, project_id: &str) -> ProviderStatus {
        let session = match self.load_session(project_id).await {
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
                    status_data: Some(serde_json::json!({ "last_error": e.to_string() })),
                }
            }
        };

        let connected = live_check(&session).await;
        let last_err = session
            .last_error
            .lock()
            .expect("session lock poisoned")
            .clone();

        ProviderStatus {
            connected,
            name: None,
            status_data: Some(serde_json::json!({ "last_error": last_err })),
        }
    }

    async fn disconnect(&self, project_id: &str) -> Result<()> {
        if let Some((_, session)) = self.sessions.remove(project_id) {
            session.ref_cache.clear();
        }
        Ok(())
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Live connectivity check for `status`, gated by the error cooldown and a
/// short positive TTL so dashboard polling doesn't hammer 1Password.
async fn live_check(session: &OnePasswordSession) -> bool {
    if session.in_error_cooldown() {
        return false;
    }
    if session
        .last_ok
        .lock()
        .expect("session lock poisoned")
        .is_some_and(|t| t.elapsed() < STATUS_OK_TTL)
    {
        return true;
    }
    match onepassword_api::validate(&session.decrypted_sa_token).await {
        Ok(()) => {
            *session.last_error.lock().expect("session lock poisoned") = None;
            *session.last_ok.lock().expect("session lock poisoned") = Some(Instant::now());
            true
        }
        Err(e) => {
            *session.last_error.lock().expect("session lock poisoned") = Some(e.to_string());
            *session.error_until.lock().expect("session lock poisoned") =
                Some(Instant::now() + ERROR_COOLDOWN);
            false
        }
    }
}

fn op_err_to_vault(e: OpError) -> VaultError {
    match e {
        OpError::NotFound(m) => VaultError::NotFound(m),
        OpError::BadRequest(m) => VaultError::BadRequest(m),
        OpError::Transient(m) => VaultError::Internal(m),
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
        };
        let json = serde_json::to_value(&config).unwrap();
        let back: OnePasswordConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.encrypted_service_account_token, "iv:tag:ct");
    }

    #[test]
    fn config_ignores_legacy_mappings() {
        // Rows written before the value-source refactor carry a `mappings` key.
        // It must deserialize cleanly (ignored) so existing connections keep working.
        let json = serde_json::json!({
            "encrypted_service_account_token": "iv:tag:ct",
            "mappings": { "api.anthropic.com": "op://API Keys/Anthropic/credential" },
        });
        let config: OnePasswordConfig = serde_json::from_value(json).unwrap();
        assert_eq!(config.encrypted_service_account_token, "iv:tag:ct");
    }

    #[test]
    fn op_error_maps_to_the_right_vault_error_class() {
        // This mapping is the contract that drives the HTTP status the picker
        // returns (404 / 400 / 500), so pin each classification.
        assert!(matches!(
            op_err_to_vault(OpError::NotFound("x".into())),
            VaultError::NotFound(_)
        ));
        assert!(matches!(
            op_err_to_vault(OpError::BadRequest("x".into())),
            VaultError::BadRequest(_)
        ));
        assert!(matches!(
            op_err_to_vault(OpError::Transient("x".into())),
            VaultError::Internal(_)
        ));
    }
}
