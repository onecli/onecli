//! Org-scoped gateway routes (OSS stub — mounts nothing).
//!
//! Cloud + onprem swap in `ee/org_routes.rs` (see `main.rs`); OSS has no
//! organization scope, so this leaves the router unchanged.

use axum::Router;

use crate::gateway::GatewayState;

/// Attach the org-scoped routes to the gateway router. No-op in OSS.
pub(crate) fn mount(router: Router<GatewayState>) -> Router<GatewayState> {
    router
}
