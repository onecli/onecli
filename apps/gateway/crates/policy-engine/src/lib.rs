//! Policy engine — the priority-ordered, first-match policy engine, one
//! implementation for every edition. Born as cloud's step-4 shadow, it became
//! authoritative at the step-5 cutover; the separate OSS workspace-only core it
//! used to swap against was deleted when the edition machinery dissolved (the
//! two-level evaluator reduces exactly to the workspace arm when no org rules or
//! principals exist).
//!
//! NOT to be confused with `connect::PolicyEngine` (the connection resolver).
//! This is the rule-evaluation engine that becomes authoritative at the step-5
//! cutover; step 4 measures — on live traffic — whether it reproduces today's
//! decisions, surfacing the deliberate §7.7 divergences (per-identity priority
//! vs the gateway's exact-signature agent shadow) so their frequency is known
//! before the cutover decides accept-vs-materialize.
//!
//! Network-verbatim: it projects the raw `policy_rules` (custom, blocklist, AND
//! app-permission alike) into network-target rules and first-matches them; the
//! #626 catalog + app-target grouping are decision-neutral and skipped (§7.7).
//! Kept in agreement with the TypeScript translator (steps 2b/5) by the shared
//! golden corpus (`corpus_test.rs`).
//!
//! Self-contained and deletable (mirrors `budget`): remove this crate, its
//! workspace member entry, the `policy-engine` dependencies, and the
//! single `observe` call in `proxy`'s `forward`.

mod assemble;
mod catalog;
mod enforce;
mod evaluate;
mod graphql;
mod inject_select;
mod loaders;

// The free direct-user twin, re-exported for ONE consumer: the licensed
// principal parity test in `ee`, which pins the licensed CTE's direct
// arm against it. Hidden because it is test support, not public API, and
// reached only through ee's dev-dependency (a test-only back-edge).
#[doc(hidden)]
pub use loaders::find_direct_user_principals;
mod types;

#[cfg(test)]
mod corpus_test;

#[cfg(test)]
mod enforce_pg_test;

pub use enforce::{evaluate, load_available_apps, load_connect_v2, needs_body_buffer};
pub use inject_select::derive_inject_selection;
