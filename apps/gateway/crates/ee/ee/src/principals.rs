//! Directory principals + app availability — the licensed connect-time
//! resolvers.
//!
//! Two features share one org-fenced human-derivation CTE (`resolve.rs`, one
//! definition, two consumers):
//!
//! - **Group principal inheritance (#51)**: the full principal set — direct
//!   WorkspaceAccess users, members inherited through granted directory
//!   groups, and the groups to match. Unlicensed deployments never call it;
//!   they resolve the free direct-user twin in
//!   `crate::policy_engine::loaders` instead, so group-bound rules cannot
//!   match and nothing is inherited through a group.
//! - **App availability (#29)**: the org's restricted-mode provider
//!   allowlist and the per-request block predicate (`availability.rs`).
//!   Unlicensed deployments short-circuit to the unrestricted default before
//!   reaching this module.
//!
//! Everything here runs at connect resolution (cached ~60s) — never on the
//! per-request path, which stays DB-free.

mod availability;
mod resolve;

pub use availability::{app_availability_block, load_available_apps};
pub use resolve::find_principal_set;
