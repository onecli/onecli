//! Budget layer (cloud-only): per-(secret, org) spend caps on LLM keys.
//!
//! DORMANT: the partner layer that produced budget-eligible (`scope='partner'`)
//! secrets was removed, and no other producer or setter surface exists yet —
//! bindings always resolve empty, so every downstream stage compiles but never
//! fires. Kept whole for a future budget surface; reviving it means adding a
//! setter surface and widening the candidate predicate in `binding.rs`.
//!
//! Self-contained and easily deletable: remove this file, the `budget/`
//! directory beside it, the `mod budget` decl in `ee.rs`, and the
//! `budget_bindings` field + its call sites in `connect.rs`/`gateway/mitm.rs`
//! /`gateway.rs`, plus the budget calls in `gateway/hooks.rs`/`telemetry.rs`.
//!
//! Threading: `connect.rs` resolves bindings for the effective credential
//! and threads them via `ConnectResponse → ResolvedRules`. `gateway/hooks.rs`
//! enforces (`pre_forward` → [`is_over_budget`]) and meters (`track_and_wrap` →
//! [`wrap_metered`]); the telemetry flush persists spend via [`add_spend`].
//!
//! Generic by design: the only per-provider code is the metering switch
//! (`meter::has_meter` / `meter::accumulator_for`) + the pricing table. Spend
//! is always nano-dollars, so enforcement/accounting never knows the provider.

use serde::{Deserialize, Serialize};

mod anthropic;
mod binding;
mod meter;
mod pricing;
mod spend;

pub(crate) use binding::resolve_bindings;
// The enforcement/metering surface is consumed by the merged request hooks
// (`gateway/hooks.rs`) and the telemetry flush (`telemetry.rs`).
pub(crate) use meter::{has_meter, wrap_metered};
pub(crate) use spend::{add_spend, is_over_budget};

/// How a budget's spend window resets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BudgetPeriod {
    /// Resets on the 1st of each month (UTC).
    Monthly,
    /// Lifetime cap; never resets.
    Total,
}

/// A resolved budget governing the effective credential for a request's host.
/// Resolved once at connect time, threaded `ConnectResponse → ResolvedRules`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct BudgetBinding {
    pub secret_id: String,
    pub organization_id: String,
    /// Secret type — selects the metering strategy (e.g. "anthropic").
    pub secret_type: String,
    /// Spend ceiling in nano-dollars (1e-9 USD).
    pub limit_nanos: i64,
    pub period: BudgetPeriod,
}
