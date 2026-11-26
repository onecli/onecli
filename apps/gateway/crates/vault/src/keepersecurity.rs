//! Keeper Security (`keepersecurity`) vault provider.
//!
//! Owns the workspace's connection (the encrypted KSM config in
//! `vault_connections`) and its in-memory session. Keeper is a *value source*
//! for explicit secrets (`value_source = "keepersecurity"` with a `keeper://`
//! reference), resolved at request time; it is not a hostname-matched fallback
//! The SDK work (validate, resolve, browse records) is
//! delegated to the Node API via [`super::keepersecurity_api`].
//!
//! A cached session is re-checked against its row on every use, so a
//! disconnect or re-pair made through any gateway instance takes effect
//! everywhere on the next request.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use dashmap::DashMap;
use db::VaultGeneration;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tracing::{info, warn};

use super::keepersecurity_api::{self, KeeperSecurityError, KeeperSecurityHealth};
use super::{
    check_session, PairResult, ProviderStatus, SessionCheck, VaultCredential, VaultError,
    VaultProvider,
};
use crypto::CryptoService;

const PROVIDER: &str = "keepersecurity";
const RESOLVE_CACHE_TTL: Duration = Duration::from_secs(60);
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(30);
const ERROR_COOLDOWN: Duration = Duration::from_secs(60);
/// How long a successful `status` connectivity check is trusted before re-checking.
const STATUS_OK_TTL: Duration = Duration::from_secs(30);
/// `status_data.reason` when OneCLI can't use the connection at all, whatever
/// the cause (see [`KeeperSecuritySession::status_data`]).
const REASON_CONNECTION_FAILED: &str = "connection_failed";
const EVICTION_INTERVAL: Duration = Duration::from_secs(300);
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(1800);

// ── Config & session types ──────────────────────────────────────────────

/// Persisted in `vault_connection.connection_data`.
///
/// Deliberately no `Debug`/`Clone`: the struct carries only a credential (the
/// encrypted KSM config), so it must not be `{:?}`-logged or cloned around.
#[derive(Serialize, Deserialize)]
pub struct KeeperSecurityConfig {
    pub encrypted_ksm_config: String,
}

/// How a pasted KSM config is encoded, as the user chose it in the connect
/// form (`ksm_config_format`). Never inferred from the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigFormat {
    Json,
    Base64,
}

impl ConfigFormat {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "json" => Some(Self::Json),
            "base64" => Some(Self::Base64),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Base64 => "base64",
        }
    }
}

/// What a `pair` request carries: a ready KSM config in the format the user
/// chose, or a single-use one-time token (e.g. `US:xxxx`) that must be bound
/// to a config first.
// Holds the raw pasted credential: `Debug` only in tests (for `assert_eq!`),
// so production code can never `{:?}`-log it.
#[cfg_attr(test, derive(Debug))]
#[derive(PartialEq, Eq)]
enum PairInput<'a> {
    Config(&'a str, ConfigFormat),
    OneTimeToken(&'a str),
}

/// Pick the credential out of a `pair` body. A config wins over a token when both
/// are sent (the token would otherwise be spent for nothing). Blank or non-string
/// values count as absent, so a form submitted empty fails here with a clear
/// message instead of reaching the Keeper SDK. A config must say how it is
/// encoded (`ksm_config_format`): nothing downstream guesses.
fn parse_pair_input(params: &serde_json::Value) -> Result<PairInput<'_>> {
    let field = |name: &str| {
        params
            .get(name)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    if let Some(config) = field("ksm_config") {
        let format = field("ksm_config_format")
            .and_then(ConfigFormat::parse)
            .ok_or_else(|| {
                anyhow!("missing or unknown ksm_config_format (expected json or base64)")
            })?;
        Ok(PairInput::Config(config, format))
    } else if let Some(token) = field("one_time_token") {
        Ok(PairInput::OneTimeToken(token))
    } else {
        Err(anyhow!("missing ksm_config or one_time_token"))
    }
}

/// A cached `keeper://` resolution. `value: None` is a negative cache entry (the
/// reference resolved to nothing / failed) held for a shorter TTL.
struct CachedRef {
    value: Option<String>,
    expires_at: Instant,
}

struct KeeperSecuritySession {
    decrypted_config: String,
    /// The row generation this session was loaded at: the session is valid
    /// only while the row still carries it.
    generation: VaultGeneration,
    ref_cache: DashMap<String, CachedRef>,
    last_used: Mutex<Instant>,
    last_error: Mutex<Option<String>>,
    error_until: Mutex<Option<Instant>>,
    last_ok: Mutex<Option<Instant>>,
    /// Keeper refused the application (`access_denied`) on the last call that
    /// reached it. Set by any call (status, resolve, picker), cleared by the
    /// next one Keeper accepts.
    access_denied: Mutex<bool>,
    /// What the last successful connectivity check reported (records shared,
    /// access expiry, warnings).
    health: Mutex<Option<KeeperSecurityHealth>>,
    /// The last reference an agent request could not resolve, so a single
    /// broken secret shows on the dashboard rather than only in the log.
    /// Cleared when that same reference next resolves.
    resolve_error: Mutex<Option<ResolveError>>,
}

/// A reference that failed to resolve, and why. Never holds a value.
#[derive(Clone, Serialize)]
struct ResolveError {
    #[serde(rename = "ref")]
    reference: String,
    message: String,
}

impl KeeperSecuritySession {
    fn new(decrypted_config: String, generation: VaultGeneration) -> Self {
        Self {
            decrypted_config,
            generation,
            ref_cache: DashMap::new(),
            last_used: Mutex::new(Instant::now()),
            last_error: Mutex::new(None),
            error_until: Mutex::new(None),
            last_ok: Mutex::new(None),
            access_denied: Mutex::new(false),
            health: Mutex::new(None),
            resolve_error: Mutex::new(None),
        }
    }

    /// Whether the session is still within its post-error cooldown window (set
    /// when a `Transient` or `AccessDenied` Keeper failure was last seen).
    fn in_error_cooldown(&self) -> bool {
        self.error_until
            .lock()
            .expect("session lock poisoned")
            .is_some_and(|t| Instant::now() < t)
    }

    fn is_access_denied(&self) -> bool {
        *self.access_denied.lock().expect("session lock poisoned")
    }

    /// Keeper refused the application: report it, back off so agent traffic
    /// does not hammer Keeper with calls it will refuse, and stop serving
    /// values resolved before the revocation (and a stale "connected").
    fn mark_access_denied(&self, msg: &str) {
        *self.access_denied.lock().expect("session lock poisoned") = true;
        *self.last_error.lock().expect("session lock poisoned") = Some(msg.to_string());
        *self.error_until.lock().expect("session lock poisoned") =
            Some(Instant::now() + ERROR_COOLDOWN);
        *self.last_ok.lock().expect("session lock poisoned") = None;
        self.ref_cache.clear();
    }

    fn mark_reachable(&self) {
        *self.access_denied.lock().expect("session lock poisoned") = false;
        *self.last_error.lock().expect("session lock poisoned") = None;
    }

    /// Record a failure from any call, by kind. Reference-level failures
    /// (`NotFound`/`BadRequest`) say nothing about the connection as a whole,
    /// so only the resolve path records those, against the reference.
    fn note_connection_failure(&self, err: &KeeperSecurityError) {
        match err {
            KeeperSecurityError::AccessDenied(msg) => self.mark_access_denied(msg),
            KeeperSecurityError::Transient(msg) => {
                *self.last_error.lock().expect("session lock poisoned") = Some(msg.clone());
                *self.error_until.lock().expect("session lock poisoned") =
                    Some(Instant::now() + ERROR_COOLDOWN);
            }
            KeeperSecurityError::NotFound(_) | KeeperSecurityError::BadRequest(_) => {}
        }
    }

    /// `status_data` for a paired session: the error, why the connection
    /// can't serve credentials (`reason`), and what Keeper reported.
    ///
    /// `reason` is deliberately coarse. OneCLI cannot always tell why it can't
    /// talk to Keeper (access expired or revoked, device removed, Keeper or
    /// the internal API unreachable, a throttle), and the fix is the same
    /// either way, so every failed connectivity check reads
    /// `connection_failed`, with the detail in `last_error`.
    fn status_data(&self, connected: bool) -> serde_json::Value {
        let health = self
            .health
            .lock()
            .expect("session lock poisoned")
            .clone()
            .unwrap_or_default();
        let last_error = self
            .last_error
            .lock()
            .expect("session lock poisoned")
            .clone();
        let reason = if self.is_access_denied() || (!connected && last_error.is_some()) {
            Some(REASON_CONNECTION_FAILED)
        } else if connected && health.record_count == Some(0) {
            Some("no_records")
        } else {
            None
        };
        serde_json::json!({
            "last_error": last_error,
            "reason": reason,
            "record_count": health.record_count,
            "expires_on": health.expires_on,
            "warnings": health.warnings,
            "resolve_error": *self.resolve_error.lock().expect("session lock poisoned"),
        })
    }
}

pub struct KeeperSecurityVaultProvider {
    pool: PgPool,
    crypto: Arc<CryptoService>,
    sessions: Arc<DashMap<String, Arc<KeeperSecuritySession>>>,
}

// ── Constructor with idle-session eviction ──────────────────────────────

impl KeeperSecurityVaultProvider {
    pub fn new(pool: PgPool, crypto: Arc<CryptoService>) -> Self {
        let sessions: Arc<DashMap<String, Arc<KeeperSecuritySession>>> = Arc::new(DashMap::new());

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
                        info!(workspace_id = %key, "evicted idle keepersecurity session");
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

    /// Load the workspace's session, or `None` if it is not paired.
    ///
    /// A cached session is served only after its row confirms it: gone means
    /// disconnected (drop it, return `None`), a new generation means re-paired
    /// (drop it and load the new token). A database error fails the call and
    /// keeps the session — a credential is never served unverified.
    /// Decrypts the KSM config into memory (held for resolution).
    async fn load_session(
        &self,
        workspace_id: &str,
    ) -> Result<Option<Arc<KeeperSecuritySession>>, VaultError> {
        // Clone out of the map so no shard lock is held across the await.
        let cached = self
            .sessions
            .get(workspace_id)
            .map(|entry| Arc::clone(entry.value()));
        if let Some(session) = cached {
            let check = check_session(&self.pool, workspace_id, PROVIDER, Some(session.generation))
                .await
                .map_err(|e| {
                    warn!(workspace_id, error = %e, "keepersecurity: session check failed");
                    VaultError::Internal("failed to verify vault connection".into())
                })?;
            match check {
                SessionCheck::Current => {
                    *session.last_used.lock().expect("session lock poisoned") = Instant::now();
                    return Ok(Some(session));
                }
                SessionCheck::Gone => {
                    self.evict(workspace_id, &session);
                    info!(
                        workspace_id,
                        "keepersecurity: connection removed; session dropped"
                    );
                    return Ok(None);
                }
                SessionCheck::Superseded => {
                    self.evict(workspace_id, &session);
                    info!(
                        workspace_id,
                        "keepersecurity: connection re-paired; reloading session"
                    );
                }
            }
        }

        let row = match db::find_vault_connection(&self.pool, workspace_id, PROVIDER).await {
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
        let config: KeeperSecurityConfig = serde_json::from_value(connection_data)
            .map_err(|e| VaultError::Internal(format!("malformed connection_data: {e}")))?;

        let ksm_config = self
            .crypto
            .decrypt(&config.encrypted_ksm_config)
            .await
            .map_err(|e| {
                warn!(workspace_id, "failed to decrypt KSM config: {e}");
                VaultError::Internal("token decryption failed; re-pair to fix".into())
            })?;

        let session = Arc::new(KeeperSecuritySession::new(ksm_config, row.generation));
        self.sessions
            .insert(workspace_id.to_string(), Arc::clone(&session));
        Ok(Some(session))
    }

    /// Drop `session` from the map — only if it is still the one there, so a
    /// concurrent reload's fresh session is never removed in its place — and
    /// release its resolved values.
    fn evict(&self, workspace_id: &str, session: &Arc<KeeperSecuritySession>) {
        self.sessions
            .remove_if(workspace_id, |_, current| Arc::ptr_eq(current, session));
        session.ref_cache.clear();
    }

    // ── Value-source resolution (the secret-injection path) ──────────────

    /// Resolve a `keeper://<record-uid>/field/<name>` reference to its secret
    /// value through the workspace's Keeper connection (one per workspace).
    /// Results are cached by reference, and errors are classified so the
    /// caller can skip the secret the same way it skips one whose stored value
    /// fails to decrypt.
    pub async fn resolve_ref(
        &self,
        workspace_id: &str,
        keepersecurity_ref: &str,
    ) -> Result<String, VaultError> {
        let session = self
            .load_session(workspace_id)
            .await?
            .ok_or_else(|| VaultError::NotFound("keepersecurity is not connected".into()))?;

        if let Some(cached) = session.ref_cache.get(keepersecurity_ref) {
            if cached.expires_at > Instant::now() {
                return cached.value.clone().ok_or_else(|| {
                    VaultError::BadRequest(format!("cannot resolve {keepersecurity_ref}"))
                });
            }
            drop(cached);
            session.ref_cache.remove(keepersecurity_ref);
        }

        if session.in_error_cooldown() {
            if session.is_access_denied() {
                return Err(VaultError::Forbidden(
                    "keepersecurity refused the Secrets Manager application (cooldown)".into(),
                ));
            }
            return Err(VaultError::Internal(
                "keepersecurity temporarily unavailable (cooldown)".into(),
            ));
        }

        match keepersecurity_api::resolve(&session.decrypted_config, keepersecurity_ref).await {
            Ok(value) if !value.is_empty() => {
                session.mark_reachable();
                {
                    let mut failed = session.resolve_error.lock().expect("session lock poisoned");
                    if failed
                        .as_ref()
                        .is_some_and(|f| f.reference == keepersecurity_ref)
                    {
                        *failed = None;
                    }
                }
                session.ref_cache.insert(
                    keepersecurity_ref.to_string(),
                    CachedRef {
                        value: Some(value.clone()),
                        expires_at: Instant::now() + RESOLVE_CACHE_TTL,
                    },
                );
                Ok(value)
            }
            Ok(_) => {
                let msg = format!("{keepersecurity_ref} resolved to an empty value");
                self.cache_negative(&session, keepersecurity_ref);
                record_resolve_error(&session, keepersecurity_ref, &msg);
                Err(VaultError::BadRequest(msg))
            }
            Err(KeeperSecurityError::NotFound(msg)) | Err(KeeperSecurityError::BadRequest(msg)) => {
                self.cache_negative(&session, keepersecurity_ref);
                record_resolve_error(&session, keepersecurity_ref, &msg);
                Err(VaultError::BadRequest(msg))
            }
            Err(e @ KeeperSecurityError::AccessDenied(_)) => {
                session.note_connection_failure(&e);
                Err(VaultError::Forbidden(e.to_string()))
            }
            Err(e @ KeeperSecurityError::Transient(_)) => {
                session.note_connection_failure(&e);
                Err(VaultError::Internal(e.to_string()))
            }
        }
    }

    fn cache_negative(&self, session: &KeeperSecuritySession, keepersecurity_ref: &str) {
        session.ref_cache.insert(
            keepersecurity_ref.to_string(),
            CachedRef {
                value: None,
                expires_at: Instant::now() + NEGATIVE_CACHE_TTL,
            },
        );
    }

    // ── Picker passthroughs (browse records → fields) ────────────────────
    // The browser never sees the KSM config or field values — it gets only the
    // titles/labels/refs the Node service returns.

    pub async fn list_records(&self, workspace_id: &str) -> Result<serde_json::Value, VaultError> {
        let session = self.picker_session(workspace_id).await?;
        let result = keepersecurity_api::list_records(&session.decrypted_config).await;
        picker_outcome(&session, result)
    }

    pub async fn list_fields(
        &self,
        workspace_id: &str,
        record_uid: &str,
    ) -> Result<serde_json::Value, VaultError> {
        let session = self.picker_session(workspace_id).await?;
        let result = keepersecurity_api::list_fields(&session.decrypted_config, record_uid).await;
        picker_outcome(&session, result)
    }

    async fn picker_session(
        &self,
        workspace_id: &str,
    ) -> Result<Arc<KeeperSecuritySession>, VaultError> {
        self.load_session(workspace_id)
            .await?
            .ok_or_else(|| VaultError::NotFound("keepersecurity is not connected".into()))
    }
}

// ── VaultProvider implementation ─────────────────────────────────────────

#[async_trait]
impl VaultProvider for KeeperSecurityVaultProvider {
    fn provider_name(&self) -> &'static str {
        PROVIDER
    }

    async fn pair(&self, workspace_id: &str, params: &serde_json::Value) -> Result<PairResult> {
        // Only the config is ever stored, always as the JSON the internal API
        // works with: a one-time token is single-use, so it is bound to a
        // config (JSON) first and then discarded; a pasted config is decoded
        // in the format the user chose. Either way it is validated with Keeper
        // before it is persisted.
        let ksm_config: String = match parse_pair_input(params)? {
            PairInput::Config(cfg, format) => {
                keepersecurity_api::validate_pasted(cfg, format.as_str())
                    .await
                    .map_err(|e| anyhow!("config validation failed: {e}"))?
            }
            PairInput::OneTimeToken(token) => {
                let bound = keepersecurity_api::bind(token)
                    .await
                    .map_err(|e| anyhow!("one-time token binding failed: {e}"))?;
                keepersecurity_api::validate(&bound)
                    .await
                    .map_err(|e| anyhow!("config validation failed: {e}"))?;
                bound
            }
        };

        let encrypted = self
            .crypto
            .encrypt(&ksm_config)
            .await
            .map_err(|e| anyhow!("encryption failed: {e}"))?;

        let config = KeeperSecurityConfig {
            encrypted_ksm_config: encrypted,
        };
        let cd = serde_json::to_value(&config)?;
        db::upsert_vault_connection(&self.pool, workspace_id, PROVIDER, "paired", Some(&cd))
            .await?;

        // Drop this instance's copy now; every other instance retires its own
        // on its next use, when the row's new generation no longer matches.
        if let Some((_, old)) = self.sessions.remove(workspace_id) {
            old.ref_cache.clear();
        }
        Ok(PairResult {
            display_name: Some("Keeper Secrets Manager".into()),
        })
    }

    /// Keeper is a value-source for explicit secrets (resolved via the
    /// PolicyEngine secret-injection path), not a hostname-matched vault racer,
    /// so it never participates in the Bitwarden-style credential race.
    async fn request_credential(
        &self,
        _workspace_id: &str,
        _hostname: &str,
    ) -> Option<VaultCredential> {
        None
    }

    async fn status(&self, workspace_id: &str) -> ProviderStatus {
        let session = match self.load_session(workspace_id).await {
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
                    // The stored connection can't be loaded (e.g. it no longer
                    // decrypts): as unusable as an unreachable Keeper.
                    status_data: Some(serde_json::json!({
                        "last_error": e.to_string(),
                        "reason": REASON_CONNECTION_FAILED,
                    })),
                };
            }
        };

        let connected = live_check(&session).await;

        ProviderStatus {
            connected,
            name: None,
            status_data: Some(session.status_data(connected)),
        }
    }

    async fn disconnect(&self, workspace_id: &str) -> Result<()> {
        if let Some((_, session)) = self.sessions.remove(workspace_id) {
            session.ref_cache.clear();
        }
        Ok(())
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Live connectivity check for `status`, gated by the error cooldown and a
/// short positive TTL so dashboard polling doesn't hammer Keeper.
async fn live_check(session: &KeeperSecuritySession) -> bool {
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
    match keepersecurity_api::validate(&session.decrypted_config).await {
        Ok(health) => {
            session.mark_reachable();
            *session.health.lock().expect("session lock poisoned") = Some(health);
            *session.last_ok.lock().expect("session lock poisoned") = Some(Instant::now());
            true
        }
        Err(e) => {
            // The check reads no reference, so a `NotFound`/`BadRequest` here
            // (e.g. a config Keeper rejects) is a connection failure like any
            // other: recorded through the same bookkeeping as the resolve and
            // picker paths, so all three back off alike.
            let e = match e {
                KeeperSecurityError::NotFound(m) | KeeperSecurityError::BadRequest(m) => {
                    KeeperSecurityError::Transient(m)
                }
                other => other,
            };
            session.note_connection_failure(&e);
            false
        }
    }
}

/// Remember the reference an agent request could not resolve (never a value).
fn record_resolve_error(session: &KeeperSecuritySession, reference: &str, message: &str) {
    *session.resolve_error.lock().expect("session lock poisoned") = Some(ResolveError {
        reference: reference.to_string(),
        message: message.to_string(),
    });
}

/// A picker call's result, with connection-level failures recorded on the
/// session so the dashboard reflects them too.
fn picker_outcome(
    session: &KeeperSecuritySession,
    result: Result<serde_json::Value, KeeperSecurityError>,
) -> Result<serde_json::Value, VaultError> {
    match result {
        Ok(v) => {
            session.mark_reachable();
            Ok(v)
        }
        Err(e) => {
            session.note_connection_failure(&e);
            Err(keepersecurity_err_to_vault(e))
        }
    }
}

fn keepersecurity_err_to_vault(e: KeeperSecurityError) -> VaultError {
    match e {
        KeeperSecurityError::NotFound(m) => VaultError::NotFound(m),
        KeeperSecurityError::BadRequest(m) => VaultError::BadRequest(m),
        KeeperSecurityError::AccessDenied(m) => VaultError::Forbidden(m),
        KeeperSecurityError::Transient(m) => VaultError::Internal(m),
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── pair input ──────────────────────────────────────────────────────

    #[test]
    fn pair_accepts_a_config_in_the_format_chosen() {
        let body = json!({ "ksm_config": "e30=", "ksm_config_format": "base64" });
        assert_eq!(
            parse_pair_input(&body).unwrap(),
            PairInput::Config("e30=", ConfigFormat::Base64)
        );
        let body = json!({ "ksm_config": "{}", "ksm_config_format": "json" });
        assert_eq!(
            parse_pair_input(&body).unwrap(),
            PairInput::Config("{}", ConfigFormat::Json)
        );
    }

    // The format is never guessed from the config text.
    #[test]
    fn pair_rejects_a_config_without_a_known_format() {
        for body in [
            json!({ "ksm_config": "e30=" }),
            json!({ "ksm_config": "e30=", "ksm_config_format": "" }),
            json!({ "ksm_config": "e30=", "ksm_config_format": "yaml" }),
            json!({ "ksm_config": "e30=", "ksm_config_format": 1 }),
        ] {
            let err = parse_pair_input(&body).unwrap_err().to_string();
            assert!(err.contains("ksm_config_format"), "{body}: {err}");
        }
    }

    #[test]
    fn pair_accepts_a_one_time_token() {
        let body = json!({ "one_time_token": "US:abc_DEF-123" });
        assert_eq!(
            parse_pair_input(&body).unwrap(),
            PairInput::OneTimeToken("US:abc_DEF-123")
        );
    }

    #[test]
    fn pair_trims_surrounding_whitespace() {
        let body = json!({ "one_time_token": "  US:abc \n" });
        assert_eq!(
            parse_pair_input(&body).unwrap(),
            PairInput::OneTimeToken("US:abc")
        );
    }

    // A config wins: binding the token as well would spend a single-use token
    // for a connection that is already usable.
    #[test]
    fn pair_prefers_the_config_when_both_are_sent() {
        let body = json!({
            "ksm_config": "cfg",
            "ksm_config_format": "json",
            "one_time_token": "US:abc",
        });
        assert_eq!(
            parse_pair_input(&body).unwrap(),
            PairInput::Config("cfg", ConfigFormat::Json)
        );
    }

    #[test]
    fn pair_falls_back_to_the_token_when_the_config_is_blank() {
        let body = json!({ "ksm_config": "   ", "one_time_token": "US:abc" });
        assert_eq!(
            parse_pair_input(&body).unwrap(),
            PairInput::OneTimeToken("US:abc")
        );
    }

    #[test]
    fn pair_rejects_a_body_with_neither() {
        for body in [
            json!({}),
            json!({ "ksm_config": "" }),
            json!({ "one_time_token": "   " }),
            json!({ "ksm_config": 123 }),
            json!({ "one_time_token": null }),
            json!({ "service_account_token": "ops_1password_field" }),
            json!("just a string"),
            json!(null),
        ] {
            let err = parse_pair_input(&body).unwrap_err().to_string();
            assert_eq!(err, "missing ksm_config or one_time_token", "{body}");
        }
    }

    // The error must never echo what was sent: it may be a credential.
    #[test]
    fn pair_errors_do_not_echo_the_input() {
        let body = json!({ "ksm_config": 42, "secret": "hunter2" });
        let err = parse_pair_input(&body).unwrap_err().to_string();
        assert!(!err.contains("hunter2"));
    }

    #[test]
    fn config_round_trip() {
        let config = KeeperSecurityConfig {
            encrypted_ksm_config: "iv:tag:ct".into(),
        };
        let json = serde_json::to_value(&config).unwrap();
        let back: KeeperSecurityConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.encrypted_ksm_config, "iv:tag:ct");
    }

    #[test]
    fn config_ignores_legacy_mappings() {
        let json = serde_json::json!({
            "encrypted_ksm_config": "iv:tag:ct",
            "mappings": { "api.anthropic.com": "keeper://uid/field/password" },
        });
        let config: KeeperSecurityConfig = serde_json::from_value(json).unwrap();
        assert_eq!(config.encrypted_ksm_config, "iv:tag:ct");
    }

    // ── Connection health (what `status` reports) ───────────────────────

    fn session() -> KeeperSecuritySession {
        KeeperSecuritySession::new("cfg".into(), VaultGeneration(1))
    }

    fn healthy(records: u64) -> KeeperSecurityHealth {
        KeeperSecurityHealth {
            record_count: Some(records),
            ..Default::default()
        }
    }

    #[test]
    fn a_healthy_session_reports_no_reason() {
        let s = session();
        *s.health.lock().unwrap() = Some(healthy(3));
        let data = s.status_data(true);
        assert_eq!(data["reason"], serde_json::Value::Null);
        assert_eq!(data["last_error"], serde_json::Value::Null);
        assert_eq!(data["record_count"], 3);
    }

    // Keeper answers an application whose shares were all removed with
    // success and an empty list: "connected", but it can read nothing.
    #[test]
    fn zero_shared_records_reports_no_records() {
        let s = session();
        *s.health.lock().unwrap() = Some(healthy(0));
        assert_eq!(s.status_data(true)["reason"], "no_records");
    }

    #[test]
    fn an_unknown_record_count_is_not_no_records() {
        let s = session();
        *s.health.lock().unwrap() = Some(KeeperSecurityHealth::default());
        assert_eq!(s.status_data(true)["reason"], serde_json::Value::Null);
    }

    #[test]
    fn access_denied_reports_the_reason_and_drops_cached_values() {
        let s = session();
        *s.last_ok.lock().unwrap() = Some(Instant::now());
        s.ref_cache.insert(
            "keeper://uid/field/password".into(),
            CachedRef {
                value: Some("hunter2".into()),
                expires_at: Instant::now() + RESOLVE_CACHE_TTL,
            },
        );

        s.note_connection_failure(&KeeperSecurityError::AccessDenied("denied".into()));

        let data = s.status_data(false);
        assert_eq!(data["reason"], "connection_failed");
        assert_eq!(data["last_error"], "denied");
        assert!(s.in_error_cooldown());
        // No value resolved before the revocation is served after it, and the
        // positive status cache no longer vouches for the connection.
        assert!(s.ref_cache.is_empty());
        assert!(s.last_ok.lock().unwrap().is_none());
    }

    // Any failed connectivity check reads the same, whatever the cause: an
    // outage, a throttle, or the internal API being down.
    #[test]
    fn any_failed_check_reports_connection_failed() {
        let s = session();
        s.note_connection_failure(&KeeperSecurityError::Transient("timed out".into()));
        let data = s.status_data(false);
        assert_eq!(data["reason"], "connection_failed");
        assert_eq!(data["last_error"], "timed out");
    }

    // `note_connection_failure` is what `live_check` records every failure
    // through; a rejected config there arrives as `Transient`.
    #[test]
    fn a_connection_failure_backs_off_and_reports() {
        let s = session();
        s.note_connection_failure(&KeeperSecurityError::Transient("bad config".into()));
        assert!(s.in_error_cooldown());
        assert!(!s.is_access_denied());
        assert_eq!(s.status_data(false)["last_error"], "bad config");
    }

    #[test]
    fn a_call_keeper_accepts_clears_access_denied() {
        let s = session();
        s.mark_access_denied("denied");
        s.mark_reachable();
        let data = s.status_data(true);
        assert_eq!(data["reason"], serde_json::Value::Null);
        assert_eq!(data["last_error"], serde_json::Value::Null);
    }

    // One broken reference is not a broken connection: it is reported on its
    // own, and leaves the connection's error and cooldown alone.
    #[test]
    fn a_reference_failure_is_reported_without_failing_the_connection() {
        let s = session();
        s.note_connection_failure(&KeeperSecurityError::BadRequest("bad ref".into()));
        record_resolve_error(&s, "keeper://uid/field/x", "no such field");

        let data = s.status_data(true);
        assert_eq!(data["last_error"], serde_json::Value::Null);
        assert!(!s.in_error_cooldown());
        assert_eq!(
            data["resolve_error"],
            json!({ "ref": "keeper://uid/field/x", "message": "no such field" })
        );
    }

    #[test]
    fn a_picker_access_denied_is_recorded_and_returned_as_forbidden() {
        let s = session();
        let err = picker_outcome(&s, Err(KeeperSecurityError::AccessDenied("denied".into())))
            .unwrap_err();
        assert!(matches!(err, VaultError::Forbidden(m) if m == "denied"));
        assert!(s.is_access_denied());
    }

    // ── Cross-instance revocation, over a real Postgres ─────────────────
    //
    // Two providers over one database stand in for two gateway instances. The
    // pair/disconnect "through instance A" is the row write it performs, so
    // these drive the row directly (pairing itself dials the Keeper
    // service) and assert on what instance B serves.

    use crate::test_support::{seed_workspace, test_crypto, test_pool};
    use crate::VaultService;

    /// Write the connection row the way `pair` does, for `token`.
    async fn write_pairing(pool: &PgPool, crypto: &CryptoService, workspace_id: &str, token: &str) {
        let config = KeeperSecurityConfig {
            encrypted_ksm_config: crypto.encrypt(token).await.expect("encrypt"),
        };
        let cd = serde_json::to_value(&config).expect("serialize");
        db::upsert_vault_connection(pool, workspace_id, PROVIDER, "paired", Some(&cd))
            .await
            .expect("upsert");
    }

    async fn token_served(
        provider: &KeeperSecurityVaultProvider,
        workspace_id: &str,
    ) -> Option<String> {
        provider
            .load_session(workspace_id)
            .await
            .expect("load session")
            .map(|s| s.decrypted_config.clone())
    }

    #[tokio::test]
    async fn a_re_pair_on_another_instance_replaces_the_cached_token() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vkp1").await;
        let crypto = test_crypto();
        let b = KeeperSecurityVaultProvider::new(pool.clone(), Arc::clone(&crypto));

        write_pairing(&pool, &crypto, &ws, "token-one").await;
        assert_eq!(token_served(&b, &ws).await.as_deref(), Some("token-one"));

        // Re-paired through another instance: B's cached session is stale.
        write_pairing(&pool, &crypto, &ws, "token-two").await;
        assert_eq!(token_served(&b, &ws).await.as_deref(), Some("token-two"));
    }

    #[tokio::test]
    async fn a_disconnect_on_another_instance_drops_the_cached_session() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vkp2").await;
        let crypto = test_crypto();
        let a = Arc::new(KeeperSecurityVaultProvider::new(
            pool.clone(),
            Arc::clone(&crypto),
        ));
        let b = KeeperSecurityVaultProvider::new(pool.clone(), Arc::clone(&crypto));
        let service_a =
            VaultService::new(vec![Arc::clone(&a) as Arc<dyn VaultProvider>], pool.clone());

        write_pairing(&pool, &crypto, &ws, "token-one").await;
        assert_eq!(token_served(&b, &ws).await.as_deref(), Some("token-one"));

        service_a
            .disconnect(&ws, PROVIDER)
            .await
            .expect("disconnect");

        assert_eq!(token_served(&b, &ws).await, None);
        assert!(
            !b.sessions.contains_key(&ws),
            "the revoked token must not stay resident on B"
        );
        // And the resolve path refuses rather than reaching Keeper.
        assert!(matches!(
            b.resolve_ref(&ws, "keeper://v/i/f").await,
            Err(VaultError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn a_current_session_is_reused_not_reloaded() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vkp3").await;
        let crypto = test_crypto();
        let b = KeeperSecurityVaultProvider::new(pool.clone(), Arc::clone(&crypto));

        write_pairing(&pool, &crypto, &ws, "token-one").await;
        let first = b.load_session(&ws).await.expect("load").expect("session");
        let second = b.load_session(&ws).await.expect("load").expect("session");
        assert!(
            Arc::ptr_eq(&first, &second),
            "an unchanged row must keep its session"
        );
    }

    #[tokio::test]
    async fn a_disconnect_never_reaches_another_workspaces_session() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws_x = seed_workspace(&pool, "vkp5x").await;
        let ws_y = seed_workspace(&pool, "vkp5y").await;
        let crypto = test_crypto();
        let a = Arc::new(KeeperSecurityVaultProvider::new(
            pool.clone(),
            Arc::clone(&crypto),
        ));
        let b = KeeperSecurityVaultProvider::new(pool.clone(), Arc::clone(&crypto));
        let service_a =
            VaultService::new(vec![Arc::clone(&a) as Arc<dyn VaultProvider>], pool.clone());

        write_pairing(&pool, &crypto, &ws_x, "token-x").await;
        write_pairing(&pool, &crypto, &ws_y, "token-y").await;
        let y_before = b.load_session(&ws_y).await.expect("load").expect("session");
        assert_eq!(token_served(&b, &ws_x).await.as_deref(), Some("token-x"));

        // Workspace X disconnects; workspace Y's connection is untouched.
        service_a
            .disconnect(&ws_x, PROVIDER)
            .await
            .expect("disconnect");

        assert_eq!(token_served(&b, &ws_x).await, None);
        let y_after = b.load_session(&ws_y).await.expect("load").expect("session");
        assert_eq!(y_after.decrypted_config, "token-y");
        assert!(
            Arc::ptr_eq(&y_before, &y_after),
            "another workspace's session must not even be reloaded"
        );
    }

    #[tokio::test]
    async fn a_database_error_fails_closed_and_keeps_the_session() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let ws = seed_workspace(&pool, "vkp4").await;
        let crypto = test_crypto();
        write_pairing(&pool, &crypto, &ws, "token-one").await;

        // B on its own pool, so closing it simulates B losing the database.
        let url = std::env::var("GATEWAY_TEST_DATABASE_URL").expect("url");
        let b_pool = db::create_pool(&url).await.expect("pool");
        let b = KeeperSecurityVaultProvider::new(b_pool.clone(), Arc::clone(&crypto));
        assert_eq!(token_served(&b, &ws).await.as_deref(), Some("token-one"));

        b_pool.close().await;
        assert!(
            matches!(b.load_session(&ws).await, Err(VaultError::Internal(_))),
            "an unverifiable session must not be served"
        );
        assert!(
            b.sessions.contains_key(&ws),
            "a database blip must not tear the session down"
        );
    }
}
