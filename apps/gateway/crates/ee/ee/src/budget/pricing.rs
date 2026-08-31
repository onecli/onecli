//! Per-model cost computation for the Anthropic meter.
//!
//! Rates are nano-dollars (1e-9 USD) per token. A price of `$X / 1M tokens`
//! equals `X * 1000` nano-$/token (e.g. $5/MTok → 5000 nano/tok). Models are
//! matched by family prefix because the wire `model` carries a date suffix
//! (e.g. `claude-opus-4-8-20260315`). An unknown model falls back to the most
//! expensive (Opus) rate so a newly-launched model can never *under*-charge a
//! spend cap — fail safe toward enforcement.
//!
//! Cross-check these rates against current Anthropic pricing when models change;
//! this table is the single place to update.

use tracing::warn;

/// Parsed token usage from an Anthropic response.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub model: Option<String>,
}

/// nano-dollars per token, per token class.
///
/// `cache_write` is the 5-minute ephemeral rate (1.25× input). Anthropic also
/// has a 1-hour cache-write tier (2× input) that's lumped into the same
/// `cache_creation_input_tokens` field, so heavy 1-hour-cache traffic
/// *undercharges* the cap slightly. Acceptable for now; revisit by reading the
/// per-tier `cache_creation` breakdown if it becomes material.
struct ModelRate {
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
}

const OPUS: ModelRate = ModelRate {
    input: 5_000,
    output: 25_000,
    cache_write: 6_250,
    cache_read: 500,
};
const SONNET: ModelRate = ModelRate {
    input: 3_000,
    output: 15_000,
    cache_write: 3_750,
    cache_read: 300,
};
const HAIKU: ModelRate = ModelRate {
    input: 1_000,
    output: 5_000,
    cache_write: 1_250,
    cache_read: 100,
};

/// Pick the rate for a model id by family prefix. Unknown → Opus (conservative).
fn rate_for(model: Option<&str>) -> &'static ModelRate {
    let Some(model) = model else {
        warn!("budget: missing model — charging at Opus fallback rate");
        return &OPUS;
    };
    if model.contains("opus") {
        &OPUS
    } else if model.contains("sonnet") {
        &SONNET
    } else if model.contains("haiku") {
        &HAIKU
    } else {
        warn!(
            model,
            "budget: unknown model — charging at Opus fallback rate"
        );
        &OPUS
    }
}

/// Total cost of a response in nano-dollars. Saturating arithmetic keeps a
/// pathological token count from overflowing (and the result is always ≥ 0).
pub fn cost_nanos(usage: &TokenUsage) -> i64 {
    // A response with no tokens at all is non-billable under ANY rate. This is
    // the normal shape of non-Messages 2xx traffic through the meter (GET
    // /v1/models at session start, count_tokens) — those bodies carry no
    // `usage` and often no `model`, which is not a pricing gap and must not
    // trip the missing/unknown-model WARN below. With tokens present, a
    // missing or unknown model still warns and charges the Opus fallback.
    if usage.input == 0 && usage.output == 0 && usage.cache_creation == 0 && usage.cache_read == 0 {
        return 0;
    }
    let r = rate_for(usage.model.as_deref());
    let total = usage
        .input
        .saturating_mul(r.input)
        .saturating_add(usage.output.saturating_mul(r.output))
        .saturating_add(usage.cache_creation.saturating_mul(r.cache_write))
        .saturating_add(usage.cache_read.saturating_mul(r.cache_read));
    i64::try_from(total).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(model: &str, input: u64, output: u64) -> TokenUsage {
        TokenUsage {
            input,
            output,
            cache_creation: 0,
            cache_read: 0,
            model: Some(model.to_string()),
        }
    }

    #[test]
    fn opus_input_output_priced_per_token() {
        // 1000 in × 5000 + 100 out × 25000 = 5_000_000 + 2_500_000 = 7_500_000 nano = $0.0075
        let cost = cost_nanos(&usage("claude-opus-4-8-20260315", 1_000, 100));
        assert_eq!(cost, 7_500_000);
    }

    #[test]
    fn sonnet_cheaper_than_opus_for_same_tokens() {
        let s = cost_nanos(&usage("claude-sonnet-4-6", 1_000, 1_000));
        let o = cost_nanos(&usage("claude-opus-4-8", 1_000, 1_000));
        assert!(s < o);
    }

    #[test]
    fn cache_tokens_priced() {
        let u = TokenUsage {
            input: 0,
            output: 0,
            cache_creation: 1_000,
            cache_read: 1_000,
            model: Some("claude-opus-4-8".into()),
        };
        // 1000 × 6250 + 1000 × 500 = 6_250_000 + 500_000
        assert_eq!(cost_nanos(&u), 6_750_000);
    }

    #[test]
    fn unknown_model_falls_back_to_opus_rate() {
        let unknown = cost_nanos(&usage("claude-something-new-9", 1_000, 100));
        let opus = cost_nanos(&usage("claude-opus-4-8", 1_000, 100));
        assert_eq!(unknown, opus, "unknown must not under-charge vs Opus");
    }

    #[test]
    fn missing_model_uses_fallback_not_zero() {
        let u = TokenUsage {
            input: 1_000,
            output: 0,
            cache_creation: 0,
            cache_read: 0,
            model: None,
        };
        assert!(cost_nanos(&u) > 0);
    }

    #[test]
    fn zero_usage_is_free_and_needs_no_rate() {
        // The models-list shape (GET /v1/models rides the meter too): no
        // tokens, no model — non-billable, and specifically NOT the
        // missing-model fallback case.
        assert_eq!(cost_nanos(&TokenUsage::default()), 0);
        // Same with a known model and no tokens (count_tokens-style bodies).
        let u = TokenUsage {
            model: Some("claude-opus-4-8".into()),
            ..TokenUsage::default()
        };
        assert_eq!(cost_nanos(&u), 0);
    }

    #[test]
    fn missing_model_with_any_token_class_still_charges_fallback() {
        // The zero-usage guard must not widen: one token in ANY class makes
        // the response billable, and a missing model then takes the Opus rate.
        for u in [
            TokenUsage {
                input: 1,
                ..TokenUsage::default()
            },
            TokenUsage {
                output: 1,
                ..TokenUsage::default()
            },
            TokenUsage {
                cache_creation: 1,
                ..TokenUsage::default()
            },
            TokenUsage {
                cache_read: 1,
                ..TokenUsage::default()
            },
        ] {
            assert!(cost_nanos(&u) > 0, "billable class must charge: {u:?}");
        }
    }
}
