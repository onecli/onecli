//! DB-backed `IdentityProvider` and `ConnectionStore` for the Bitwarden vault provider.
//!
//! Instead of files, identity keypair and connection/transport state are stored in
//! the `VaultConnection.connectionData` JSON column (scoped to `provider = "bitwarden"`).

use ap_client::{
    ClientError, ConnectionInfo, ConnectionStore, ConnectionUpdate, IdentityFingerprint,
    IdentityProvider,
};
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

// ── BitwardenConnectionStore ────────────────────────────────────────────

/// DB-backed connection store, scoped to a single `user_id` with `provider = "bitwarden"`.
///
/// Connections are cached in memory. Writes go through to the DB directly via async calls.
pub(crate) struct BitwardenConnectionStore {
    pool: PgPool,
    user_id: String,
    /// COSE-encoded keypair — kept here so write-throughs don't null out key_data in DB.
    key_data: Option<Vec<u8>>,
    /// In-memory connection (at most one per user for Bitwarden).
    connection: Option<ConnectionInfo>,
}

impl BitwardenConnectionStore {
    /// Create a new store, loading existing connection from DB if present.
    pub fn new(
        pool: PgPool,
        user_id: String,
        key_data: Option<Vec<u8>>,
        connection_data: Option<&BitwardenConnectionData>,
    ) -> Self {
        let connection = connection_data.and_then(|cd| {
            let fingerprint = parse_fingerprint(cd.fingerprint.as_deref()?)?;
            let transport_state = cd.transport_state.as_ref().and_then(|bytes| {
                MultiDeviceTransport::restore_state(bytes)
                    .map_err(|e| warn!(error = %e, "failed to restore transport state"))
                    .ok()
            });

            Some(ConnectionInfo {
                fingerprint,
                name: None,
                cached_at: now_timestamp(),
                last_connected_at: now_timestamp(),
                transport_state,
            })
        });

        Self {
            pool,
            user_id,
            key_data,
            connection,
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

    /// Build `BitwardenConnectionData` from in-memory state for DB persistence.
    fn to_connection_data(&self, info: &ConnectionInfo) -> BitwardenConnectionData {
        BitwardenConnectionData {
            fingerprint: Some(hex::encode(info.fingerprint.0)),
            key_data: self.key_data.clone(),
            transport_state: info.transport_state.as_ref().and_then(|t| {
                t.save_state()
                    .map_err(|e| warn!(error = %e, "failed to serialize transport state"))
                    .ok()
            }),
        }
    }
}

#[async_trait]
impl ConnectionStore for BitwardenConnectionStore {
    async fn get(&self, fingerprint: &IdentityFingerprint) -> Option<ConnectionInfo> {
        self.connection
            .as_ref()
            .filter(|c| c.fingerprint == *fingerprint)
            .cloned()
    }

    async fn save(&mut self, connection: ConnectionInfo) -> Result<(), ClientError> {
        let cd = self.to_connection_data(&connection);
        self.connection = Some(connection);
        self.write_through(&cd).await;
        Ok(())
    }

    async fn update(&mut self, update: ConnectionUpdate) -> Result<(), ClientError> {
        if let Some(ref mut c) = self.connection {
            if c.fingerprint == update.fingerprint {
                c.last_connected_at = update.last_connected_at;
            }
        }
        Ok(())
    }

    async fn list(&self) -> Vec<ConnectionInfo> {
        self.connection.iter().cloned().collect()
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

    // ── BitwardenConnectionStore construction ─────────────────────────

    fn fake_pool() -> PgPool {
        sqlx::PgPool::connect_lazy("postgres://fake").expect("lazy pool")
    }

    #[tokio::test]
    async fn connection_store_new_without_data() {
        let store = BitwardenConnectionStore::new(fake_pool(), "user1".into(), None, None);
        assert!(store.connection.is_none());
    }

    #[tokio::test]
    async fn connection_store_new_with_valid_data() {
        let fp = hex::encode([42u8; 32]);
        let cd = BitwardenConnectionData {
            fingerprint: Some(fp.clone()),
            key_data: Some(vec![1, 2, 3]),
            transport_state: None,
        };
        let store = BitwardenConnectionStore::new(
            fake_pool(),
            "user1".into(),
            Some(vec![1, 2, 3]),
            Some(&cd),
        );

        let conn = store.connection.as_ref().expect("should have connection");
        assert_eq!(hex::encode(conn.fingerprint.0), fp);
    }

    #[tokio::test]
    async fn connection_store_new_with_bad_fingerprint() {
        let cd = BitwardenConnectionData {
            fingerprint: Some("not_valid_hex".into()),
            key_data: Some(vec![1]),
            transport_state: None,
        };
        let store = BitwardenConnectionStore::new(fake_pool(), "user1".into(), None, Some(&cd));
        assert!(store.connection.is_none());
    }

    #[tokio::test]
    async fn to_connection_data_includes_key_data() {
        let key_data = vec![10, 20, 30];
        let store = BitwardenConnectionStore::new(
            fake_pool(),
            "user1".into(),
            Some(key_data.clone()),
            None,
        );

        let info = ConnectionInfo {
            fingerprint: IdentityFingerprint([1u8; 32]),
            name: None,
            cached_at: 0,
            last_connected_at: 0,
            transport_state: None,
        };
        let cd = store.to_connection_data(&info);
        assert_eq!(cd.key_data, Some(key_data));
    }
}
