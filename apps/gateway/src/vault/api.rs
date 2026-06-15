//! Axum handlers for vault operations (pair, status, disconnect).
//!
//! All handlers require `AuthUser` — authentication is enforced by the extractor
//! before the handler runs. Provider is specified in the URL path.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use tracing::{info_span, warn, Instrument};

use super::VaultError;
use crate::auth::AuthUser;
use crate::gateway::GatewayState;

/// POST /v1/vault/:provider/pair
/// Body: provider-specific JSON (e.g. `{ psk_hex, fingerprint_hex }` for Bitwarden)
pub(crate) async fn vault_pair(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
    Json(params): Json<serde_json::Value>,
) -> impl IntoResponse {
    let span = info_span!("vault_pair", project_id = %auth.project_id, provider = %provider);
    async move {
        match state
            .vault_service
            .pair(&auth.project_id, &provider, &params)
            .await
        {
            Ok(result) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "paired",
                    "display_name": result.display_name,
                })),
            ),
            Err(e) => {
                warn!(error = %e, "vault pair failed");
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": e.to_string()})),
                )
            }
        }
    }
    .instrument(span)
    .await
}

/// GET /v1/vault/:provider/status
pub(crate) async fn vault_status(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
) -> impl IntoResponse {
    let span = info_span!("vault_status", project_id = %auth.project_id, provider = %provider);
    async move {
        match state
            .vault_service
            .status(&auth.project_id, &provider)
            .await
        {
            Some(status) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "connected": status.connected,
                    "name": status.name,
                    "status_data": status.status_data,
                })),
            ),
            None => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "connected": false,
                    "name": null,
                    "status_data": null,
                })),
            ),
        }
    }
    .instrument(span)
    .await
}

/// DELETE /v1/vault/:provider/pair
pub(crate) async fn vault_disconnect(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
) -> impl IntoResponse {
    let span = info_span!("vault_disconnect", project_id = %auth.project_id, provider = %provider);
    async move {
        match state
            .vault_service
            .disconnect(&auth.project_id, &provider)
            .await
        {
            Ok(()) => (
                StatusCode::OK,
                Json(serde_json::json!({"status": "disconnected"})),
            ),
            Err(e) => {
                warn!(error = %e, "vault disconnect failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e.to_string()})),
                )
            }
        }
    }
    .instrument(span)
    .await
}

// ── 1Password picker (browse vaults → items → fields) ──────────────────
// The browser drives the secret dialog's value picker through these; the SA
// token and field values never leave the gateway / Node boundary.

/// GET /v1/vault/onepassword/vaults
pub(crate) async fn vault_op_vaults(
    auth: AuthUser,
    State(state): State<GatewayState>,
) -> Result<impl IntoResponse, VaultError> {
    let vaults = state
        .policy_engine
        .onepassword
        .list_vaults(&auth.project_id)
        .await?;
    Ok(Json(vaults))
}

/// GET /v1/vault/onepassword/vaults/:vaultId/items
pub(crate) async fn vault_op_items(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(vault_id): Path<String>,
) -> Result<impl IntoResponse, VaultError> {
    let items = state
        .policy_engine
        .onepassword
        .list_items(&auth.project_id, &vault_id)
        .await?;
    Ok(Json(items))
}

/// GET /v1/vault/onepassword/items/:vaultId/:itemId/fields
pub(crate) async fn vault_op_fields(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path((vault_id, item_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, VaultError> {
    let fields = state
        .policy_engine
        .onepassword
        .list_fields(&auth.project_id, &vault_id, &item_id)
        .await?;
    Ok(Json(fields))
}
