//! Policy engine — the OSS project-level first-match core (step 9.5). The EE
//! editions (cloud + both onprems) swap this module for `ee/policy_engine.rs`
//! via `#[path]` in `main.rs`; the `pub(crate)` surface is identical in both
//! builds, so the shared call sites in `connect.rs`, `gateway/forward.rs`, and
//! `gateway/websocket.rs` never change.
//!
//! The OSS scope (the §2.9 locked matrix — exactly today's capabilities,
//! restructured): project rules only, agent/any identities, all four target
//! kinds, allow/block with the approval + rate-limit modifiers, the project
//! Default Rule terminal under the `enforce_deny` carve, and the explicit-agent
//! injection selection its equipment migration requires. Org scope, directory
//! identities, granular session policies, availability, and the shadow
//! comparator are OneCLI Cloud capabilities and have no code here.

mod assemble;
mod catalog;
mod enforce;
mod evaluate;
mod inject_select;
mod types;

// The corpus parity test lives in the PRIVATE tree (`src/ee/policy_engine/`)
// and never ships: it proves this core decision-identical to the EE engine's
// project arm over the golden corpus. Compiled only in `edition_oss` test
// builds (this root is only compiled there); the OSS repo carries an empty
// stub at the same path so `cargo fmt`/`cargo test` resolve it.
#[cfg(test)]
#[path = "ee/policy_engine/oss_parity_test.rs"]
mod oss_parity_test;

pub(crate) use enforce::{
    evaluate, load_available_apps, load_connect_v2, needs_body_buffer, observe,
};
pub(crate) use inject_select::derive_inject_selection;
