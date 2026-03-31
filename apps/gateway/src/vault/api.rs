//! Axum handlers for vault operations (pair, status, disconnect).
//!
//! All handlers require `AuthUser` — authentication is enforced by the extractor
//! before the handler runs. Provider is specified in the URL path.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use super::VaultError;
use crate::auth::AuthUser;
use crate::gateway::GatewayState;

/// POST /api/vault/:provider/pair
/// Body: provider-specific JSON (e.g. `{ psk_hex, fingerprint_hex }` for Bitwarden)
pub(crate) async fn vault_pair(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
    Json(params): Json<serde_json::Value>,
) -> Result<impl IntoResponse, VaultError> {
    let result = state
        .vault_service
        .pair(&auth.account_id, &provider, &params)
        .await?;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({
            "status": "paired",
            "display_name": result.display_name,
        })),
    ))
}

/// GET /api/vault/:provider/status
pub(crate) async fn vault_status(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
) -> Result<impl IntoResponse, VaultError> {
    let status = state
        .vault_service
        .status(&auth.account_id, &provider)
        .await?;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({
            "connected": status.connected,
            "name": status.name,
            "status_data": status.status_data,
        })),
    ))
}

/// DELETE /api/vault/:provider/pair
pub(crate) async fn vault_disconnect(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
) -> Result<impl IntoResponse, VaultError> {
    state
        .vault_service
        .disconnect(&auth.account_id, &provider)
        .await?;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({"status": "disconnected"})),
    ))
}

// ── 1Password-specific info endpoint ───────────────────────────────────

/// GET /api/vault/onepassword/info — unauthenticated, static response.
pub(crate) async fn vault_info() -> impl IntoResponse {
    Json(serde_json::json!({
        "capabilities": { "url_search": false, "explicit_mappings": true },
        "auth": "service_account_token",
        "mapping_format": "op://vault/item/field",
    }))
}

// ── Provider-generic mapping endpoints ─────────────────────────────────

/// GET /api/vault/{provider}/mappings
pub(crate) async fn vault_list_mappings(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
) -> Result<impl IntoResponse, VaultError> {
    let mappings = state
        .vault_service
        .list_mappings(&auth.account_id, &provider)
        .await?;
    Ok(Json(mappings))
}

/// PUT /api/vault/{provider}/mappings
pub(crate) async fn vault_upsert_mapping(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<impl IntoResponse, VaultError> {
    let hostname = body
        .get("hostname")
        .and_then(|v| v.as_str())
        .ok_or_else(|| VaultError::BadRequest("missing hostname".into()))?;
    state
        .vault_service
        .update_mapping(&auth.account_id, &provider, hostname, &body)
        .await?;
    Ok(Json(serde_json::json!({"status": "ok"})))
}

/// DELETE /api/vault/{provider}/mappings/{hostname}
pub(crate) async fn vault_delete_mapping(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path((provider, hostname)): Path<(String, String)>,
) -> Result<impl IntoResponse, VaultError> {
    state
        .vault_service
        .delete_mapping(&auth.account_id, &provider, &hostname)
        .await?;
    Ok(Json(serde_json::json!({"status": "ok"})))
}
