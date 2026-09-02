//! Org-scoped gateway routes.
//!
//! Mounted unconditionally via `crate::ee` and compiled into every edition
//! (the former `src/org_routes.rs` identity stub is gone); org keys — and the
//! org auth/store surface these routes depend on — exist everywhere.

use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use hyper::StatusCode;
use tracing::{info, info_span, warn, Instrument};

use approval::APPROVAL_TIMEOUT_SECS;
use approval::{pending_approval_row, PendingParams};
use context::auth::OrgAuthUser;
use context::GatewayState;

/// Attach the org-scoped routes to the gateway router.
pub fn mount(router: Router<GatewayState>) -> Router<GatewayState> {
    router.route("/v1/org/approvals/pending", get(get_org_pending_approvals))
}

/// Org-scoped counterpart of the workspace approvals poll: long-polls for pending
/// approvals across **every** workspace in the caller's organization, each item
/// carrying its own `workspaceId` so the handler can route a decision back to the
/// right workspace via the existing `/v1/approvals/{id}/decision` route. Requires
/// an org API key (a workspace key or workspace-scoped session → 403).
async fn get_org_pending_approvals(
    auth: OrgAuthUser,
    State(state): State<GatewayState>,
    Query(params): Query<PendingParams>,
) -> impl IntoResponse {
    // The org-wide approvals feed (#59) is licensed. A runtime 403 — not a
    // mount skip — so the path answers with the reason instead of a bare 404.
    if !common::edition::entitled() {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "error": "enterprise_license_required" })),
        )
            .into_response();
    }

    // Present only for an org key; a workspace key or session leaves it None.
    let Some(org_id) = auth.organization_id else {
        warn!(auth_method = %auth.auth_method, "org approval poll: organization scope required");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "error": "organization_scope_required" })),
        )
            .into_response();
    };

    let span = info_span!("org_approval_poll",
        org_id = %org_id,
        user_id = %auth.user_id,
        auth_method = %auth.auth_method,
    );
    async move {
        let exclude: std::collections::HashSet<&str> = params
            .exclude
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        info!(exclude_count = exclude.len(), "org approval poll started");

        let mut pending = state.approval_store.list_pending_for_org(&org_id).await;
        pending.retain(|a| !exclude.contains(a.id.as_str()));

        let mut long_polled = false;
        if pending.is_empty() {
            long_polled = true;
            let mut shutdown_signal = shutdown::subscribe();
            // Same reason as the workspace-scoped poll: a 30-second hold would
            // pin the drain for its whole window.
            let got_new = tokio::select! {
                got_new = state.approval_store.wait_for_new_for_org(
                    &org_id,
                    std::time::Duration::from_secs(30),
                ) => got_new,
                _ = shutdown_signal.wait() => false,
            };
            if got_new {
                let mut fresh = state.approval_store.list_pending_for_org(&org_id).await;
                fresh.retain(|a| !exclude.contains(a.id.as_str()));
                pending = fresh;
            }
        }

        info!(
            count = pending.len(),
            long_polled, "org approval poll completed"
        );

        axum::Json(serde_json::json!({
            "requests": pending.iter().map(pending_approval_row).collect::<Vec<_>>(),
            "timeoutSeconds": APPROVAL_TIMEOUT_SECS,
        }))
        .into_response()
    }
    .instrument(span)
    .await
}
