//! File-backed identity provider and session store for remote access.
//!
//! Implements the `IdentityProvider` and `SessionStore` traits from `bw-rat-client`
//! using local files for persistence.

use std::fs;
use std::path::{Path, PathBuf};

use bw_noise_protocol::MultiDeviceTransport;
use bw_proxy_protocol::IdentityKeyPair;
use bw_rat_client::{IdentityFingerprint, IdentityProvider, RemoteClientError, SessionStore};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

// ── FileIdentityProvider ────────────────────────────────────────────────

/// Loads or generates an `IdentityKeyPair` from disk.
/// The key is stored at `{data_dir}/remote-access/identity.key` in COSE format.
pub(crate) struct FileIdentityProvider {
    keypair: IdentityKeyPair,
}

impl FileIdentityProvider {
    /// Load an existing identity or generate a new one.
    pub fn load_or_generate(data_dir: &Path) -> anyhow::Result<Self> {
        let dir = data_dir.join("remote-access");
        fs::create_dir_all(&dir)?;

        let key_path = dir.join("identity.key");

        let keypair = if key_path.exists() {
            let bytes = fs::read(&key_path)?;
            IdentityKeyPair::from_cose(&bytes)
                .map_err(|e| anyhow::anyhow!("failed to load identity key: {e}"))?
        } else {
            let kp = IdentityKeyPair::generate();
            let bytes = kp.to_cose();
            fs::write(&key_path, &bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
            }
            info!(path = %key_path.display(), "generated new remote access identity");
            kp
        };

        let fingerprint = keypair.identity().fingerprint();
        info!(fingerprint = %hex::encode(fingerprint.0), "remote access identity loaded");

        Ok(Self { keypair })
    }
}

impl FileIdentityProvider {
    /// Create a new provider that shares the same keypair (for giving ownership to RemoteClient).
    pub fn clone_from_existing(other: &FileIdentityProvider) -> Self {
        Self {
            keypair: other.keypair.clone(),
        }
    }
}

impl IdentityProvider for FileIdentityProvider {
    fn identity(&self) -> &IdentityKeyPair {
        &self.keypair
    }
}

// ── FileSessionStore ────────────────────────────────────────────────────

/// Stores sessions as JSON files in `{data_dir}/remote-access/sessions/`.
pub(crate) struct FileSessionStore {
    sessions_dir: PathBuf,
    sessions: Vec<SessionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionEntry {
    fingerprint: String, // hex-encoded
    name: Option<String>,
    created_at: u64,
    last_connected_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport_state: Option<TransportState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TransportState {
    /// CBOR-encoded transport state, base64-encoded for JSON storage.
    data: String,
}

impl FileSessionStore {
    pub fn new(data_dir: &Path) -> anyhow::Result<Self> {
        let sessions_dir = data_dir.join("remote-access").join("sessions");
        fs::create_dir_all(&sessions_dir)?;

        let mut sessions = Vec::new();
        for entry in fs::read_dir(&sessions_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                match fs::read_to_string(&path) {
                    Ok(contents) => match serde_json::from_str::<SessionEntry>(&contents) {
                        Ok(session) => sessions.push(session),
                        Err(e) => {
                            warn!(path = %path.display(), error = %e, "skipping corrupt session file")
                        }
                    },
                    Err(e) => {
                        warn!(path = %path.display(), error = %e, "failed to read session file")
                    }
                }
            }
        }

        info!(count = sessions.len(), "loaded remote access sessions");
        Ok(Self {
            sessions_dir,
            sessions,
        })
    }

    fn find(&self, fingerprint: &IdentityFingerprint) -> Option<&SessionEntry> {
        let hex = hex::encode(fingerprint.0);
        self.sessions.iter().find(|s| s.fingerprint == hex)
    }

    /// Get the fingerprint of the first stored session (if any), for session restoration.
    pub fn first_session_fingerprint(&self) -> Option<IdentityFingerprint> {
        self.sessions.first().and_then(|s| {
            let bytes = hex::decode(&s.fingerprint).ok()?;
            if bytes.len() != 32 {
                return None;
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            Some(IdentityFingerprint(arr))
        })
    }
}

fn save_session_to_dir(sessions_dir: &Path, entry: &SessionEntry) -> Result<(), RemoteClientError> {
    let path = sessions_dir.join(format!("{}.json", entry.fingerprint));
    let json = serde_json::to_string_pretty(entry)
        .map_err(|e| RemoteClientError::SessionCache(e.to_string()))?;
    fs::write(&path, json).map_err(|e| RemoteClientError::SessionCache(e.to_string()))?;
    Ok(())
}

fn now_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl SessionStore for FileSessionStore {
    fn has_session(&self, fingerprint: &IdentityFingerprint) -> bool {
        self.find(fingerprint).is_some()
    }

    fn list_sessions(&self) -> Vec<(IdentityFingerprint, Option<String>, u64, u64)> {
        self.sessions
            .iter()
            .filter_map(|s| {
                let bytes = hex::decode(&s.fingerprint).ok()?;
                if bytes.len() != 32 {
                    return None;
                }
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&bytes);
                Some((
                    IdentityFingerprint(arr),
                    s.name.clone(),
                    s.created_at,
                    s.last_connected_at,
                ))
            })
            .collect()
    }

    fn cache_session(&mut self, fingerprint: IdentityFingerprint) -> Result<(), RemoteClientError> {
        let hex = hex::encode(fingerprint.0);
        if self.find(&fingerprint).is_some() {
            return Ok(());
        }

        let entry = SessionEntry {
            fingerprint: hex,
            name: None,
            created_at: now_timestamp(),
            last_connected_at: now_timestamp(),
            transport_state: None,
        };
        save_session_to_dir(&self.sessions_dir, &entry)?;
        self.sessions.push(entry);
        Ok(())
    }

    fn remove_session(
        &mut self,
        fingerprint: &IdentityFingerprint,
    ) -> Result<(), RemoteClientError> {
        let hex = hex::encode(fingerprint.0);
        let path = self.sessions_dir.join(format!("{hex}.json"));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| RemoteClientError::SessionCache(e.to_string()))?;
        }
        self.sessions.retain(|s| s.fingerprint != hex);
        Ok(())
    }

    fn clear(&mut self) -> Result<(), RemoteClientError> {
        for entry in &self.sessions {
            let path = self
                .sessions_dir
                .join(format!("{}.json", entry.fingerprint));
            let _ = fs::remove_file(&path);
        }
        self.sessions.clear();
        Ok(())
    }

    fn set_session_name(
        &mut self,
        fingerprint: &IdentityFingerprint,
        name: String,
    ) -> Result<(), RemoteClientError> {
        let hex = hex::encode(fingerprint.0);
        if let Some(entry) = self.sessions.iter_mut().find(|s| s.fingerprint == hex) {
            entry.name = Some(name);
            save_session_to_dir(&self.sessions_dir, entry)?;
        }
        Ok(())
    }

    fn update_last_connected(
        &mut self,
        fingerprint: &IdentityFingerprint,
    ) -> Result<(), RemoteClientError> {
        let hex = hex::encode(fingerprint.0);
        if let Some(entry) = self.sessions.iter_mut().find(|s| s.fingerprint == hex) {
            entry.last_connected_at = now_timestamp();
            save_session_to_dir(&self.sessions_dir, entry)?;
        }
        Ok(())
    }

    fn save_transport_state(
        &mut self,
        fingerprint: &IdentityFingerprint,
        transport: MultiDeviceTransport,
    ) -> Result<(), RemoteClientError> {
        let hex = hex::encode(fingerprint.0);
        if let Some(entry) = self.sessions.iter_mut().find(|s| s.fingerprint == hex) {
            let bytes = transport.save_state().map_err(|e| {
                RemoteClientError::SessionCache(format!("failed to serialize transport: {e}"))
            })?;
            entry.transport_state = Some(TransportState {
                data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
            });
            save_session_to_dir(&self.sessions_dir, entry)?;
        }
        Ok(())
    }

    fn load_transport_state(
        &self,
        fingerprint: &IdentityFingerprint,
    ) -> Result<Option<MultiDeviceTransport>, RemoteClientError> {
        let Some(entry) = self.find(fingerprint) else {
            return Ok(None);
        };
        let Some(ref state) = entry.transport_state else {
            return Ok(None);
        };

        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &state.data)
            .map_err(|e| {
                RemoteClientError::SessionCache(format!("invalid transport base64: {e}"))
            })?;

        let transport = MultiDeviceTransport::restore_state(&bytes).map_err(|e| {
            RemoteClientError::SessionCache(format!("failed to restore transport: {e}"))
        })?;

        Ok(Some(transport))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_identity_provider_generates_and_reloads() {
        let tmp = tempfile::tempdir().unwrap();
        let provider1 = FileIdentityProvider::load_or_generate(tmp.path()).unwrap();
        let fp1 = provider1.fingerprint();

        let provider2 = FileIdentityProvider::load_or_generate(tmp.path()).unwrap();
        let fp2 = provider2.fingerprint();

        assert_eq!(fp1, fp2, "reloaded identity should match");
    }

    #[test]
    fn file_session_store_crud() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = FileSessionStore::new(tmp.path()).unwrap();

        let fp = IdentityFingerprint([42u8; 32]);

        assert!(!store.has_session(&fp));
        store.cache_session(fp).unwrap();
        assert!(store.has_session(&fp));

        store.set_session_name(&fp, "test device".into()).unwrap();

        let sessions = store.list_sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].1.as_deref(), Some("test device"));

        store.remove_session(&fp).unwrap();
        assert!(!store.has_session(&fp));
    }

    #[test]
    fn file_session_store_persists_across_loads() {
        let tmp = tempfile::tempdir().unwrap();

        let fp = IdentityFingerprint([7u8; 32]);
        {
            let mut store = FileSessionStore::new(tmp.path()).unwrap();
            store.cache_session(fp).unwrap();
            store.set_session_name(&fp, "persisted".into()).unwrap();
        }

        let store = FileSessionStore::new(tmp.path()).unwrap();
        assert!(store.has_session(&fp));
        let sessions = store.list_sessions();
        assert_eq!(sessions[0].1.as_deref(), Some("persisted"));
    }
}
