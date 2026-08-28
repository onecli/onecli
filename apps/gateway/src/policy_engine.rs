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
//! Self-contained and deletable (mirrors `budget`): remove this file,
//! the `policy_engine/` directory beside it, the `mod policy_engine` in
//! `main.rs`, and the single `observe` call in `gateway/forward.rs`.

mod assemble;
mod catalog;
mod enforce;
mod evaluate;
mod inject_select;
mod loaders;
mod types;

#[cfg(test)]
mod corpus_test;

#[cfg(test)]
mod enforce_pg_test;

pub(crate) use enforce::{evaluate, load_available_apps, load_connect_v2, needs_body_buffer};
pub(crate) use inject_select::derive_inject_selection;
// Consumed from outside the module only by the ee parity test (the free
// twin's lockstep pin); production callers live inside via `super::loaders`.
#[cfg(test)]
pub(crate) use loaders::find_direct_user_principals;
