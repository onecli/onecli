//! Spend accounting: Redis hot counter (enforcement source of truth) backed by
//! a durable Postgres floor (`budget_spends`). Spend is in nano-dollars (i64),
//! period-windowed so monthly budgets self-rotate via key expiry.
//!
//! Fail-open everywhere: a Redis/DB hiccup must never block a request (the
//! durable floor re-enforces once the store recovers).

use sqlx::PgPool;

use crate::cache::CacheStore;

use super::{BudgetBinding, BudgetPeriod, BudgetSubject};

/// Long TTL for `total` (lifetime) budgets — kept warm; rebuilt from the DB
/// floor on expiry so the cap is never silently reset.
const TOTAL_TTL_SECS: u64 = 90 * 86_400;

/// The period window key, embedded in the Redis key so monthly budgets rotate.
/// `m:YYYY-MM` (UTC) for monthly, `total` for lifetime.
pub(crate) fn period_key(period: BudgetPeriod) -> String {
    match period {
        BudgetPeriod::Total => "total".to_string(),
        BudgetPeriod::Monthly => {
            let now = time::OffsetDateTime::now_utc();
            format!("m:{:04}-{:02}", now.year(), now.month() as u8)
        }
    }
}

fn redis_key(secret_id: &str, subject: &BudgetSubject, period_key: &str) -> String {
    redis_key_raw(secret_id, &subject.to_string(), period_key)
}

/// The same key from a pre-rendered subject string — the form the telemetry
/// flush holds (`BudgetCharge.subject`). One format string, two entry points,
/// so the enforcement read and the flush write can never key differently.
fn redis_key_raw(secret_id: &str, subject: &str, period_key: &str) -> String {
    format!("budget:spend:{secret_id}:{subject}:{period_key}")
}

/// Seconds until the current key should expire. Monthly keys expire at the end
/// of the UTC month so the next month starts fresh; total keys get a long TTL.
fn ttl_for_key(period_key: &str) -> u64 {
    if period_key == "total" {
        return TOTAL_TTL_SECS;
    }
    let now = time::OffsetDateTime::now_utc();
    let days_in_month = u64::from(now.month().length(now.year()));
    let day = u64::from(now.day());
    // include the remainder of today
    (days_in_month - day + 1) * 86_400
}

async fn db_floor_nanos(
    pool: &PgPool,
    secret_id: &str,
    subject: &BudgetSubject,
    period_key: &str,
) -> i64 {
    // The column keeps its historical name; the value is the rendered
    // subject (`org:<id>` / `user:<id>`) — see [`BudgetSubject`].
    sqlx::query_scalar::<_, i64>(
        r#"SELECT spent_nanos FROM budget_spends
           WHERE secret_id = $1 AND organization_id = $2 AND period = $3"#,
    )
    .bind(secret_id)
    .bind(subject.to_string())
    .bind(period_key)
    .fetch_optional(pool)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!(error = ?e, secret_id, "budget: durable floor read failed");
        None
    })
    .unwrap_or(0)
}

/// Current spend for a budget's active period, in nano-dollars. Reads the Redis
/// hot counter; on a clean miss (key expired/flushed) it rehydrates from the
/// durable Postgres floor so enforcement after a cache flush resumes from the
/// real total rather than zero.
///
/// The rehydrate write is best-effort: if a flush-time `add_spend` increments
/// the key in the brief window between the floor read and this `set_raw`, the
/// set overwrites it. That under-counts the hot counter by at most one flush
/// batch, transiently, and self-heals at the next miss/period rollover — an
/// acceptable softening of an already-soft cap. (A `SET NX` would tighten this
/// but needs a new cache-trait method; not worth it for this rare edge.)
pub(crate) async fn read_spent_nanos(
    cache: &dyn CacheStore,
    pool: &PgPool,
    binding: &BudgetBinding,
) -> i64 {
    let pk = period_key(binding.period);
    let key = redis_key(&binding.secret_id, &binding.subject, &pk);

    if let Some(raw) = cache.get_raw(&key).await {
        return raw.parse::<i64>().unwrap_or(0);
    }

    let floor = db_floor_nanos(pool, &binding.secret_id, &binding.subject, &pk).await;
    cache
        .set_raw(&key, &floor.to_string(), ttl_for_key(&pk))
        .await;
    floor
}

/// `true` when the budget's active-period spend has reached its limit.
pub(crate) async fn is_over_budget(
    cache: &dyn CacheStore,
    pool: &PgPool,
    binding: &BudgetBinding,
) -> bool {
    read_spent_nanos(cache, pool, binding).await >= binding.limit_nanos
}

/// Add `nanos` to a budget's spend: atomic Redis `incrby` (hot counter) plus an
/// upsert into the durable Postgres floor. Called off the request hot path from
/// the telemetry flush. Errors are logged, never propagated. `subject` is the
/// pre-rendered attribution string (`org:<id>` / `user:<id>`).
pub(crate) async fn add_spend(
    cache: &dyn CacheStore,
    pool: &PgPool,
    secret_id: &str,
    subject: &str,
    period_key: &str,
    nanos: i64,
) {
    if nanos <= 0 {
        return;
    }
    let key = redis_key_raw(secret_id, subject, period_key);
    if cache
        .incrby(&key, nanos as u64, ttl_for_key(period_key))
        .await
        .is_none()
    {
        tracing::warn!(key = %key, "budget: redis spend incrby failed");
    }

    let upsert = sqlx::query(
        r#"INSERT INTO budget_spends (secret_id, organization_id, period, spent_nanos, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (secret_id, organization_id, period)
           DO UPDATE SET spent_nanos = budget_spends.spent_nanos + EXCLUDED.spent_nanos,
                         updated_at = NOW()"#,
    )
    .bind(secret_id)
    .bind(subject)
    .bind(period_key)
    .bind(nanos)
    .execute(pool)
    .await;
    if let Err(e) = upsert {
        tracing::warn!(error = ?e, secret_id, "budget: durable floor upsert failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monthly_period_key_is_year_month() {
        let k = period_key(BudgetPeriod::Monthly);
        assert!(k.starts_with("m:"), "got {k}");
        assert_eq!(k.len(), "m:YYYY-MM".len());
    }

    #[test]
    fn total_period_key_is_stable() {
        assert_eq!(period_key(BudgetPeriod::Total), "total");
    }

    #[test]
    fn total_ttl_is_long_monthly_is_bounded() {
        assert_eq!(ttl_for_key("total"), TOTAL_TTL_SECS);
        let monthly = ttl_for_key("m:2026-06");
        assert!(monthly > 0 && monthly <= 31 * 86_400);
    }

    #[test]
    fn redis_key_namespaced() {
        assert_eq!(
            redis_key("sec1", &BudgetSubject::Org("org1".into()), "m:2026-06"),
            "budget:spend:sec1:org:org1:m:2026-06"
        );
        assert_eq!(
            redis_key(
                "platform:anthropic",
                &BudgetSubject::User("u1".into()),
                "total"
            ),
            "budget:spend:platform:anthropic:user:u1:total"
        );
    }
}
