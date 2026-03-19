//! DB-backed `IdentityProvider` and `SessionStore` for the Bitwarden vault provider.
//!
//! Instead of files, identity keypair and session/transport state are stored in
//! the `VaultConnection.connectionData` JSON column (scoped to `provider = "bitwarden"`).
//!
//! The `SessionStore` and `IdentityProvider` traits are async (as of ap-client 0.5),
//! so we can await DB calls directly — no sync→async bridging needed.

use ap_client::{ClientError, IdentityFingerprint, IdentityProvider, SessionStore};
use ap_noise::MultiDeviceTransport;
use ap_proxy_protocol::IdentityKeyPair;
use async_trait::async_trait;
use sqlx::PgPool;
use tracing::warn;

use super::bitwarden::{parse_fingerprint, BitwardenConnectionData};
use crate::db;

// ── BitwardenIdentityProvider ───────────────────────────────────────────

/// DB-backed identity provider. Keypair is extracted from `connectionData.key_data`
/// on construction, or generated fresh for new pairings.
pub(crate) struct BitwardenIdentityProvider {
    keypair: IdentityKeyPair,
}

impl BitwardenIdentityProvider {
    /// Create from an existing COSE-encoded keypair (loaded from DB).
    pub fn from_cose(cose_bytes: &[u8]) -> Result<Self, anyhow::Error> {
        let keypair = IdentityKeyPair::from_cose(cose_bytes)
            .map_err(|e| anyhow::anyhow!("failed to decode identity keypair: {e}"))?;
        Ok(Self { keypair })
    }

    /// Generate a new identity keypair.
    pub fn generate() -> Self {
        Self {
            keypair: IdentityKeyPair::generate(),
        }
    }

    /// Serialize the keypair to COSE bytes for storage.
    pub fn to_cose(&self) -> Vec<u8> {
        self.keypair.to_cose()
    }

    /// Clone the keypair into a new provider (for giving ownership to RemoteClient).
    pub fn clone_provider(&self) -> Self {
        Self {
            keypair: self.keypair.clone(),
        }
    }

    /// Get the fingerprint for this identity.
    pub fn fingerprint(&self) -> IdentityFingerprint {
        self.keypair.identity().fingerprint()
    }
}

#[async_trait]
impl IdentityProvider for BitwardenIdentityProvider {
    async fn identity(&self) -> IdentityKeyPair {
        self.keypair.clone()
    }
}

// ── BitwardenSessionStore ───────────────────────────────────────────────

/// DB-backed session store, scoped to a single `user_id` with `provider = "bitwarden"`.
///
/// Sessions are cached in memory. Writes go through to the DB directly via async calls.
pub(crate) struct BitwardenSessionStore {
    pool: PgPool,
    user_id: String,
    /// COSE-encoded keypair — kept here so write-throughs don't null out key_data in DB.
    key_data: Option<Vec<u8>>,
    /// In-memory session state (at most one session per user for Bitwarden).
    session: Option<SessionEntry>,
}

#[derive(Debug, Clone)]
struct SessionEntry {
    fingerprint: IdentityFingerprint,
    name: Option<String>,
    created_at: u64,
    last_connected_at: u64,
    transport_state: Option<Vec<u8>>,
}

impl BitwardenSessionStore {
    /// Create a new store, loading existing session from DB if present.
    pub fn new(
        pool: PgPool,
        user_id: String,
        key_data: Option<Vec<u8>>,
        connection_data: Option<&BitwardenConnectionData>,
    ) -> Self {
        let session = connection_data.and_then(|cd| {
            let fingerprint = parse_fingerprint(cd.fingerprint.as_deref()?)?;

            Some(SessionEntry {
                fingerprint,
                name: None,
                created_at: now_timestamp(),
                last_connected_at: now_timestamp(),
                transport_state: cd.transport_state.clone(),
            })
        });

        Self {
            pool,
            user_id,
            key_data,
            session,
        }
    }

    /// Persist the current connection data to DB.
    async fn write_through(&self, cd: &BitwardenConnectionData) {
        let json = match serde_json::to_value(cd) {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "failed to serialize BitwardenConnectionData");
                return;
            }
        };

        if let Err(e) =
            db::update_vault_connection_data(&self.pool, &self.user_id, "bitwarden", &json).await
        {
            warn!(error = %e, "failed to write-through vault connection data");
        }
    }

    /// Build current `BitwardenConnectionData` from in-memory state.
    fn current_connection_data(&self) -> BitwardenConnectionData {
        match &self.session {
            Some(s) => BitwardenConnectionData {
                fingerprint: Some(hex::encode(s.fingerprint.0)),
                key_data: self.key_data.clone(),
                transport_state: s.transport_state.clone(),
            },
            None => BitwardenConnectionData {
                fingerprint: None,
                key_data: self.key_data.clone(),
                transport_state: None,
            },
        }
    }
}

#[async_trait]
impl SessionStore for BitwardenSessionStore {
    async fn has_session(&self, fingerprint: &IdentityFingerprint) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| s.fingerprint == *fingerprint)
    }

    async fn list_sessions(&self) -> Vec<(IdentityFingerprint, Option<String>, u64, u64)> {
        self.session
            .iter()
            .map(|s| {
                (
                    s.fingerprint,
                    s.name.clone(),
                    s.created_at,
                    s.last_connected_at,
                )
            })
            .collect()
    }

    async fn cache_session(&mut self, fingerprint: IdentityFingerprint) -> Result<(), ClientError> {
        if self.has_session(&fingerprint).await {
            return Ok(());
        }

        self.session = Some(SessionEntry {
            fingerprint,
            name: None,
            created_at: now_timestamp(),
            last_connected_at: now_timestamp(),
            transport_state: None,
        });

        Ok(())
    }

    async fn remove_session(
        &mut self,
        fingerprint: &IdentityFingerprint,
    ) -> Result<(), ClientError> {
        if self
            .session
            .as_ref()
            .is_some_and(|s| s.fingerprint == *fingerprint)
        {
            self.session = None;
        }
        Ok(())
    }

    async fn clear(&mut self) -> Result<(), ClientError> {
        self.session = None;
        Ok(())
    }

    async fn set_session_name(
        &mut self,
        fingerprint: &IdentityFingerprint,
        name: String,
    ) -> Result<(), ClientError> {
        if let Some(ref mut s) = self.session {
            if s.fingerprint == *fingerprint {
                s.name = Some(name);
            }
        }
        Ok(())
    }

    async fn update_last_connected(
        &mut self,
        fingerprint: &IdentityFingerprint,
    ) -> Result<(), ClientError> {
        if let Some(ref mut s) = self.session {
            if s.fingerprint == *fingerprint {
                s.last_connected_at = now_timestamp();
            }
        }
        Ok(())
    }

    async fn save_transport_state(
        &mut self,
        fingerprint: &IdentityFingerprint,
        transport: MultiDeviceTransport,
    ) -> Result<(), ClientError> {
        if let Some(ref mut s) = self.session {
            if s.fingerprint == *fingerprint {
                let bytes = transport.save_state().map_err(|e| {
                    ClientError::SessionCache(format!("failed to serialize transport: {e}"))
                })?;
                s.transport_state = Some(bytes);

                // Write-through to DB (includes key_data so we don't null it out)
                let cd = self.current_connection_data();
                self.write_through(&cd).await;
            }
        }
        Ok(())
    }

    async fn load_transport_state(
        &self,
        fingerprint: &IdentityFingerprint,
    ) -> Result<Option<MultiDeviceTransport>, ClientError> {
        let Some(ref s) = self.session else {
            return Ok(None);
        };
        if s.fingerprint != *fingerprint {
            return Ok(None);
        }
        let Some(ref bytes) = s.transport_state else {
            return Ok(None);
        };

        let transport = MultiDeviceTransport::restore_state(bytes)
            .map_err(|e| ClientError::SessionCache(format!("failed to restore transport: {e}")))?;

        Ok(Some(transport))
    }
}

fn now_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── BitwardenIdentityProvider ──────────────────────────────────────

    #[test]
    fn identity_provider_cose_round_trip() {
        let provider = BitwardenIdentityProvider::generate();
        let cose = provider.to_cose();
        let restored = BitwardenIdentityProvider::from_cose(&cose).expect("should decode");
        assert_eq!(provider.fingerprint(), restored.fingerprint());
    }

    #[test]
    fn identity_provider_from_cose_invalid_bytes() {
        assert!(BitwardenIdentityProvider::from_cose(&[0, 1, 2, 3]).is_err());
    }

    #[test]
    fn identity_provider_clone_preserves_fingerprint() {
        let provider = BitwardenIdentityProvider::generate();
        let cloned = provider.clone_provider();
        assert_eq!(provider.fingerprint(), cloned.fingerprint());
    }

    // ── BitwardenSessionStore construction ─────────────────────────────

    fn fake_pool() -> PgPool {
        sqlx::PgPool::connect_lazy("postgres://fake").expect("lazy pool")
    }

    #[tokio::test]
    async fn session_store_new_without_connection_data() {
        let store = BitwardenSessionStore::new(fake_pool(), "user1".into(), None, None);
        assert!(store.session.is_none());
    }

    #[tokio::test]
    async fn session_store_new_with_valid_connection_data() {
        let fp = hex::encode([42u8; 32]);
        let cd = BitwardenConnectionData {
            fingerprint: Some(fp.clone()),
            key_data: Some(vec![1, 2, 3]),
            transport_state: Some(vec![4, 5, 6]),
        };
        let store =
            BitwardenSessionStore::new(fake_pool(), "user1".into(), Some(vec![1, 2, 3]), Some(&cd));

        let session = store.session.as_ref().expect("should have session");
        assert_eq!(hex::encode(session.fingerprint.0), fp);
        assert_eq!(session.transport_state, Some(vec![4, 5, 6]));
    }

    #[tokio::test]
    async fn session_store_new_with_bad_fingerprint_returns_no_session() {
        let cd = BitwardenConnectionData {
            fingerprint: Some("not_valid_hex".into()),
            key_data: Some(vec![1]),
            transport_state: None,
        };
        let store = BitwardenSessionStore::new(fake_pool(), "user1".into(), None, Some(&cd));
        assert!(store.session.is_none());
    }

    #[tokio::test]
    async fn current_connection_data_includes_key_data() {
        let key_data = vec![10, 20, 30];
        let store =
            BitwardenSessionStore::new(fake_pool(), "user1".into(), Some(key_data.clone()), None);

        let cd = store.current_connection_data();
        assert_eq!(cd.key_data, Some(key_data));
        assert!(cd.fingerprint.is_none());
        assert!(cd.transport_state.is_none());
    }
}
