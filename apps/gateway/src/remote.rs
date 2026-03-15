//! Remote Access Manager — lifecycle, event loop, and credential requests.
//!
//! Wraps `RemoteClient` from `bw-rat-client` to provide a high-level interface
//! for the gateway to fetch credentials from a paired Bitwarden vault.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bw_proxy_client::ProxyClientConfig;
use bw_rat_client::{
    CredentialData, DefaultProxyClient, IdentityFingerprint, IdentityProvider, Psk, RemoteClient,
    RemoteClientEvent, RemoteClientResponse, SessionStore,
};
use dashmap::DashMap;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use crate::remote_store::{FileIdentityProvider, FileSessionStore};

/// How long to cache successful credential lookups.
const CREDENTIAL_CACHE_TTL: Duration = Duration::from_secs(60);
/// How long to cache negative (no credential found) results.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(30);
/// Timeout for individual credential requests.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

// ── Cached credential ───────────────────────────────────────────────────

struct CachedCredential {
    data: Option<CredentialData>,
    expires_at: Instant,
}

// ── Config ──────────────────────────────────────────────────────────────

pub(crate) struct RemoteAccessConfig {
    pub relay_url: String,
}

// ── RemoteAccessManager ─────────────────────────────────────────────────

pub(crate) struct RemoteAccessManager {
    client: Arc<Mutex<Option<RemoteClient>>>,
    config: RemoteAccessConfig,
    data_dir: PathBuf,
    identity_provider: Arc<FileIdentityProvider>,
    session_store: Arc<Mutex<FileSessionStore>>,
    credential_cache: DashMap<String, CachedCredential>,
    /// Channel to send responses (fingerprint verification) to the client.
    response_tx: Arc<Mutex<Option<mpsc::Sender<RemoteClientResponse>>>>,
}

impl RemoteAccessManager {
    /// Create a new manager. Does not connect — call `try_restore_session()` after.
    pub fn new(config: RemoteAccessConfig, data_dir: &Path) -> anyhow::Result<Self> {
        let identity_provider = FileIdentityProvider::load_or_generate(data_dir)?;
        let session_store = FileSessionStore::new(data_dir)?;

        Ok(Self {
            client: Arc::new(Mutex::new(None)),
            config,
            data_dir: data_dir.to_path_buf(),
            identity_provider: Arc::new(identity_provider),
            session_store: Arc::new(Mutex::new(session_store)),
            credential_cache: DashMap::new(),
            response_tx: Arc::new(Mutex::new(None)),
        })
    }

    /// Attempt to restore a previously cached session on startup.
    pub async fn try_restore_session(&self) {
        let fingerprint = {
            let store = self.session_store.lock().await;
            store.first_session_fingerprint()
        };

        let Some(fingerprint) = fingerprint else {
            info!("no cached remote access session to restore");
            return;
        };

        info!(
            fingerprint = %hex::encode(fingerprint.0),
            "attempting to restore remote access session"
        );

        match self.create_and_connect_client().await {
            Ok(mut client) => match client.load_cached_session(fingerprint).await {
                Ok(()) => {
                    info!("remote access session restored");
                    *self.client.lock().await = Some(client);
                }
                Err(e) => {
                    warn!(error = %e, "failed to restore remote access session");
                    let _ = client.close().await;
                }
            },
            Err(e) => {
                warn!(error = %e, "failed to create remote client for session restore");
            }
        }
    }

    /// Pair with a remote device using a pre-shared key.
    pub async fn pair_with_psk(
        &self,
        psk: Psk,
        remote_fingerprint: IdentityFingerprint,
    ) -> Result<(), anyhow::Error> {
        let mut client = self.create_and_connect_client().await?;

        client
            .pair_with_psk(psk, remote_fingerprint)
            .await
            .map_err(|e| anyhow::anyhow!("PSK pairing failed: {e}"))?;

        info!(
            fingerprint = %hex::encode(remote_fingerprint.0),
            "remote access paired via PSK"
        );

        *self.client.lock().await = Some(client);
        Ok(())
    }

    /// Pair with a remote device using a rendezvous code.
    pub async fn pair_with_rendezvous(
        &self,
        code: &str,
    ) -> Result<IdentityFingerprint, anyhow::Error> {
        let mut client = self.create_and_connect_client().await?;

        let fingerprint = client
            .pair_with_handshake(code, false)
            .await
            .map_err(|e| anyhow::anyhow!("rendezvous pairing failed: {e}"))?;

        info!(
            fingerprint = %hex::encode(fingerprint.0),
            "remote access paired via rendezvous"
        );

        *self.client.lock().await = Some(client);
        Ok(fingerprint)
    }

    /// Request a credential for a hostname from the paired device.
    /// Returns `None` if not paired, not ready, or no credential available.
    pub async fn request_credential(&self, hostname: &str) -> Option<CredentialData> {
        // Check cache first
        if let Some(cached) = self.credential_cache.get(hostname) {
            if cached.expires_at > Instant::now() {
                return cached.data.clone();
            }
        }
        self.credential_cache.remove(hostname);

        let mut client_guard = self.client.lock().await;
        let client = client_guard.as_mut()?;

        if !client.is_ready() {
            return None;
        }

        let result =
            tokio::time::timeout(REQUEST_TIMEOUT, client.request_credential(hostname)).await;

        let cred = match result {
            Ok(Ok(cred)) => Some(cred),
            Ok(Err(e)) => {
                warn!(hostname = %hostname, error = %e, "remote credential request failed");
                None
            }
            Err(_) => {
                warn!(hostname = %hostname, "remote credential request timed out");
                None
            }
        };

        let (data, ttl) = match &cred {
            Some(c) => (Some(c.clone()), CREDENTIAL_CACHE_TTL),
            None => (None, NEGATIVE_CACHE_TTL),
        };

        self.credential_cache.insert(
            hostname.to_string(),
            CachedCredential {
                data,
                expires_at: Instant::now() + ttl,
            },
        );

        cred
    }

    /// Get the status of the remote access connection.
    pub async fn status(&self) -> RemoteAccessStatus {
        let guard = self.client.lock().await;
        let paired = guard.is_some();
        let ready = guard.as_ref().is_some_and(|c| c.is_ready());
        let fingerprint = hex::encode(self.identity_provider.fingerprint().0);

        let remote_fingerprint = {
            let store = self.session_store.lock().await;
            store
                .first_session_fingerprint()
                .map(|fp| hex::encode(fp.0))
        };

        RemoteAccessStatus {
            paired,
            ready,
            fingerprint,
            remote_fingerprint,
            relay_url: self.config.relay_url.clone(),
        }
    }

    /// Disconnect and clear the session.
    pub async fn disconnect(&self) -> Result<(), anyhow::Error> {
        let mut guard = self.client.lock().await;
        if let Some(mut client) = guard.take() {
            client.close().await;
        }

        let mut store = self.session_store.lock().await;
        store
            .clear()
            .map_err(|e| anyhow::anyhow!("failed to clear sessions: {e}"))?;

        self.credential_cache.clear();

        info!("remote access disconnected and session cleared");
        Ok(())
    }

    // ── Internal ────────────────────────────────────────────────────────

    async fn create_and_connect_client(&self) -> Result<RemoteClient, anyhow::Error> {
        let (event_tx, event_rx) = mpsc::channel(64);
        let (response_tx, response_rx) = mpsc::channel(16);

        *self.response_tx.lock().await = Some(response_tx);

        // Spawn event loop to log events
        Self::spawn_event_loop(event_rx);

        let identity = self.identity_provider.as_ref();
        let proxy_config = ProxyClientConfig {
            proxy_url: self.config.relay_url.clone(),
            identity_keypair: Some(identity.identity().clone()),
        };
        let proxy_client = DefaultProxyClient::new(proxy_config);

        info!(data_dir = %self.data_dir.display(), "creating session store for RemoteClient");
        let session_store = FileSessionStore::new(&self.data_dir)?;

        let identity_provider = FileIdentityProvider::clone_from_existing(&self.identity_provider);

        let client = RemoteClient::new(
            Box::new(identity_provider),
            Box::new(session_store),
            event_tx,
            response_rx,
            Box::new(proxy_client),
        )
        .await
        .map_err(|e| anyhow::anyhow!("failed to create remote client: {e}"))?;

        Ok(client)
    }

    fn spawn_event_loop(mut event_rx: mpsc::Receiver<RemoteClientEvent>) {
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                match &event {
                    RemoteClientEvent::Connecting { proxy_url } => {
                        info!(url = %proxy_url, "remote access: connecting to relay");
                    }
                    RemoteClientEvent::Connected { fingerprint } => {
                        info!(fingerprint = %hex::encode(fingerprint.0), "remote access: connected");
                    }
                    RemoteClientEvent::Ready {
                        can_request_credentials,
                    } => {
                        info!(
                            can_request = can_request_credentials,
                            "remote access: ready"
                        );
                    }
                    RemoteClientEvent::CredentialReceived { domain, .. } => {
                        info!(domain = %domain, "remote access: credential received");
                    }
                    RemoteClientEvent::Error { message, context } => {
                        warn!(
                            message = %message,
                            context = ?context,
                            "remote access: error"
                        );
                    }
                    RemoteClientEvent::Disconnected { reason } => {
                        warn!(reason = ?reason, "remote access: disconnected");
                    }
                    _ => {
                        info!(event = ?event, "remote access: event");
                    }
                }
            }
        });
    }
}

// ── Status type ─────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub(crate) struct RemoteAccessStatus {
    pub paired: bool,
    pub ready: bool,
    pub fingerprint: String,
    pub remote_fingerprint: Option<String>,
    pub relay_url: String,
}
