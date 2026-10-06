//! Vault integration — provider-agnostic credential fetching from external vaults.
//!
//! The `VaultProvider` trait defines the interface for vault backends (Bitwarden, etc.).
//! `VaultService` is the orchestrator that routes requests to the correct provider.
//!
//! ## Sessions are a cache of the `vault_connections` row
//!
//! Providers hold a per-workspace session in memory (the decrypted 1Password
//! token, the live Bitwarden client). Several gateway instances run over one
//! database, and a pair or disconnect lands on only one of them — so the row,
//! not any instance's memory, is the truth. Every use of a cached session
//! first re-reads the row's [`db::VaultGeneration`] (`check_session`): a
//! deleted row means the connection was disconnected (drop the session, serve
//! nothing), a changed generation means it was re-paired (drop and reload).
//! The probe is one indexed point read; a session is never trusted on memory
//! alone.

pub mod bitwarden;
pub mod bitwarden_db;
pub mod onepassword;
pub mod onepassword_api;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use axum::response::{IntoResponse, Response};
use db::VaultGeneration;
use hyper::StatusCode;
use sqlx::PgPool;

// ── Types ───────────────────────────────────────────────────────────────

/// Provider-agnostic credential returned by any vault provider.
#[derive(Debug)]
pub struct VaultCredential {
    #[allow(dead_code)]
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Result of a successful pairing operation.
#[derive(Debug)]
pub struct PairResult {
    /// Human-readable name for the connection (shown in UI).
    pub display_name: Option<String>,
}

/// Connection status for a provider.
#[derive(Debug)]
pub struct ProviderStatus {
    pub connected: bool,
    pub name: Option<String>,
    /// Provider-specific status details (e.g. fingerprint for Bitwarden).
    /// Serialized as-is into the API response as `status_data`.
    pub status_data: Option<serde_json::Value>,
}

// ── Errors ──────────────────────────────────────────────────────────────

/// Error type for vault operations that maps cleanly to HTTP responses.
#[derive(Debug)]
pub enum VaultError {
    BadRequest(String),
    Forbidden(String),
    NotFound(String),
    Internal(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(m) | Self::Forbidden(m) | Self::NotFound(m) | Self::Internal(m) => {
                write!(f, "{m}")
            }
        }
    }
}

impl IntoResponse for VaultError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            VaultError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            VaultError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            VaultError::NotFound(m) => (StatusCode::NOT_FOUND, m),
            VaultError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, axum::Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

// ── Trait ────────────────────────────────────────────────────────────────

#[async_trait]
pub trait VaultProvider: Send + Sync {
    /// Provider identifier (e.g., "bitwarden").
    fn provider_name(&self) -> &'static str;

    /// Pair with the vault using provider-specific credentials.
    async fn pair(&self, workspace_id: &str, params: &serde_json::Value) -> Result<PairResult>;

    /// Request a credential for a hostname from this workspace's vault.
    async fn request_credential(
        &self,
        workspace_id: &str,
        hostname: &str,
    ) -> Option<VaultCredential>;

    /// Get connection status for this workspace.
    async fn status(&self, workspace_id: &str) -> ProviderStatus;

    /// Disconnect and clean up.
    async fn disconnect(&self, workspace_id: &str) -> Result<()>;
}

// ── Orchestrator ────────────────────────────────────────────────────────

/// Provider-agnostic vault service. Routes operations to the correct provider
/// by name, iterates all providers for credential lookups.
pub struct VaultService {
    providers: Vec<Arc<dyn VaultProvider>>,
    pool: PgPool,
}

impl VaultService {
    pub fn new(providers: Vec<Arc<dyn VaultProvider>>, pool: PgPool) -> Self {
        Self { providers, pool }
    }

    /// Try each provider in order until one returns a credential.
    pub async fn request_credential(
        &self,
        workspace_id: &str,
        hostname: &str,
    ) -> Option<VaultCredential> {
        for provider in &self.providers {
            if let Some(cred) = provider.request_credential(workspace_id, hostname).await {
                return Some(cred);
            }
        }
        None
    }

    /// Pair with a specific provider. The provider owns DB persistence.
    pub async fn pair(
        &self,
        workspace_id: &str,
        provider: &str,
        params: &serde_json::Value,
    ) -> Result<PairResult> {
        let p = self.find_provider(provider)?;
        p.pair(workspace_id, params).await
    }

    /// Get status for a specific provider.
    pub async fn status(&self, workspace_id: &str, provider: &str) -> Option<ProviderStatus> {
        let p = self.find_provider(provider).ok()?;
        Some(p.status(workspace_id).await)
    }

    /// Disconnect a specific provider.
    ///
    /// The row goes first: it is what every OTHER gateway instance checks its
    /// cached session against, so deleting it is the revocation. The local
    /// purge after it only frees this instance's copy sooner.
    pub async fn disconnect(&self, workspace_id: &str, provider: &str) -> Result<()> {
        let p = self.find_provider(provider)?;
        db::delete_vault_connection(&self.pool, workspace_id, provider).await?;
        p.disconnect(workspace_id).await?;
        Ok(())
    }

    fn find_provider(&self, name: &str) -> Result<&dyn VaultProvider> {
        self.providers
            .iter()
            .find(|p| p.provider_name() == name)
            .map(|p| p.as_ref())
            .ok_or_else(|| anyhow!("unknown vault provider: {}", name))
    }
}

// ── Session freshness ───────────────────────────────────────────────────

/// What the row says about a cached session.
#[derive(Debug, PartialEq, Eq)]
#[must_use = "a session check that is ignored revokes nothing"]
pub(crate) enum SessionCheck {
    /// The row still carries the generation the session was loaded at.
    Current,
    /// The row was rewritten since (a re-pair, possibly on another instance),
    /// or the session never saw the row it now has: its credentials are
    /// superseded and it must be reloaded.
    Superseded,
    /// The row is gone (a disconnect, possibly on another instance): the
    /// session must be dropped and nothing served.
    Gone,
}

/// Classify a cached session against the row's current generation.
///
/// `cached` is `None` for a session that has not yet observed its row (a
/// Bitwarden pairing in progress): it is never `Current`.
pub(crate) fn classify_session(
    cached: Option<VaultGeneration>,
    current: Option<VaultGeneration>,
) -> SessionCheck {
    match current {
        None => SessionCheck::Gone,
        Some(current) if Some(current) == cached => SessionCheck::Current,
        Some(_) => SessionCheck::Superseded,
    }
}

/// Re-read the row and classify a cached session against it.
///
/// # Errors
///
/// Returns the database error when the row cannot be read. It is never
/// guessed at: the caller fails this one operation closed and KEEPS the
/// session, so a database blip neither serves a credential it could not
/// verify nor tears down every live session.
pub(crate) async fn check_session(
    pool: &PgPool,
    workspace_id: &str,
    provider: &str,
    cached: Option<VaultGeneration>,
) -> Result<SessionCheck> {
    let current = db::find_vault_connection_generation(pool, workspace_id, provider).await?;
    Ok(classify_session(cached, current))
}

#[cfg(test)]
mod tests {
    use super::*;

    const G1: VaultGeneration = VaultGeneration(41);
    const G2: VaultGeneration = VaultGeneration(42);

    #[test]
    fn a_session_is_current_only_while_the_row_carries_its_generation() {
        assert_eq!(classify_session(Some(G1), Some(G1)), SessionCheck::Current);
        // Re-paired (on any instance): the row moved on.
        assert_eq!(
            classify_session(Some(G1), Some(G2)),
            SessionCheck::Superseded
        );
        // Disconnected (on any instance): the row is gone.
        assert_eq!(classify_session(Some(G1), None), SessionCheck::Gone);
    }

    #[test]
    fn a_session_that_never_saw_its_row_is_never_current() {
        assert_eq!(classify_session(None, Some(G1)), SessionCheck::Superseded);
        assert_eq!(classify_session(None, None), SessionCheck::Gone);
    }
}
