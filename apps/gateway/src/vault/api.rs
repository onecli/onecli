//! Axum handlers for vault operations (pair, status, disconnect).
//!
//! All handlers require `AuthUser` — authentication is enforced by the extractor
//! before the handler runs. Provider is specified in the URL path.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::auth::AuthUser;
use crate::gateway::GatewayState;

/// POST /api/vault/:provider/pair
/// Body: provider-specific JSON (e.g. `{ psk_hex, fingerprint_hex }` for Bitwarden)
pub(crate) async fn vault_pair(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
    Json(params): Json<serde_json::Value>,
) -> impl IntoResponse {
    match state
        .vault_service
        .pair(&auth.user_id, &provider, &params)
        .await
    {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "paired",
                "display_name": result.display_name,
            })),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e.to_string()})),
        ),
    }
}

/// GET /api/vault/:provider/status
pub(crate) async fn vault_status(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
) -> impl IntoResponse {
    match state.vault_service.status(&auth.user_id, &provider).await {
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

/// DELETE /api/vault/:provider/pair
pub(crate) async fn vault_disconnect(
    auth: AuthUser,
    State(state): State<GatewayState>,
    Path(provider): Path<String>,
) -> impl IntoResponse {
    match state
        .vault_service
        .disconnect(&auth.user_id, &provider)
        .await
    {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "disconnected"})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        ),
    }
}
