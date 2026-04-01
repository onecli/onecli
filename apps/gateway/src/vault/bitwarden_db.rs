//! DB-backed `IdentityProvider` and `ConnectionStore` for the Bitwarden vault provider.
//!
//! Instead of files, identity keypair and connection/transport state are stored in
//! the `VaultConnection.connectionData` JSON column (scoped to `provider = "bitwarden"`).

use std::sync::Arc;

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
use crate::crypto::CryptoService;
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

/// DB-backed connection store, scoped to a single `account_id` with `provider = "bitwarden"`.
///
/// Connections are cached in memory. Writes go through to the DB directly via async calls.
/// Sensitive fields (`key_data`, `transport_state`) are encrypted with AES-256-GCM before
/// being written to the `connection_data` JSON column.
pub(crate) struct BitwardenConnectionStore {
    pool: PgPool,
    account_id: String,
    /// COSE-encoded keypair — kept here so write-throughs don't null out key_data in DB.
    key_data: Option<Vec<u8>>,
    crypto: Arc<CryptoService>,
    /// In-memory connection (at most one per user for Bitwarden).
    connection: Option<ConnectionInfo>,
}

impl BitwardenConnectionStore {
    /// Create a new store, loading existing connection from DB if present.
    pub fn new(
        pool: PgPool,
        account_id: String,
        key_data: Option<Vec<u8>>,
        crypto: Arc<CryptoService>,
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
            account_id,
            key_data,
            crypto,
            connection,
        }
    }

    /// Persist the current connection data to DB (encrypted).
    async fn write_through(&self, cd: &BitwardenConnectionData) {
        let json = match encrypt_connection_data(&self.crypto, cd).await {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "failed to encrypt connection data for write-through");
                return;
            }
        };

        if let Err(e) =
            db::update_vault_connection_data(&self.pool, &self.account_id, "bitwarden", &json).await
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

// ── Connection data encryption ────────────────────────────────────────

/// Encrypt a `BitwardenConnectionData` for DB storage.
/// Returns a JSON value `{"encrypted": "iv:authTag:ciphertext"}`.
pub(super) async fn encrypt_connection_data(
    crypto: &CryptoService,
    cd: &BitwardenConnectionData,
) -> anyhow::Result<serde_json::Value> {
    let json_str = serde_json::to_string(cd)?;
    let encrypted = crypto.encrypt(&json_str).await?;
    Ok(serde_json::json!({ "encrypted": encrypted }))
}

/// Decrypt a `connection_data` JSON value from the DB.
/// Supports both encrypted (`{"encrypted": "..."}`) and legacy plaintext formats.
/// Legacy rows are transparently upgraded to encrypted on next write-through.
pub(super) async fn decrypt_connection_data(
    crypto: &CryptoService,
    value: &serde_json::Value,
) -> anyhow::Result<BitwardenConnectionData> {
    if let Some(encrypted_str) = value.get("encrypted").and_then(|v| v.as_str()) {
        let json_str = crypto.decrypt(encrypted_str).await?;
        Ok(serde_json::from_str(&json_str)?)
    } else {
        // Legacy: unencrypted connection data — will be encrypted on next write-through
        Ok(serde_json::from_value(value.clone())?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Test helpers ──────────────────────────────────────────────────

    fn test_crypto() -> Arc<CryptoService> {
        use base64::Engine;
        use ring::rand::{SecureRandom, SystemRandom};
        let rng = SystemRandom::new();
        let mut key = [0u8; 32];
        rng.fill(&mut key).expect("generate random key");
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(key);
        Arc::new(CryptoService::from_base64_key(&key_b64).expect("create test crypto"))
    }

    fn fake_pool() -> PgPool {
        sqlx::PgPool::connect_lazy("postgres://fake").expect("lazy pool")
    }

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

    #[tokio::test]
    async fn connection_store_new_without_data() {
        let store =
            BitwardenConnectionStore::new(fake_pool(), "user1".into(), None, test_crypto(), None);
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
            test_crypto(),
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
        let store = BitwardenConnectionStore::new(
            fake_pool(),
            "user1".into(),
            None,
            test_crypto(),
            Some(&cd),
        );
        assert!(store.connection.is_none());
    }

    #[tokio::test]
    async fn to_connection_data_includes_key_data() {
        let key_data = vec![10, 20, 30];
        let store = BitwardenConnectionStore::new(
            fake_pool(),
            "user1".into(),
            Some(key_data.clone()),
            test_crypto(),
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

    // ── Connection data encryption ────────────────────────────────────

    #[tokio::test]
    async fn encrypt_decrypt_connection_data_round_trip() {
        let crypto = test_crypto();
        let cd = BitwardenConnectionData {
            fingerprint: Some(hex::encode([42u8; 32])),
            key_data: Some(vec![1, 2, 3, 4, 5]),
            transport_state: Some(vec![10, 20, 30]),
        };

        let encrypted = encrypt_connection_data(&crypto, &cd)
            .await
            .expect("encrypt");
        assert!(
            encrypted.get("encrypted").is_some(),
            "should have encrypted wrapper"
        );

        let decrypted = decrypt_connection_data(&crypto, &encrypted)
            .await
            .expect("decrypt");
        assert_eq!(decrypted.fingerprint, cd.fingerprint);
        assert_eq!(decrypted.key_data, cd.key_data);
        assert_eq!(decrypted.transport_state, cd.transport_state);
    }

    #[tokio::test]
    async fn decrypt_legacy_plaintext_connection_data() {
        let crypto = test_crypto();
        let cd = BitwardenConnectionData {
            fingerprint: Some("abc123".into()),
            key_data: Some(vec![1, 2, 3]),
            transport_state: None,
        };
        let plaintext_json = serde_json::to_value(&cd).expect("serialize");

        let decrypted = decrypt_connection_data(&crypto, &plaintext_json)
            .await
            .expect("should handle legacy plaintext");
        assert_eq!(decrypted.fingerprint, cd.fingerprint);
        assert_eq!(decrypted.key_data, cd.key_data);
    }

    #[tokio::test]
    async fn decrypt_with_wrong_key_fails() {
        let crypto1 = test_crypto();
        let crypto2 = test_crypto();
        let cd = BitwardenConnectionData {
            fingerprint: Some("test".into()),
            key_data: Some(vec![1]),
            transport_state: None,
        };

        let encrypted = encrypt_connection_data(&crypto1, &cd)
            .await
            .expect("encrypt");
        assert!(decrypt_connection_data(&crypto2, &encrypted).await.is_err());
    }
}
