//! Vault integration — provider-agnostic credential fetching from external vaults.
//!
//! The `VaultProvider` trait defines the interface for vault backends (Bitwarden, etc.).
//! `VaultService` is the orchestrator that routes requests to the correct provider.

pub(crate) mod api;
pub(crate) mod bitwarden;
pub(crate) mod bitwarden_db;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use sqlx::PgPool;

use crate::db;

// ── Types ───────────────────────────────────────────────────────────────

/// Provider-agnostic credential returned by any vault provider.
#[derive(Debug)]
pub(crate) struct VaultCredential {
    #[allow(dead_code)]
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Result of a successful pairing operation.
#[derive(Debug)]
pub(crate) struct PairResult {
    /// Human-readable name for the connection (shown in UI).
    pub display_name: Option<String>,
}

/// Connection status for a provider.
#[derive(Debug)]
pub(crate) struct ProviderStatus {
    pub connected: bool,
    pub name: Option<String>,
    /// Provider-specific status details (e.g. fingerprint for Bitwarden).
    /// Serialized as-is into the API response as `status_data`.
    pub status_data: Option<serde_json::Value>,
}

// ── Trait ────────────────────────────────────────────────────────────────

#[async_trait]
pub(crate) trait VaultProvider: Send + Sync {
    /// Provider identifier (e.g., "bitwarden").
    fn provider_name(&self) -> &'static str;

    /// Pair with the vault using provider-specific credentials.
    async fn pair(&self, user_id: &str, params: &serde_json::Value) -> Result<PairResult>;

    /// Request a credential for a hostname from this user's vault.
    async fn request_credential(&self, user_id: &str, hostname: &str) -> Option<VaultCredential>;

    /// Get connection status for this user.
    async fn status(&self, user_id: &str) -> ProviderStatus;

    /// Disconnect and clean up.
    async fn disconnect(&self, user_id: &str) -> Result<()>;
}

// ── Orchestrator ────────────────────────────────────────────────────────

/// Provider-agnostic vault service. Routes operations to the correct provider
/// by name, iterates all providers for credential lookups.
pub(crate) struct VaultService {
    providers: Vec<Box<dyn VaultProvider>>,
    pool: PgPool,
}

impl VaultService {
    pub fn new(providers: Vec<Box<dyn VaultProvider>>, pool: PgPool) -> Self {
        Self { providers, pool }
    }

    /// Try each provider in order until one returns a credential.
    pub async fn request_credential(
        &self,
        user_id: &str,
        hostname: &str,
    ) -> Option<VaultCredential> {
        for provider in &self.providers {
            if let Some(cred) = provider.request_credential(user_id, hostname).await {
                return Some(cred);
            }
        }
        None
    }

    /// Pair with a specific provider. The provider owns DB persistence.
    pub async fn pair(
        &self,
        user_id: &str,
        provider: &str,
        params: &serde_json::Value,
    ) -> Result<PairResult> {
        let p = self.find_provider(provider)?;
        p.pair(user_id, params).await
    }

    /// Get status for a specific provider.
    pub async fn status(&self, user_id: &str, provider: &str) -> Option<ProviderStatus> {
        let p = self.find_provider(provider).ok()?;
        Some(p.status(user_id).await)
    }

    /// Disconnect a specific provider.
    pub async fn disconnect(&self, user_id: &str, provider: &str) -> Result<()> {
        let p = self.find_provider(provider)?;
        p.disconnect(user_id).await?;
        db::delete_vault_connection(&self.pool, user_id, provider).await?;
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
