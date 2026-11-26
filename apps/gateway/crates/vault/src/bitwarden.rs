//! Bitwarden vault provider — `BitwardenVaultProvider` implementing `VaultProvider`.
//!
//! Contains all Bitwarden-specific logic: `RemoteClient` lifecycle, PSK pairing,
//! Noise protocol, credential caching, and session restore. Per-account sessions are
//! stored in a `DashMap<workspace_id, Arc<BitwardenUserSession>>`.
//!
//! A cached session is re-checked against its `vault_connections` row on every
//! use (see the crate docs), so a disconnect or re-pair made through any
//! gateway instance closes this instance's client on the next request.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use ap_client::{
    CredentialData, CredentialQuery, DefaultProxyClient, IdentityFingerprint, Psk, RemoteClient,
    RemoteClientHandle, RemoteClientNotification,
};
use async_trait::async_trait;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use super::bitwarden_db::{
    decrypt_connection_data, encrypt_connection_data, BitwardenConnectionStore,
    BitwardenIdentityProvider, SharedGeneration,
};
use super::{
    check_session, PairResult, ProviderStatus, SessionCheck, VaultCredential, VaultProvider,
};
use crypto::CryptoService;

const PROVIDER: &str = "bitwarden";

/// Parse a hex-encoded fingerprint string into an `IdentityFingerprint`.
pub(super) fn parse_fingerprint(hex_str: &str) -> Option<IdentityFingerprint> {
    let bytes = hex::decode(hex_str).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Some(IdentityFingerprint(arr))
}

/// How long to cache successful credential lookups.
const CREDENTIAL_CACHE_TTL: Duration = Duration::from_secs(60);
/// How long to cache negative (no credential found) results.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(30);
/// Timeout for individual credential requests.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// After a connection failure, skip vault lookups for this long before retrying.
const ERROR_COOLDOWN: Duration = Duration::from_secs(60);
/// How often the eviction task runs.
const EVICTION_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Evict sessions idle longer than this.
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

// ── Connection data ─────────────────────────────────────────────────────

/// Bitwarden-specific data stored in `VaultConnection.connectionData`.
/// Each field is optional to support incremental state build-up during pairing.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BitwardenConnectionData {
    /// Hex-encoded fingerprint of the remote (desktop) device.
    pub fingerprint: Option<String>,
    /// COSE-encoded identity keypair bytes.
    #[serde(
        serialize_with = "serialize_bytes_opt",
        deserialize_with = "deserialize_bytes_opt",
        default
    )]
    pub key_data: Option<Vec<u8>>,
    /// Noise protocol transport state (CBOR bytes).
    #[serde(
        serialize_with = "serialize_bytes_opt",
        deserialize_with = "deserialize_bytes_opt",
        default
    )]
    pub transport_state: Option<Vec<u8>>,
}

/// Serialize `Option<Vec<u8>>` as base64 string for JSON storage.
fn serialize_bytes_opt<S: serde::Serializer>(
    val: &Option<Vec<u8>>,
    s: S,
) -> Result<S::Ok, S::Error> {
    match val {
        Some(bytes) => {
            use base64::Engine;
            s.serialize_some(&base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        None => s.serialize_none(),
    }
}

/// Deserialize `Option<Vec<u8>>` from base64 string.
fn deserialize_bytes_opt<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Vec<u8>>, D::Error> {
    let opt: Option<String> = Option::deserialize(d)?;
    match opt {
        Some(s) => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&s)
                .map_err(serde::de::Error::custom)?;
            Ok(Some(bytes))
        }
        None => Ok(None),
    }
}

// ── Per-workspace session ───────────────────────────────────────────────────

struct CachedCredential {
    data: Option<CredentialData>,
    expires_at: Instant,
}

struct BitwardenUserSession {
    client: Mutex<Option<RemoteClient>>,
    identity: BitwardenIdentityProvider,
    /// The row generation this session is valid at. Shared with the session's
    /// connection store, whose write-throughs advance it (see
    /// [`SharedGeneration`]).
    generation: SharedGeneration,
    /// Cached connectionData from DB — avoids redundant reads during lazy restore.
    connection_data: Option<BitwardenConnectionData>,
    credential_cache: DashMap<String, CachedCredential>,
    /// Last time this session was used (for eviction). Uses std::sync::Mutex since
    /// the update is instant (no .await while holding it).
    last_used: std::sync::Mutex<Instant>,
    /// Last error from the notification listener, lazy restore, or credential request.
    /// Cleared on successful connect. Shared with the notification listener via Arc.
    last_error: Arc<std::sync::Mutex<Option<String>>>,
    /// Skip credential requests until this time (after a failure).
    /// Prevents repeated 15s timeouts when the vault is down.
    error_until: std::sync::Mutex<Option<Instant>>,
    /// Set by the notification listener when `Ready { can_request_credentials: true }` is received.
    is_ready: Arc<AtomicBool>,
}

impl BitwardenUserSession {
    fn generation(&self) -> Option<db::VaultGeneration> {
        self.generation.lock().ok().and_then(|g| *g)
    }

    fn set_generation(&self, generation: db::VaultGeneration) {
        if let Ok(mut current) = self.generation.lock() {
            *current = Some(generation);
        }
    }
}

// ── Config ──────────────────────────────────────────────────────────────

pub struct BitwardenConfig {
    pub proxy_url: String,
}

// ── Provider ────────────────────────────────────────────────────────────

pub struct BitwardenVaultProvider {
    config: BitwardenConfig,
    pool: PgPool,
    crypto: Arc<CryptoService>,
    sessions: Arc<DashMap<String, Arc<BitwardenUserSession>>>,
}

impl BitwardenVaultProvider {
    pub fn new(config: BitwardenConfig, pool: PgPool, crypto: Arc<CryptoService>) -> Self {
        let sessions = Arc::new(DashMap::new());
        Self::spawn_eviction_task(Arc::clone(&sessions));
        Self {
            config,
            pool,
            crypto,
            sessions,
        }
    }

    /// Background task that evicts idle sessions every `EVICTION_INTERVAL`.
    /// For each idle session: acquires the client Mutex (ensuring no in-flight request),
    /// closes the RemoteClient, then removes from the DashMap.
    fn spawn_eviction_task(sessions: Arc<DashMap<String, Arc<BitwardenUserSession>>>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(EVICTION_INTERVAL);
            loop {
                interval.tick().await;

                // Collect workspace_ids to evict (don't hold DashMap iter across await)
                let to_evict: Vec<String> = sessions
                    .iter()
                    .filter_map(|entry| {
                        let last_used = entry.value().last_used.lock().ok()?;
                        if last_used.elapsed() > SESSION_IDLE_TIMEOUT {
                            Some(entry.key().clone())
                        } else {
                            None
                        }
                    })
                    .collect();

                for workspace_id in to_evict {
                    // Remove from map first — new requests will re-create from DB
                    if let Some((_, session)) = sessions.remove(&workspace_id) {
                        // Acquire lock to ensure no in-flight credential request, then drop the handle
                        let mut guard = session.client.lock().await;
                        guard.take(); // dropping the handle disconnects
                        session.credential_cache.clear();
                        session.is_ready.store(false, Ordering::Relaxed);
                        info!(workspace_id = %workspace_id, "bitwarden: evicted idle session");
                    }
                }
            }
        });
    }

    /// Load the workspace's session, or `None` if it is not paired (no
    /// VaultConnection row). Does NOT generate a new identity.
    ///
    /// A cached session is served only after its row confirms it: gone means
    /// disconnected (close the client, return `None`), a new generation means
    /// re-paired (close it and load the new pairing). A database error fails
    /// the call and keeps the session.
    async fn load_session(&self, workspace_id: &str) -> Result<Option<Arc<BitwardenUserSession>>> {
        // Clone out of the map so no shard lock is held across the await.
        let cached = self
            .sessions
            .get(workspace_id)
            .map(|entry| Arc::clone(entry.value()));
        if let Some(session) = cached {
            match check_session(&self.pool, workspace_id, PROVIDER, session.generation()).await? {
                SessionCheck::Current => return Ok(Some(session)),
                SessionCheck::Gone => {
                    self.evict(workspace_id, session);
                    info!(workspace_id = %workspace_id, "bitwarden: connection removed; session closed");
                    return Ok(None);
                }
                SessionCheck::Superseded => {
                    self.evict(workspace_id, session);
                    info!(workspace_id = %workspace_id, "bitwarden: connection re-paired; reloading session");
                }
            }
        }

        // Load from DB — if no row, workspace has never paired
        let row = match db::find_vault_connection(&self.pool, workspace_id, PROVIDER).await? {
            Some(r) => r,
            None => return Ok(None),
        };

        let cd: Option<BitwardenConnectionData> = match row.connection_data.as_ref() {
            Some(v) => match decrypt_connection_data(&self.crypto, v).await {
                Ok(cd) => Some(cd),
                Err(e) => {
                    warn!(error = ?e, workspace_id, "failed to decrypt vault connection data");
                    None
                }
            },
            None => None,
        };

        let key_data = cd.as_ref().and_then(|c| c.key_data.as_ref());
        let identity = match key_data {
            Some(kd) => BitwardenIdentityProvider::from_cose(kd)?,
            None => return Ok(None), // row exists but no key_data — incomplete pairing
        };

        let session = Arc::new(BitwardenUserSession {
            client: Mutex::new(None),
            identity,
            generation: Arc::new(std::sync::Mutex::new(Some(row.generation))),
            connection_data: cd,
            credential_cache: DashMap::new(),
            last_used: std::sync::Mutex::new(Instant::now()),
            last_error: Arc::new(std::sync::Mutex::new(None)),
            error_until: std::sync::Mutex::new(None),
            is_ready: Arc::new(AtomicBool::new(false)),
        });

        self.sessions
            .insert(workspace_id.to_string(), Arc::clone(&session));
        Ok(Some(session))
    }

    /// Drop `session` from the map — only if it is still the one there, so a
    /// concurrent reload's fresh session is never removed in its place — and
    /// close its client. Exactly one caller wins the removal, so exactly one
    /// close is scheduled per session.
    ///
    /// The close runs in the background: it waits for the client lock, which
    /// an in-flight credential request may hold for its full timeout, and the
    /// caller must not stall on that. The session is unreachable from the map
    /// the moment `remove_if` returns, so nothing new can use it meanwhile.
    /// The close is skipped if `pair` reinstated this very session in the
    /// meantime (a lookup that raced a pairing's own row write), so a late
    /// close never tears down the client that pairing just connected.
    fn evict(&self, workspace_id: &str, session: Arc<BitwardenUserSession>) {
        let removed = self
            .sessions
            .remove_if(workspace_id, |_, current| Arc::ptr_eq(current, &session));
        if removed.is_none() {
            return;
        }
        let sessions = Arc::clone(&self.sessions);
        let workspace_id = workspace_id.to_string();
        tokio::spawn(async move {
            let mut guard = session.client.lock().await;
            let reinstated = sessions
                .get(&workspace_id)
                .is_some_and(|current| Arc::ptr_eq(current.value(), &session));
            if reinstated {
                return;
            }
            guard.take(); // dropping the handle disconnects
            session.credential_cache.clear();
            session.is_ready.store(false, Ordering::Relaxed);
        });
    }

    /// Create a new session with a fresh identity for pairing. Its generation
    /// is unknown until the pairing writes the row, so it is NOT installed in
    /// the map here: `pair` installs it once the row exists, or a concurrent
    /// lookup would find a session with no row behind it and drop it.
    fn new_pairing_session() -> Arc<BitwardenUserSession> {
        Arc::new(BitwardenUserSession {
            client: Mutex::new(None),
            identity: BitwardenIdentityProvider::generate(),
            generation: Arc::new(std::sync::Mutex::new(None)),
            connection_data: None,
            credential_cache: DashMap::new(),
            last_used: std::sync::Mutex::new(Instant::now()),
            last_error: Arc::new(std::sync::Mutex::new(None)),
            error_until: std::sync::Mutex::new(None),
            is_ready: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Create a connected `RemoteClient` for a workspace session.
    /// Always passes the identity's key_data to the connection store so write-throughs
    /// never null it out — even for fresh pairings where connection_data is None.
    async fn create_and_connect_client(
        &self,
        workspace_id: &str,
        session: &BitwardenUserSession,
    ) -> Result<RemoteClient> {
        let proxy_client = DefaultProxyClient::from_url(self.config.proxy_url.clone());

        let key_data = Some(session.identity.to_cose());
        let identity_provider = session.identity.clone_provider();
        let connection_store = BitwardenConnectionStore::new(
            self.pool.clone(),
            workspace_id.to_string(),
            key_data,
            Arc::clone(&self.crypto),
            session.connection_data.as_ref(),
            Arc::clone(&session.generation),
        );

        let RemoteClientHandle {
            client,
            notifications,
            requests: _,
        } = RemoteClient::connect(
            Box::new(identity_provider),
            Box::new(connection_store),
            Box::new(proxy_client),
        )
        .await
        .map_err(|e| anyhow!("failed to connect remote client: {e}"))?;

        Self::spawn_notification_listener(
            workspace_id.to_string(),
            notifications,
            Arc::clone(&session.last_error),
            Arc::clone(&session.is_ready),
        );

        Ok(client)
    }

    /// Consumes notifications from the `RemoteClient` for logging and readiness tracking.
    fn spawn_notification_listener(
        workspace_id: String,
        mut notifications: mpsc::Receiver<RemoteClientNotification>,
        last_error: Arc<std::sync::Mutex<Option<String>>>,
        is_ready: Arc<AtomicBool>,
    ) {
        tokio::spawn(async move {
            while let Some(notif) = notifications.recv().await {
                match &notif {
                    RemoteClientNotification::Connecting => {
                        info!(workspace_id = %workspace_id, "bitwarden: connecting");
                    }
                    RemoteClientNotification::Connected { fingerprint } => {
                        info!(
                            workspace_id = %workspace_id,
                            fingerprint = %hex::encode(fingerprint.0),
                            "bitwarden: connected"
                        );
                        // Clear error on successful connect
                        if let Ok(mut err) = last_error.lock() {
                            *err = None;
                        }
                    }
                    RemoteClientNotification::Ready {
                        can_request_credentials,
                    } => {
                        is_ready.store(*can_request_credentials, Ordering::Relaxed);
                        info!(
                            workspace_id = %workspace_id,
                            can_request = can_request_credentials,
                            "bitwarden: ready"
                        );
                    }
                    RemoteClientNotification::CredentialReceived { credential, .. } => {
                        info!(workspace_id = %workspace_id, credential = ?credential, "bitwarden: credential received");
                    }
                    RemoteClientNotification::Error { message, context } => {
                        let detail = match context {
                            Some(ctx) => format!("{message} ({ctx})"),
                            None => message.clone(),
                        };
                        warn!(workspace_id = %workspace_id, error = %detail, "bitwarden: error");
                        if let Ok(mut err) = last_error.lock() {
                            *err = Some(detail);
                        }
                    }
                    RemoteClientNotification::Disconnected { reason } => {
                        is_ready.store(false, Ordering::Relaxed);
                        let detail = reason.as_deref().unwrap_or("unknown reason").to_string();
                        warn!(workspace_id = %workspace_id, reason = %detail, "bitwarden: disconnected");
                        if let Ok(mut err) = last_error.lock() {
                            *err = Some(format!("Disconnected: {detail}"));
                        }
                    }
                    _ => {
                        info!(workspace_id = %workspace_id, notif = ?notif, "bitwarden: notification");
                    }
                }
            }
            // Channel closed — client handle was dropped
            is_ready.store(false, Ordering::Relaxed);
        });
    }
}

#[async_trait]
impl VaultProvider for BitwardenVaultProvider {
    fn provider_name(&self) -> &'static str {
        PROVIDER
    }

    async fn pair(&self, workspace_id: &str, params: &serde_json::Value) -> Result<PairResult> {
        let psk_hex = params
            .get("psk_hex")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("missing psk_hex in pair params"))?;
        let fingerprint_hex = params
            .get("fingerprint_hex")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("missing fingerprint_hex in pair params"))?;

        let psk = Psk::from_hex(psk_hex).map_err(|e| anyhow!("invalid PSK: {e}"))?;

        let remote_fingerprint = parse_fingerprint(fingerprint_hex)
            .ok_or_else(|| anyhow!("invalid fingerprint: must be 32 hex-encoded bytes"))?;

        let session = match self.load_session(workspace_id).await? {
            Some(s) => s,
            None => Self::new_pairing_session(),
        };

        // Create the DB row BEFORE pairing so that ConnectionStore::save()'s
        // write-through has a row to update. key_data + fingerprint go in now;
        // transport_state will be added by save() during pair_with_psk.
        let initial_cd = BitwardenConnectionData {
            fingerprint: Some(fingerprint_hex.to_string()),
            key_data: Some(session.identity.to_cose()),
            transport_state: None,
        };
        let encrypted_cd = encrypt_connection_data(&self.crypto, &initial_cd).await?;
        let generation = db::upsert_vault_connection(
            &self.pool,
            workspace_id,
            PROVIDER,
            "paired",
            Some(&encrypted_cd),
        )
        .await?;
        // This instance's own write: the session moves to the row's new
        // generation rather than reading it as a re-pair from elsewhere. The
        // pairing's write-through below advances it again the same way.
        session.set_generation(generation);
        // (Re)install it now that it matches the row. A concurrent lookup that
        // raced the upsert may have dropped it as superseded; this puts the
        // pairing session back as the workspace's one session.
        self.sessions
            .insert(workspace_id.to_string(), Arc::clone(&session));

        let client = self
            .create_and_connect_client(workspace_id, &session)
            .await?;

        client
            .pair_with_psk(psk, remote_fingerprint)
            .await
            .map_err(|e| anyhow!("PSK pairing failed: {e}"))?;

        info!(
            workspace_id = %workspace_id,
            fingerprint = %fingerprint_hex,
            "bitwarden: paired via PSK"
        );

        *session.client.lock().await = Some(client);

        // Clear any previous error + cooldown on successful pair
        if let Ok(mut err) = session.last_error.lock() {
            *err = None;
        }
        if let Ok(mut eu) = session.error_until.lock() {
            *eu = None;
        }

        Ok(PairResult { display_name: None })
    }

    async fn request_credential(
        &self,
        workspace_id: &str,
        hostname: &str,
    ) -> Option<VaultCredential> {
        // Load existing session — returns None if workspace never paired
        let session = match self.load_session(workspace_id).await {
            Ok(Some(s)) => s,
            _ => return None,
        };

        // Touch last_used for eviction tracking
        if let Ok(mut last_used) = session.last_used.lock() {
            *last_used = Instant::now();
        }

        // Skip if in error cooldown — avoids repeated 15s timeouts when vault is down
        if let Ok(guard) = session.error_until.lock() {
            if guard.is_some_and(|until| Instant::now() < until) {
                return None;
            }
        }

        // Check credential cache first — avoids expensive lazy restore if cached
        if let Some(cached) = session.credential_cache.get(hostname) {
            if cached.expires_at > Instant::now() {
                return cached.data.as_ref().map(|c| VaultCredential {
                    username: c.username.clone(),
                    password: c.password.clone(),
                });
            }
        }
        session.credential_cache.remove(hostname);

        // If client is not connected, try to restore the cached session
        {
            let mut client_guard = session.client.lock().await;
            if client_guard.is_none() {
                // Extract fingerprint from cached connectionData (no DB read)
                let fingerprint = session
                    .connection_data
                    .as_ref()
                    .and_then(|cd| cd.fingerprint.as_deref())
                    .and_then(parse_fingerprint);

                let fp = fingerprint?;

                match self.create_and_connect_client(workspace_id, &session).await {
                    Ok(client) => match client.load_cached_connection(fp).await {
                        Ok(()) => {
                            info!(workspace_id = %workspace_id, "bitwarden: lazy session restored");
                            *client_guard = Some(client);
                        }
                        Err(e) => {
                            let msg = format!("Session restore failed: {e}");
                            warn!(workspace_id = %workspace_id, error = %msg, "bitwarden: lazy restore failed");
                            if let Ok(mut err) = session.last_error.lock() {
                                *err = Some(msg);
                            }
                            if let Ok(mut eu) = session.error_until.lock() {
                                *eu = Some(Instant::now() + ERROR_COOLDOWN);
                            }
                            drop(client); // dropping the handle disconnects
                            return None;
                        }
                    },
                    Err(e) => {
                        let msg = format!("Connection failed: {e}");
                        warn!(workspace_id = %workspace_id, error = %msg, "bitwarden: failed to create client for lazy restore");
                        if let Ok(mut err) = session.last_error.lock() {
                            *err = Some(msg);
                        }
                        if let Ok(mut eu) = session.error_until.lock() {
                            *eu = Some(Instant::now() + ERROR_COOLDOWN);
                        }
                        return None;
                    }
                }
            }
        }

        if !session.is_ready.load(Ordering::Relaxed) {
            return None;
        }

        let client_guard = session.client.lock().await;
        let client = client_guard.as_ref()?;

        let query = CredentialQuery::Domain(hostname.to_string());
        let result = tokio::time::timeout(REQUEST_TIMEOUT, client.request_credential(&query)).await;

        let cred = match result {
            Ok(Ok(cred)) => {
                // Clear error + cooldown on successful credential fetch
                if let Ok(mut err) = session.last_error.lock() {
                    *err = None;
                }
                if let Ok(mut eu) = session.error_until.lock() {
                    *eu = None;
                }
                Some(cred)
            }
            Ok(Err(e)) => {
                let msg = e.to_string();
                warn!(workspace_id = %workspace_id, hostname = %hostname, error = %msg, "bitwarden: credential request failed");
                if let Ok(mut err) = session.last_error.lock() {
                    if err.is_none() {
                        *err = Some(msg);
                    }
                }
                if let Ok(mut eu) = session.error_until.lock() {
                    *eu = Some(Instant::now() + ERROR_COOLDOWN);
                }
                None
            }
            Err(_) => {
                warn!(workspace_id = %workspace_id, hostname = %hostname, "bitwarden: credential request timed out");
                if let Ok(mut err) = session.last_error.lock() {
                    if err.is_none() {
                        *err = Some(
                            "Credential request timed out. The vault may be disconnected."
                                .to_string(),
                        );
                    }
                }
                if let Ok(mut eu) = session.error_until.lock() {
                    *eu = Some(Instant::now() + ERROR_COOLDOWN);
                }
                None
            }
        };

        let (data, ttl) = match &cred {
            Some(c) => (Some(c.clone()), CREDENTIAL_CACHE_TTL),
            None => (None, NEGATIVE_CACHE_TTL),
        };

        session.credential_cache.insert(
            hostname.to_string(),
            CachedCredential {
                data,
                expires_at: Instant::now() + ttl,
            },
        );

        cred.map(|c| VaultCredential {
            username: c.username,
            password: c.password,
        })
    }

    async fn status(&self, workspace_id: &str) -> ProviderStatus {
        let session = match self.load_session(workspace_id).await {
            Ok(Some(s)) => s,
            _ => {
                return ProviderStatus {
                    connected: false,
                    name: None,
                    status_data: None,
                }
            }
        };

        let connected = session.is_ready.load(Ordering::Relaxed);
        let fingerprint = hex::encode(session.identity.fingerprint().0);
        let last_error = session.last_error.lock().ok().and_then(|e| e.clone());

        ProviderStatus {
            connected,
            name: None,
            status_data: Some(serde_json::json!({
                "fingerprint": fingerprint,
                "last_error": last_error,
            })),
        }
    }

    async fn disconnect(&self, workspace_id: &str) -> Result<()> {
        if let Some((_, session)) = self.sessions.remove(workspace_id) {
            let mut guard = session.client.lock().await;
            guard.take(); // dropping the handle disconnects
            session.credential_cache.clear();
            session.is_ready.store(false, Ordering::Relaxed);
        }

        info!(workspace_id = %workspace_id, "bitwarden: disconnected");
        Ok(())
    }

    // No restore_sessions — sessions are loaded lazily on first request_credential call.
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_fingerprint ──────────────────────────────────────────────

    #[test]
    fn parse_fingerprint_valid() {
        let hex = hex::encode([42u8; 32]);
        let fp = parse_fingerprint(&hex).expect("should parse valid 32-byte hex");
        assert_eq!(fp.0, [42u8; 32]);
    }

    #[test]
    fn parse_fingerprint_wrong_length() {
        let hex = hex::encode([1u8; 16]); // 16 bytes, not 32
        assert!(parse_fingerprint(&hex).is_none());
    }

    #[test]
    fn parse_fingerprint_invalid_hex() {
        assert!(parse_fingerprint("zzzz_not_hex").is_none());
    }

    #[test]
    fn parse_fingerprint_empty() {
        assert!(parse_fingerprint("").is_none());
    }

    // ── BitwardenConnectionData serde ──────────────────────────────────

    #[test]
    fn connection_data_round_trip() {
        let cd = BitwardenConnectionData {
            fingerprint: Some("abc123".to_string()),
            key_data: Some(vec![1, 2, 3, 4]),
            transport_state: Some(vec![5, 6, 7]),
        };

        let json = serde_json::to_value(&cd).expect("serialize");
        let deserialized: BitwardenConnectionData =
            serde_json::from_value(json).expect("deserialize");

        assert_eq!(deserialized.fingerprint, cd.fingerprint);
        assert_eq!(deserialized.key_data, cd.key_data);
        assert_eq!(deserialized.transport_state, cd.transport_state);
    }

    #[test]
    fn connection_data_null_fields() {
        let cd = BitwardenConnectionData::default();
        let json = serde_json::to_value(&cd).expect("serialize");
        let deserialized: BitwardenConnectionData =
            serde_json::from_value(json).expect("deserialize");

        assert!(deserialized.fingerprint.is_none());
        assert!(deserialized.key_data.is_none());
        assert!(deserialized.transport_state.is_none());
    }

    // ── Cross-instance revocation, over a real Postgres ─────────────────
    //
    // Two providers over one database stand in for two gateway instances.
    // Pairing dials the Bitwarden relay, so these write the row the way a
    // pairing does and drive the session machinery directly.

    use crate::bitwarden_db::{BitwardenConnectionStore, BitwardenIdentityProvider};
    use crate::test_support::{seed_workspace, test_crypto, test_pool};
    use crate::VaultService;
    use ap_client::{ConnectionInfo, ConnectionStore};

    fn provider(pool: &PgPool, crypto: &Arc<CryptoService>) -> BitwardenVaultProvider {
        BitwardenVaultProvider::new(
            BitwardenConfig {
                // Never dialed: these tests never connect a client.
                proxy_url: "ws://127.0.0.1:9".into(),
            },
            pool.clone(),
            Arc::clone(crypto),
        )
    }

    /// Write a paired row with a fresh identity, the way `pair` does; returns
    /// the identity's fingerprint.
    async fn write_pairing(pool: &PgPool, crypto: &CryptoService, workspace_id: &str) -> String {
        let identity = BitwardenIdentityProvider::generate();
        let cd = BitwardenConnectionData {
            fingerprint: Some(hex::encode([7u8; 32])),
            key_data: Some(identity.to_cose()),
            transport_state: None,
        };
        let encrypted = encrypt_connection_data(crypto, &cd).await.expect("encrypt");
        db::upsert_vault_connection(pool, workspace_id, PROVIDER, "paired", Some(&encrypted))
            .await
            .expect("upsert");
        hex::encode(identity.fingerprint().0)
    }

    async fn identity_served(p: &BitwardenVaultProvider, workspace_id: &str) -> Option<String> {
        p.load_session(workspace_id)
            .await
            .expect("load session")
            .map(|s| hex::encode(s.identity.fingerprint().0))
    }

    #[tokio::test]
    async fn a_re_pair_on_another_instance_replaces_the_cached_identity() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vbw1").await;
        let crypto = test_crypto();
        let b = provider(&pool, &crypto);

        let first = write_pairing(&pool, &crypto, &ws).await;
        assert_eq!(identity_served(&b, &ws).await, Some(first));

        let second = write_pairing(&pool, &crypto, &ws).await;
        assert_eq!(identity_served(&b, &ws).await, Some(second));
    }

    #[tokio::test]
    async fn a_disconnect_on_another_instance_drops_the_cached_session() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vbw2").await;
        let crypto = test_crypto();
        let a = Arc::new(provider(&pool, &crypto));
        let b = provider(&pool, &crypto);
        let service_a =
            VaultService::new(vec![Arc::clone(&a) as Arc<dyn VaultProvider>], pool.clone());

        write_pairing(&pool, &crypto, &ws).await;
        assert!(identity_served(&b, &ws).await.is_some());

        service_a
            .disconnect(&ws, PROVIDER)
            .await
            .expect("disconnect");

        assert_eq!(identity_served(&b, &ws).await, None);
        assert!(!b.sessions.contains_key(&ws));
        assert!(b.request_credential(&ws, "example.com").await.is_none());
    }

    #[tokio::test]
    async fn the_sessions_own_write_through_does_not_invalidate_it() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vbw3").await;
        let crypto = test_crypto();
        let b = provider(&pool, &crypto);

        write_pairing(&pool, &crypto, &ws).await;
        let session = b.load_session(&ws).await.expect("load").expect("session");

        // The relay client persists transport state through the session's
        // store mid-pairing and on reconnect. That write moves the row's
        // generation; the session must move with it.
        let mut store = BitwardenConnectionStore::new(
            pool.clone(),
            ws.clone(),
            Some(session.identity.to_cose()),
            Arc::clone(&crypto),
            session.connection_data.as_ref(),
            Arc::clone(&session.generation),
        );
        store
            .save(ConnectionInfo {
                fingerprint: IdentityFingerprint([7u8; 32]),
                name: None,
                cached_at: 0,
                last_connected_at: 0,
                transport_state: None,
            })
            .await
            .expect("save");

        let again = b.load_session(&ws).await.expect("load").expect("session");
        assert!(
            Arc::ptr_eq(&session, &again),
            "a session must not read its own write-through as a re-pair"
        );

        // A write from ANOTHER instance still supersedes it.
        write_pairing(&pool, &crypto, &ws).await;
        let after = b.load_session(&ws).await.expect("load").expect("session");
        assert!(!Arc::ptr_eq(&session, &after));
    }

    #[tokio::test]
    async fn a_database_error_fails_closed_and_keeps_the_session() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vbw4").await;
        let crypto = test_crypto();
        write_pairing(&pool, &crypto, &ws).await;

        let url = std::env::var("GATEWAY_TEST_DATABASE_URL").expect("url");
        let b_pool = db::create_pool(&url).await.expect("pool");
        let b = provider(&b_pool, &crypto);
        assert!(identity_served(&b, &ws).await.is_some());

        b_pool.close().await;
        assert!(b.load_session(&ws).await.is_err());
        assert!(b.request_credential(&ws, "example.com").await.is_none());
        assert!(
            b.sessions.contains_key(&ws),
            "a database blip must not tear the session down"
        );
    }
}
