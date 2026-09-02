//! Platform-provided Anthropic trial credit (cloud-only, licensed).
//!
//! When the hosted platform is configured with `PLATFORM_ANTHROPIC_API_KEY`,
//! an org with NO LLM credential of its own gets the platform's Anthropic key
//! injected at `api.anthropic.com` — capped at a lifetime spend limit
//! (`PLATFORM_ANTHROPIC_CREDIT_CENTS`, default 500 = $5) enforced by the
//! existing budget engine (`ee::budget`): the synthesized [`BudgetBinding`]
//! rides the normal `ConnectResponse → ResolvedRules` thread, so enforcement
//! (`pre_forward` 403), metering (Anthropic SSE/JSON), and spend persistence
//! (Redis hot counter + `budget_spends` floor) all apply unchanged.
//!
//! Design decisions:
//! - **Per-user, not per-org, credit pool**: the spend subject is the org's
//!   earliest active OWNER (`grant_subject`), so a user who spends the credit
//!   and creates a second org shares the same pool — the `budget_spends` row
//!   keys on `(platform:anthropic, user:<id>, total)`. `BudgetPeriod::Total`
//!   means it never resets.
//! - **Own keys always win**: the platform key only applies when the combined
//!   org+workspace secret pool has no LLM credential at all (any provider —
//!   an OpenAI key also disables it, forcing "bring your own" the moment a
//!   user has one). A user key restricted away from an agent still counts as
//!   present: the restriction is respected, never bypassed with free credit.
//! - **Cloud + config gated**: inert on onprem and whenever the env var is
//!   unset — the standard hosted-platform-plumbing posture (`cognito`-style
//!   edition gate combined with config presence).

use sqlx::PgPool;

use super::budget::{BudgetBinding, BudgetPeriod, BudgetSubject};

/// 1 cent = 1e7 nano-dollars (mirrors `budget/binding.rs`).
const NANOS_PER_CENT: i64 = 10_000_000;

/// Default lifetime credit when the cents env var is unset/invalid: $5.
const DEFAULT_CREDIT_CENTS: i64 = 500;

/// Sentinel secret id for the synthesized binding and its spend rows. Never
/// collides with a real `secrets.id` (UUIDs), and `budget_spends` has no FK.
pub const PLATFORM_SECRET_ID: &str = "platform:anthropic";

/// The host the platform key is valid on (and the only host it injects at).
const ANTHROPIC_HOST: &str = "api.anthropic.com";

/// Resolved platform-key configuration.
///
/// `Debug` is hand-written to REDACT the key: this struct holds the one
/// plaintext credential in the process that no `CryptoService` protects, so
/// a stray `{:?}` in a log line must never print it.
#[derive(Clone, PartialEq, Eq)]
pub struct PlatformKey {
    pub api_key: String,
    pub credit_nanos: i64,
    /// The one host the key is valid on and injects at. Overridable
    /// (`PLATFORM_ANTHROPIC_API_HOST`) for the e2e suite's local stubs;
    /// defaults to the real Anthropic API host.
    pub host: String,
}

impl std::fmt::Debug for PlatformKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlatformKey")
            .field("api_key", &"[REDACTED]")
            .field("credit_nanos", &self.credit_nanos)
            .field("host", &self.host)
            .finish()
    }
}

/// Parse the platform-key config from its env values. Pure and
/// edition-parameterized so both arms are table-testable without touching
/// process env (the `edition.rs` rule).
///
/// Active only on cloud with a key that LOOKS like an Anthropic credential
/// (`sk-ant-` prefix). The shape check is load-bearing, not cosmetic: the
/// deploy provisions the secret with a GENERATED placeholder so services can
/// boot before an operator pastes the real key — a presence check alone would
/// inject that garbage. The api-server mirrors the same rule
/// (`ee/services/platform-llm.ts`), which is what keeps "advertise the key"
/// and "inject the key" in agreement.
///
/// A missing/invalid cents value falls back to the $5 default; an explicit
/// non-positive value disables the feature entirely (a zero credit could
/// otherwise mint a binding that blocks nothing or — worse — a
/// permanently-blocking one, the same guard `binding.rs` applies to DB
/// limits).
fn parse(
    edition: common::edition::Edition,
    api_key: Option<&str>,
    credit_cents: Option<&str>,
    host: Option<&str>,
) -> Option<PlatformKey> {
    if edition != common::edition::Edition::Cloud {
        return None;
    }
    let api_key = api_key?.trim();
    if !api_key.starts_with("sk-ant-") {
        if !api_key.is_empty() {
            // Expected in a fresh deploy (the generated placeholder); info so
            // an operator can still see why a pasted-but-mangled key is dark.
            tracing::info!(
                "platform_llm: PLATFORM_ANTHROPIC_API_KEY is not an sk-ant-\u{2026} key — trial credit disabled"
            );
        }
        return None;
    }
    let cents = match credit_cents.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => match raw.parse::<i64>() {
            Ok(v) if v > 0 => v,
            Ok(_) => return None,
            Err(_) => {
                tracing::warn!(
                    raw,
                    "platform_llm: PLATFORM_ANTHROPIC_CREDIT_CENTS is not a number — using default"
                );
                DEFAULT_CREDIT_CENTS
            }
        },
        None => DEFAULT_CREDIT_CENTS,
    };
    Some(PlatformKey {
        api_key: api_key.to_string(),
        credit_nanos: cents.saturating_mul(NANOS_PER_CENT),
        host: host
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .unwrap_or(ANTHROPIC_HOST)
            .to_ascii_lowercase(),
    })
}

/// The process-wide platform-key config, read once from env.
pub fn platform_key() -> Option<&'static PlatformKey> {
    static KEY: std::sync::OnceLock<Option<PlatformKey>> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        let key = parse(
            common::edition::edition(),
            std::env::var("PLATFORM_ANTHROPIC_API_KEY").ok().as_deref(),
            std::env::var("PLATFORM_ANTHROPIC_CREDIT_CENTS")
                .ok()
                .as_deref(),
            std::env::var("PLATFORM_ANTHROPIC_API_HOST").ok().as_deref(),
        );
        if let Some(k) = &key {
            tracing::info!(
                credit_usd = k.credit_nanos as f64 / 1e9,
                "platform_llm: trial credit active"
            );
        }
        key
    })
    .as_ref()
}

/// Whether the platform credential could apply to this CONNECT at all —
/// the cheap pre-check `connect.rs` uses to decide if the (otherwise
/// unnecessary) secret-pool fetch is needed for the eligibility test when an
/// agent has no rule-selected secrets. Config + host only; eligibility and
/// entitlement are [`platform_credential`]'s job.
pub fn configured_for_host(hostname: &str) -> bool {
    platform_key().is_some_and(|k| hostname.eq_ignore_ascii_case(&k.host))
}

/// Whether the org/workspace secret pool disqualifies the trial credit: any
/// LLM credential — by provider type or by a host pattern reaching an LLM
/// host — means the user brought (or was granted) their own key, so the
/// platform key stands down. Callers apply this to the UNFILTERED pool
/// (before rule selection), so an agent restricted away from an existing org
/// key does NOT fall back to free credit: the restriction stays respected.
pub fn pool_has_llm_credential(secrets: &[db::SecretRow]) -> bool {
    secrets.iter().any(|s| {
        matches!(s.type_.as_str(), "anthropic" | "openai") || policy::is_llm_host(&s.host_pattern)
    })
}

/// The user whose lifetime credit pool this org draws from: the earliest
/// active owner (creation order breaks ties, so the founding owner keeps the
/// subject stable even after later ownership grants). Falls back to an
/// org-attributed subject when no owner resolves (fail-safe: still capped,
/// just per-org).
async fn grant_subject(pool: &PgPool, org_id: &str) -> BudgetSubject {
    let owner = sqlx::query_scalar::<_, String>(
        r#"SELECT user_id FROM organization_members
           WHERE organization_id = $1 AND role = 'owner' AND status = 'active'
           ORDER BY created_at ASC, user_id ASC
           LIMIT 1"#,
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!(error = ?e, org_id, "platform_llm: owner lookup failed");
        None
    });
    match owner {
        Some(user_id) => BudgetSubject::User(user_id),
        None => BudgetSubject::Org(org_id.to_string()),
    }
}

/// The platform credential for this connection, when it applies: the
/// injection rule (the standard Anthropic header shape) plus the synthesized
/// budget binding that the existing engine enforces and meters.
///
/// Applies only when ALL hold: cloud + key configured, the CONNECT host is
/// `api.anthropic.com`, and the org/workspace pool has no LLM credential of
/// its own (`pool_has_llm` — computed by the caller against the unfiltered
/// pool). `entitled` gates like every licensed feature: the budget engine
/// this rides is licensed, and an unenforceable cap must never hand out the
/// key.
pub async fn platform_credential(
    pool: &PgPool,
    org_id: &str,
    hostname: &str,
    pool_has_llm: bool,
    entitled: bool,
) -> Option<(inject::InjectionRule, BudgetBinding)> {
    if !entitled {
        return None;
    }
    let key = platform_key()?;
    if !hostname.eq_ignore_ascii_case(&key.host) {
        return None;
    }
    if pool_has_llm {
        return None;
    }
    let subject = grant_subject(pool, org_id).await;
    let rule = inject::InjectionRule {
        path_pattern: "*".to_string(),
        injections: inject::secret_inject::build_injections("anthropic", &key.api_key, None, None),
    };
    let binding = BudgetBinding {
        secret_id: PLATFORM_SECRET_ID.to_string(),
        subject,
        secret_type: "anthropic".to_string(),
        limit_nanos: key.credit_nanos,
        period: BudgetPeriod::Total,
    };
    Some((rule, binding))
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::edition::Edition;

    fn secret(type_: &'static str, host_pattern: &'static str) -> db::SecretRow {
        db::SecretRow {
            id: "s1".into(),
            scope: "workspace".into(),
            type_: type_.into(),
            value_source: "inline".into(),
            encrypted_value: None,
            op_ref: None,
            host_pattern: host_pattern.into(),
            path_pattern: None,
            injection_config: None,
            metadata: None,
        }
    }

    // ── parse ───────────────────────────────────────────────────────────

    #[test]
    fn parse_requires_cloud_edition() {
        assert_eq!(
            parse(Edition::Onprem, Some("sk-ant-x"), Some("500"), None),
            None
        );
    }

    #[test]
    fn parse_requires_a_nonempty_key() {
        assert_eq!(parse(Edition::Cloud, None, Some("500"), None), None);
        assert_eq!(parse(Edition::Cloud, Some(""), Some("500"), None), None);
        assert_eq!(parse(Edition::Cloud, Some("   "), Some("500"), None), None);
    }

    // The deploy provisions the secret with a GENERATED placeholder so the
    // task can boot before an operator pastes the real key. A key that does
    // not look like an Anthropic credential must read as "unconfigured" —
    // otherwise the placeholder would be injected upstream as if real.
    #[test]
    fn parse_rejects_a_placeholder_shaped_key() {
        assert_eq!(
            parse(
                Edition::Cloud,
                Some("aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL"),
                None,
                None
            ),
            None
        );
    }

    #[test]
    fn parse_defaults_to_five_dollars() {
        let key = parse(Edition::Cloud, Some("sk-ant-x"), None, None).unwrap();
        assert_eq!(key.credit_nanos, 500 * NANOS_PER_CENT); // $5
        assert_eq!(key.api_key, "sk-ant-x");
        assert_eq!(key.host, ANTHROPIC_HOST);
    }

    #[test]
    fn parse_reads_explicit_cents() {
        let key = parse(Edition::Cloud, Some("sk-ant-x"), Some("1000"), None).unwrap();
        assert_eq!(key.credit_nanos, 1000 * NANOS_PER_CENT); // $10
    }

    // A zero/negative credit must disable the feature, not mint a binding: the
    // budget gate is `spend >= limit`, so `limit <= 0` would block forever —
    // and handing out the key with an unenforceable cap is the worse failure.
    #[test]
    fn parse_nonpositive_cents_disables() {
        assert_eq!(
            parse(Edition::Cloud, Some("sk-ant-x"), Some("0"), None),
            None
        );
        assert_eq!(
            parse(Edition::Cloud, Some("sk-ant-x"), Some("-5"), None),
            None
        );
    }

    #[test]
    fn parse_unparseable_cents_falls_back_to_default() {
        let key = parse(Edition::Cloud, Some("sk-ant-x"), Some("five"), None).unwrap();
        assert_eq!(key.credit_nanos, DEFAULT_CREDIT_CENTS * NANOS_PER_CENT);
    }

    #[test]
    fn parse_host_override_is_normalized() {
        let key = parse(
            Edition::Cloud,
            Some("sk-ant-x"),
            None,
            Some(" API.Example.Com "),
        )
        .unwrap();
        assert_eq!(key.host, "api.example.com");
        // Blank override falls back to the real host.
        let key = parse(Edition::Cloud, Some("sk-ant-x"), None, Some("  ")).unwrap();
        assert_eq!(key.host, ANTHROPIC_HOST);
    }

    // ── eligibility ─────────────────────────────────────────────────────

    #[test]
    fn empty_pool_is_eligible() {
        assert!(!pool_has_llm_credential(&[]));
    }

    #[test]
    fn any_llm_provider_key_disqualifies() {
        // Not just Anthropic: a user with ANY LLM key brought their own —
        // the trial credit never runs alongside it.
        for type_ in ["anthropic", "openai"] {
            let secrets = [secret(type_, "irrelevant.example.com")];
            assert!(pool_has_llm_credential(&secrets), "type {type_}");
        }
    }

    #[test]
    fn generic_secret_on_an_llm_host_disqualifies() {
        let secrets = [secret("generic", "api.openrouter.ai")];
        assert!(pool_has_llm_credential(&secrets));
    }

    #[test]
    fn non_llm_secrets_do_not_disqualify() {
        let secrets = [
            secret("generic", "api.github.com"),
            secret("generic", "internal.example.com"),
        ];
        assert!(!pool_has_llm_credential(&secrets));
    }
}
