//! Partner layer — stub for the OSS build. All functions are no-ops; the cloud
//! build swaps this module for `ee/partner.rs` via `#[path]` in `main.rs`.
//!
//! Keeping the same `pub(crate)` surface in both builds lets the shared call
//! sites (`connect.rs`, `ee/hooks.rs`) stay identical and inert in OSS.

use sqlx::PgPool;

use crate::db::SecretRow;

/// Pending claim token when the org is a partner-created org awaiting claim.
pub(crate) async fn claim_token_for_org(_pool: &PgPool, _org_id: &str) -> Option<String> {
    None
}

/// Partner-level inherited secrets (lowest-priority tier).
pub(crate) async fn inherited_secret_rows(_pool: &PgPool, _org_id: &str) -> Vec<SecretRow> {
    Vec::new()
}
