//! Resolve budget configs for the effective budget-eligible secrets of a
//! request.
//!
//! DORMANT: eligibility is keyed on [`BUDGET_ELIGIBLE_SCOPE`], a secret scope
//! nothing produces since the partner layer was removed — every resolution
//! returns empty. A revived budget surface changes that one declared fact
//! (together with the API side's eligibility in
//! `packages/api/src/ee/budget/budget-service.ts`).

use sqlx::PgPool;

use super::{BudgetBinding, BudgetPeriod, BudgetSubject};

/// 1 cent = 1e7 nano-dollars (limits are stored human-friendly in cents).
const NANOS_PER_CENT: i64 = 10_000_000;

/// The secret scope budgets attach to — the module's ONE declared eligibility
/// fact. DORMANT: the schema no longer defines this scope ("workspace" |
/// "organization"), so no secret matches and every resolution is empty; a
/// revived budget surface widens this (and the API's `budget-service.ts`
/// eligibility) in the same change, or budgets set there would never bind.
const BUDGET_ELIGIBLE_SCOPE: &str = "partner";

/// The minimal view of a resolved secret the budget layer needs to pick the
/// effective budget-eligible credential — kept narrow (id + scope + type) so
/// the module doesn't depend on the rest of `db::SecretRow` and the rule below
/// can be unit-tested with a stub. Implemented for `db::SecretRow`.
pub trait BudgetSecret {
    fn id(&self) -> &str;
    fn scope(&self) -> &str;
    fn secret_type(&self) -> &str;
}

impl BudgetSecret for db::SecretRow {
    fn id(&self) -> &str {
        &self.id
    }
    fn scope(&self) -> &str {
        &self.scope
    }
    fn secret_type(&self) -> &str {
        &self.type_
    }
}

/// An effective budget-eligible secret a budget can attach to.
struct Effective<'a> {
    id: &'a str,
    secret_type: &'a str,
}

/// The budget-eligible (`scope='partner'`, historically the partner tier)
/// secrets in `secrets` that are the EFFECTIVE credential for the request —
/// i.e. NOT shadowed by a higher-precedence org/workspace secret of the same
/// type (otherwise that org/workspace key is what's actually used, so the budget
/// mustn't attach to the eligible key). Pure; the DB lookup is separate.
///
/// The shadow check is by type, not `path_pattern`: two same-type keys collide
/// on the same auth header, so the higher-precedence one wins. An eligible +
/// org key of the same type but disjoint paths is a rare config we
/// conservatively treat as shadowed (no budget) rather than risk metering
/// usage that used the org key.
fn effective_partner_secrets<S: BudgetSecret>(secrets: &[S]) -> Vec<Effective<'_>> {
    secrets
        .iter()
        .filter(|s| s.scope() == BUDGET_ELIGIBLE_SCOPE)
        .filter(|s| {
            !secrets.iter().any(|other| {
                other.scope() != BUDGET_ELIGIBLE_SCOPE && other.secret_type() == s.secret_type()
            })
        })
        .map(|s| Effective {
            id: s.id(),
            secret_type: s.secret_type(),
        })
        .collect()
}

/// Resolve budget bindings for the effective budget-eligible credential(s)
/// among the host-filtered `secrets` of a request. Identifying the eligible
/// secret by its actual `scope` (not its resolution path) is what makes this
/// correct in selective mode too. Fails open (empty) on DB error — a transient
/// failure must never block a request (enforcement re-applies once the DB
/// recovers).
pub async fn resolve_bindings<S: BudgetSecret>(
    pool: &PgPool,
    org_id: &str,
    secrets: &[S],
    entitled: bool,
) -> Vec<BudgetBinding> {
    // Budgets are licensed (#96). Unlicensed deployments resolve no bindings —
    // which also removes the per-request `is_over_budget` check, the one DB
    // touch on the request path. `entitled` arrives as a parameter (the
    // edition.rs rule) so this arm is table-testable.
    if !entitled {
        return Vec::new();
    }
    let effective = effective_partner_secrets(secrets);
    if effective.is_empty() {
        return Vec::new();
    }
    let secret_ids: Vec<&str> = effective.iter().map(|e| e.id).collect();

    let rows = sqlx::query_as::<_, BudgetConfigRow>(
        r#"SELECT secret_id, limit_cents, period
           FROM budgets
           WHERE organization_id = $1 AND secret_id = ANY($2)"#,
    )
    .bind(org_id)
    .bind(&secret_ids)
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!(error = ?e, org_id, "budget: failed to load budget configs");
        Vec::new()
    });

    rows.into_iter()
        .filter_map(|row| {
            // Defense-in-depth: the API validates `limit_cents > 0`, but never let
            // a stray non-positive value become a permanent block (spend is always
            // `>= 0`, so `spend >= 0` would block every request forever). Skip it.
            if row.limit_cents <= 0 {
                tracing::warn!(
                    secret_id = %row.secret_id,
                    limit_cents = row.limit_cents,
                    "budget: ignoring non-positive limit"
                );
                return None;
            }
            // Carry the secret type from the effective secret (selects the meter).
            let secret_type = effective
                .iter()
                .find(|e| e.id == row.secret_id)?
                .secret_type
                .to_string();
            let period = match row.period.as_str() {
                "total" => BudgetPeriod::Total,
                _ => BudgetPeriod::Monthly,
            };
            Some(BudgetBinding {
                secret_id: row.secret_id,
                subject: BudgetSubject::Org(org_id.to_string()),
                secret_type,
                limit_nanos: i64::from(row.limit_cents) * NANOS_PER_CENT,
                period,
            })
        })
        .collect()
}

#[derive(sqlx::FromRow)]
struct BudgetConfigRow {
    secret_id: String,
    limit_cents: i32,
    period: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestSecret {
        id: &'static str,
        scope: &'static str,
        type_: &'static str,
    }

    impl BudgetSecret for TestSecret {
        fn id(&self) -> &str {
            self.id
        }
        fn scope(&self) -> &str {
            self.scope
        }
        fn secret_type(&self) -> &str {
            self.type_
        }
    }

    fn sec(id: &'static str, scope: &'static str, type_: &'static str) -> TestSecret {
        TestSecret { id, scope, type_ }
    }

    #[test]
    fn partner_secret_is_effective_when_not_shadowed() {
        let secrets = [sec("p1", "partner", "anthropic")];
        let eff = effective_partner_secrets(&secrets);
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].id, "p1");
    }

    #[test]
    fn partner_secret_shadowed_by_same_type_org_secret() {
        let secrets = [
            sec("p1", "partner", "anthropic"),
            sec("o1", "organization", "anthropic"),
        ];
        assert!(effective_partner_secrets(&secrets).is_empty());
    }

    #[test]
    fn partner_secret_not_shadowed_by_different_type() {
        let secrets = [
            sec("p1", "partner", "anthropic"),
            sec("o1", "organization", "openai"),
        ];
        let eff = effective_partner_secrets(&secrets);
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].id, "p1");
    }

    #[test]
    fn non_partner_secrets_are_never_candidates() {
        let secrets = [
            sec("o1", "organization", "anthropic"),
            sec("pr1", "workspace", "openai"),
        ];
        assert!(effective_partner_secrets(&secrets).is_empty());
    }
}

/// The license gate, proven differentially against a real database (the
/// fail-open-on-DB-error design means a fake erroring pool cannot tell the
/// early return apart from a swallowed query failure): the same seeded
/// budget resolves licensed and does NOT resolve unlicensed. Deleting the
/// `!entitled` early-return fails the unlicensed arm with a real binding.
/// Env-gated like the rbac recheck tests — skipped locally without
/// `GATEWAY_TEST_DATABASE_URL`, mandatory in CI.
#[cfg(test)]
mod entitlement_pg_tests {
    use super::{resolve_bindings, BudgetSecret};
    use db::create_pool;
    use sqlx::PgPool;

    struct TestSecret {
        id: String,
    }

    impl BudgetSecret for TestSecret {
        fn id(&self) -> &str {
            &self.id
        }
        fn scope(&self) -> &str {
            "partner"
        }
        fn secret_type(&self) -> &str {
            "anthropic"
        }
    }

    async fn test_pool() -> Option<PgPool> {
        let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "GATEWAY_TEST_DATABASE_URL must be set in CI: the budget entitlement test must not silently skip"
            );
            eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
            return None;
        };
        Some(create_pool(&url).await.expect("connect to test database"))
    }

    async fn reset(pool: &PgPool, key: &str) {
        let like = format!("{key}%");
        for sql in [
            "DELETE FROM budgets WHERE secret_id LIKE $1 OR organization_id LIKE $1",
            "DELETE FROM secrets WHERE id LIKE $1",
            "DELETE FROM organizations WHERE id LIKE $1",
        ] {
            sqlx::query(sql)
                .bind(&like)
                .execute(pool)
                .await
                .expect("reset test rows");
        }
    }

    #[tokio::test]
    async fn entitlement_gates_binding_resolution_differentially() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let key = "bgt1";
        reset(&pool, key).await;

        let org = format!("{key}-org");
        let secret = format!("{key}-sec");
        sqlx::query(
            "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
        )
        .bind(&org)
        .execute(&pool)
        .await
        .expect("insert org");
        sqlx::query(
            "INSERT INTO secrets (id, name, type, host_pattern, updated_at) \
             VALUES ($1, $1, 'anthropic', 'api.anthropic.com', NOW())",
        )
        .bind(&secret)
        .execute(&pool)
        .await
        .expect("insert secret");
        sqlx::query(
            "INSERT INTO budgets (id, secret_id, organization_id, limit_cents, period, created_by, updated_at) \
             VALUES ($1, $2, $3, 500, 'monthly', 'test', NOW())",
        )
        .bind(format!("{key}-budget"))
        .bind(&secret)
        .bind(&org)
        .execute(&pool)
        .await
        .expect("insert budget");

        let secrets = [TestSecret { id: secret.clone() }];

        let unlicensed = resolve_bindings(&pool, &org, &secrets, false).await;
        assert!(
            unlicensed.is_empty(),
            "unlicensed resolution must bind no budgets, got {unlicensed:?}"
        );

        let licensed = resolve_bindings(&pool, &org, &secrets, true).await;
        assert_eq!(licensed.len(), 1, "licensed twin must resolve the binding");
        assert_eq!(licensed[0].secret_id, secret);

        reset(&pool, key).await;
    }
}
