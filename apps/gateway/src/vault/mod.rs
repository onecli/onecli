//! Vault integration — provider-agnostic credential fetching from external vaults.
//!
//! The `VaultProvider` trait defines the interface for vault backends (Bitwarden, etc.).
//! `VaultService` is the orchestrator that routes requests to the correct provider.

pub(crate) mod api;
pub(crate) mod bitwarden;
pub(crate) mod bitwarden_db;
pub(crate) mod onepassword;
pub(crate) mod onepassword_op;

use std::sync::Arc;

use async_trait::async_trait;
use axum::response::{IntoResponse, Response};
use hyper::StatusCode;
use sqlx::PgPool;

use crate::db;

// ── Types ───────────────────────────────────────────────────────────────

/// Provider-agnostic credential returned by any vault provider.
#[derive(Debug, Clone)]
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

#[derive(Debug, serde::Serialize)]
pub(crate) struct VaultInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct VaultItemSummary {
    pub id: String,
    pub title: String,
    pub category: String,
    pub urls: Vec<String>,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub(crate) enum VaultError {
    BadRequest(String),
    #[allow(dead_code)] // kept for future providers
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
        let (status, msg) = match &self {
            VaultError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            VaultError::Forbidden(m) => (StatusCode::FORBIDDEN, m.clone()),
            VaultError::NotFound(m) => (StatusCode::NOT_FOUND, m.clone()),
            VaultError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m.clone()),
        };
        (status, axum::Json(serde_json::json!({"error": msg}))).into_response()
    }
}

impl From<anyhow::Error> for VaultError {
    fn from(e: anyhow::Error) -> Self {
        VaultError::Internal(e.to_string())
    }
}

// ── Trait ────────────────────────────────────────────────────────────────

#[async_trait]
pub(crate) trait VaultProvider: Send + Sync {
    /// Provider identifier (e.g., "bitwarden").
    fn provider_name(&self) -> &'static str;

    /// Pair with the vault using provider-specific credentials.
    async fn pair(
        &self,
        account_id: &str,
        params: &serde_json::Value,
    ) -> Result<PairResult, VaultError>;

    /// Request a credential for a hostname from this account's vault.
    async fn request_credential(&self, account_id: &str, hostname: &str)
        -> Option<VaultCredential>;

    /// Get connection status for this account.
    async fn status(&self, account_id: &str) -> ProviderStatus;

    /// Disconnect and clean up.
    async fn disconnect(&self, account_id: &str) -> Result<(), VaultError>;

    async fn list_vaults(&self, _account_id: &str) -> Result<Vec<VaultInfo>, VaultError> {
        Err(VaultError::BadRequest("not supported".into()))
    }

    async fn list_items(
        &self,
        _account_id: &str,
        _vault_id: &str,
        _category: Option<&str>,
    ) -> Result<Vec<VaultItemSummary>, VaultError> {
        Err(VaultError::BadRequest("not supported".into()))
    }

    async fn list_mappings(&self, _account_id: &str) -> Result<serde_json::Value, VaultError> {
        Err(VaultError::BadRequest("not supported".into()))
    }

    async fn update_mapping(
        &self,
        _account_id: &str,
        _hostname: &str,
        _mapping: &serde_json::Value,
    ) -> Result<(), VaultError> {
        Err(VaultError::BadRequest("not supported".into()))
    }

    async fn delete_mapping(&self, _account_id: &str, _hostname: &str) -> Result<(), VaultError> {
        Err(VaultError::BadRequest("not supported".into()))
    }
}

// ── Orchestrator ────────────────────────────────────────────────────────

/// Provider-agnostic vault service. Routes operations to the correct provider
/// by name, iterates all providers for credential lookups.
pub(crate) struct VaultService {
    providers: Vec<Arc<dyn VaultProvider>>,
    pool: PgPool,
}

impl VaultService {
    pub fn new(providers: Vec<Arc<dyn VaultProvider>>, pool: PgPool) -> Self {
        Self { providers, pool }
    }

    /// Race all providers concurrently. The first `Some(credential)` wins,
    /// but a 500 ms grace window lets a lower-index (preferred) provider
    /// overtake a higher-index one that responded first.
    pub async fn request_credential(
        &self,
        account_id: &str,
        hostname: &str,
    ) -> Option<VaultCredential> {
        use std::time::Duration;
        use tokio::task::JoinSet;

        let providers: Vec<(usize, Arc<dyn VaultProvider>)> = self
            .providers
            .iter()
            .enumerate()
            .map(|(i, p)| (i, Arc::clone(p)))
            .collect();

        if providers.is_empty() {
            return None;
        }
        if providers.len() == 1 {
            return providers[0]
                .1
                .request_credential(account_id, hostname)
                .await;
        }

        let mut join_set = JoinSet::new();
        for (idx, provider) in providers {
            let aid = account_id.to_string();
            let host = hostname.to_string();
            join_set.spawn(async move {
                let cred = provider.request_credential(&aid, &host).await;
                (idx, cred)
            });
        }

        let mut best: Option<(usize, VaultCredential)> = None;
        let mut grace_deadline: Option<tokio::time::Instant> = None;

        loop {
            let next = if let Some(deadline) = grace_deadline {
                tokio::select! {
                    result = join_set.join_next() => result,
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            } else {
                join_set.join_next().await
            };

            match next {
                Some(Ok((idx, Some(cred)))) => {
                    if best.as_ref().is_none_or(|(best_idx, _)| idx < *best_idx) {
                        best = Some((idx, cred));
                    }
                    if best.as_ref().is_some_and(|(i, _)| *i == 0) {
                        break;
                    }
                    if grace_deadline.is_none() {
                        grace_deadline =
                            Some(tokio::time::Instant::now() + Duration::from_millis(500));
                    }
                }
                Some(Ok((_, None))) => {}
                Some(Err(_)) => {}
                None => break,
            }
        }

        best.map(|(_, cred)| cred)
    }

    /// Pair with a specific provider. The provider owns DB persistence.
    pub async fn pair(
        &self,
        account_id: &str,
        provider: &str,
        params: &serde_json::Value,
    ) -> Result<PairResult, VaultError> {
        let p = self.find_provider(provider)?;
        p.pair(account_id, params).await
    }

    /// Get status for a specific provider.
    pub async fn status(
        &self,
        account_id: &str,
        provider: &str,
    ) -> Result<ProviderStatus, VaultError> {
        let p = self.find_provider(provider)?;
        Ok(p.status(account_id).await)
    }

    /// Disconnect a specific provider.
    pub async fn disconnect(&self, account_id: &str, provider: &str) -> Result<(), VaultError> {
        let p = self.find_provider(provider)?;
        p.disconnect(account_id).await?;
        db::delete_vault_connection(&self.pool, account_id, provider)
            .await
            .map_err(|e| VaultError::Internal(e.to_string()))?;
        Ok(())
    }

    fn find_provider(&self, name: &str) -> Result<Arc<dyn VaultProvider>, VaultError> {
        self.providers
            .iter()
            .find(|p| p.provider_name() == name)
            .cloned()
            .ok_or_else(|| VaultError::NotFound(format!("unknown vault provider: {}", name)))
    }

    #[allow(dead_code)] // routes removed in v1 simplification; trait surface kept for v2
    pub async fn list_vaults(
        &self,
        account_id: &str,
        provider: &str,
    ) -> Result<Vec<VaultInfo>, VaultError> {
        self.find_provider(provider)?.list_vaults(account_id).await
    }

    #[allow(dead_code)] // routes removed in v1 simplification; trait surface kept for v2
    pub async fn list_items(
        &self,
        account_id: &str,
        provider: &str,
        vault_id: &str,
        category: Option<&str>,
    ) -> Result<Vec<VaultItemSummary>, VaultError> {
        self.find_provider(provider)?
            .list_items(account_id, vault_id, category)
            .await
    }

    pub async fn list_mappings(
        &self,
        account_id: &str,
        provider: &str,
    ) -> Result<serde_json::Value, VaultError> {
        self.find_provider(provider)?
            .list_mappings(account_id)
            .await
    }

    pub async fn update_mapping(
        &self,
        account_id: &str,
        provider: &str,
        hostname: &str,
        mapping: &serde_json::Value,
    ) -> Result<(), VaultError> {
        self.find_provider(provider)?
            .update_mapping(account_id, hostname, mapping)
            .await
    }

    pub async fn delete_mapping(
        &self,
        account_id: &str,
        provider: &str,
        hostname: &str,
    ) -> Result<(), VaultError> {
        self.find_provider(provider)?
            .delete_mapping(account_id, hostname)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct MockProvider {
        name: &'static str,
        credential: Option<VaultCredential>,
        delay_ms: u64,
    }

    #[async_trait]
    impl VaultProvider for MockProvider {
        fn provider_name(&self) -> &'static str {
            self.name
        }
        async fn pair(&self, _: &str, _: &serde_json::Value) -> Result<PairResult, VaultError> {
            Err(VaultError::BadRequest("mock".into()))
        }
        async fn request_credential(&self, _: &str, _: &str) -> Option<VaultCredential> {
            tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
            self.credential.as_ref().map(|c| VaultCredential {
                username: c.username.clone(),
                password: c.password.clone(),
            })
        }
        async fn status(&self, _: &str) -> ProviderStatus {
            ProviderStatus {
                connected: false,
                name: None,
                status_data: None,
            }
        }
        async fn disconnect(&self, _: &str) -> Result<(), VaultError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn fast_none_does_not_cancel_slow_some() {
        let pool = sqlx::PgPool::connect_lazy("postgresql://unused").unwrap();
        let svc = VaultService::new(
            vec![
                Arc::new(MockProvider {
                    name: "fast-none",
                    credential: None,
                    delay_ms: 0,
                }),
                Arc::new(MockProvider {
                    name: "slow-some",
                    credential: Some(VaultCredential {
                        username: None,
                        password: Some("secret".into()),
                    }),
                    delay_ms: 100,
                }),
            ],
            pool,
        );
        let cred = svc.request_credential("acct1", "example.com").await;
        assert!(cred.is_some());
        assert_eq!(cred.unwrap().password.unwrap(), "secret");
    }

    #[tokio::test]
    async fn lower_index_wins_within_grace_period() {
        let pool = sqlx::PgPool::connect_lazy("postgresql://unused").unwrap();
        let svc = VaultService::new(
            vec![
                Arc::new(MockProvider {
                    name: "preferred",
                    credential: Some(VaultCredential {
                        username: None,
                        password: Some("bitwarden".into()),
                    }),
                    delay_ms: 200,
                }),
                Arc::new(MockProvider {
                    name: "secondary",
                    credential: Some(VaultCredential {
                        username: None,
                        password: Some("onepassword".into()),
                    }),
                    delay_ms: 50,
                }),
            ],
            pool,
        );
        let cred = svc.request_credential("acct1", "example.com").await;
        assert_eq!(cred.unwrap().password.unwrap(), "bitwarden");
    }
}
