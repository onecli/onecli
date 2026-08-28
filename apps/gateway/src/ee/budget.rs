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

/// WHO a budget's spend is attributed to — the second axis of the spend
/// counter, next to the credential (`secret_id`).
///
/// Org budgets attribute to the consuming organization; the platform trial
/// credit attributes to a USER (the org's founding owner), so a second org by
/// the same person draws from the same pool. Storage is the rendered
/// `org:<id>` / `user:<id>` string — in the Redis key, in the
/// `budget_spends.organization_id` column (kept under its historical name;
/// the prefix is what makes the value honest), and across the serialized
/// `ConnectResponse` cache. Serde round-trips through that same string, so
/// the wire shape stays a plain JSON string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub(crate) enum BudgetSubject {
    Org(String),
    User(String),
}

impl std::fmt::Display for BudgetSubject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BudgetSubject::Org(id) => write!(f, "org:{id}"),
            BudgetSubject::User(id) => write!(f, "user:{id}"),
        }
    }
}

impl From<BudgetSubject> for String {
    fn from(s: BudgetSubject) -> String {
        s.to_string()
    }
}

impl TryFrom<String> for BudgetSubject {
    type Error = String;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        if let Some(id) = s.strip_prefix("org:") {
            return Ok(BudgetSubject::Org(id.to_string()));
        }
        if let Some(id) = s.strip_prefix("user:") {
            return Ok(BudgetSubject::User(id.to_string()));
        }
        // Unprefixed values (a pre-rename cached ConnectResponse) fail parse:
        // the caller treats it as a cache miss and re-resolves — a ~60s
        // window, never wrong enforcement.
        Err(format!("budget subject without an org:/user: prefix: {s}"))
    }
}

/// A resolved budget governing the effective credential for a request's host.
/// Resolved once at connect time, threaded `ConnectResponse → ResolvedRules`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct BudgetBinding {
    pub secret_id: String,
    /// Spend attribution: the org for org budgets, the founding-owner USER
    /// for the platform trial credit.
    pub subject: BudgetSubject,
    /// Secret type — selects the metering strategy (e.g. "anthropic").
    pub secret_type: String,
    /// Spend ceiling in nano-dollars (1e-9 USD).
    pub limit_nanos: i64,
    pub period: BudgetPeriod,
}

#[cfg(test)]
mod subject_tests {
    use super::BudgetSubject;

    #[test]
    fn renders_prefixed_forms() {
        assert_eq!(BudgetSubject::Org("o1".into()).to_string(), "org:o1");
        assert_eq!(BudgetSubject::User("u1".into()).to_string(), "user:u1");
    }

    #[test]
    fn serde_round_trips_through_the_prefixed_string() {
        for subject in [
            BudgetSubject::Org("o1".into()),
            BudgetSubject::User("u1".into()),
        ] {
            let json = serde_json::to_string(&subject).unwrap();
            let back: BudgetSubject = serde_json::from_str(&json).unwrap();
            assert_eq!(back, subject);
        }
        assert_eq!(
            serde_json::to_string(&BudgetSubject::User("u1".into())).unwrap(),
            "\"user:u1\""
        );
    }

    // A pre-rename cached ConnectResponse carries a bare id — it must fail
    // deserialization (→ cache miss → re-resolve), never silently parse as
    // one of the variants.
    #[test]
    fn unprefixed_value_fails_parse() {
        assert!(serde_json::from_str::<BudgetSubject>("\"bare-id\"").is_err());
    }
}
