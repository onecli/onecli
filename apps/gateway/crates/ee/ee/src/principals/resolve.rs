//! The licensed principal-set resolver: one org-fenced CTE deriving a
//! workspace's inherited people and directory groups, shared by policy
//! identity matching and the app-availability grant derivation.

use anyhow::{Context, Result};
use sqlx::PgPool;

use db::PrincipalSet;

/// One row of the principal-set query: a `kind` discriminator + the id.
#[derive(Debug, sqlx::FromRow)]
struct PrincipalRow {
    kind: String,
    id: String,
}

/// The shared human-derivation CTE: a workspace's inherited people
/// (WorkspaceAccess direct users + members of granted groups, ACTIVE org members
/// only) and the directory groups to match (direct grants + every group the
/// inherited users belong to). `$1` = workspace id, `$2` = organization id;
/// every arm is org-fenced. One definition, two consumers
/// (`find_principal_set`, `find_available_providers`) — the
/// `POLICY_V2_SELECT` pattern, so a fix to one arm can't miss the other.
/// The direct-user arm has a free twin (`find_direct_user_principals` in
/// `crate::policy_engine::loaders`) that unlicensed deployments run instead;
/// `parity_tests` below pins the two against each other.
const PRINCIPAL_CTE: &str = r#"
        WITH direct_groups AS (
            -- Org-fenced like every other arm: a granted group must belong to
            -- the workspace's org, so a stray cross-org grant can't leak in.
            SELECT pa.group_id AS id
            FROM workspace_access pa
            JOIN groups g ON g.id = pa.group_id
            WHERE pa.workspace_id = $1 AND pa.group_id IS NOT NULL
              AND g.organization_id = $2
        ),
        candidate_users AS (
            SELECT user_id AS id FROM workspace_access
            WHERE workspace_id = $1 AND user_id IS NOT NULL
            UNION
            SELECT gm.user_id FROM group_members gm
            WHERE gm.group_id IN (SELECT id FROM direct_groups)
        ),
        all_users AS (
            -- Only ACTIVE org members contribute to an agent's inherited
            -- identities — a suspended/removed member is excluded, mirroring the
            -- people-gate `crate::rbac::user_can_manage_workspace`.
            SELECT cu.id
            FROM candidate_users cu
            JOIN organization_members om
              ON om.user_id = cu.id
             AND om.organization_id = $2
             AND om.status <> 'suspended'
        ),
        all_groups AS (
            SELECT id FROM direct_groups
            UNION
            SELECT gm.group_id
            FROM group_members gm
            JOIN groups g ON g.id = gm.group_id
            WHERE gm.user_id IN (SELECT id FROM all_users)
              AND g.organization_id = $2
        )"#;

/// Resolve a workspace's principal set for policy matching — the human users the
/// workspace grants via WorkspaceAccess (directly or as members of a granted group)
/// and the directory groups to match (granted directly, plus every group the
/// inherited users belong to). ONE org-fenced CTE, run once at connection
/// resolution (cached with `PolicyV2Rules`), so the per-request path never
/// touches the DB. Role-agnostic (owner/member ignored), but active-only — a
/// suspended org member is excluded, mirroring the people-gate
/// `crate::rbac::user_can_manage_workspace`. Workspace-derived, so every
/// agent of the workspace shares the same set.
///
/// Scoping (no cross-org leak): the WorkspaceAccess arms are workspace-scoped (a
/// workspace belongs to one org); the user→groups expansion is fenced on
/// `groups.organization_id = $2` because a user can belong to OTHER orgs' groups —
/// without that fence a foreign-org group id could leak into the match set.
pub async fn find_principal_set(
    pool: &PgPool,
    workspace_id: &str,
    organization_id: &str,
) -> Result<PrincipalSet> {
    let rows: Vec<PrincipalRow> = sqlx::query_as::<_, PrincipalRow>(&format!(
        r#"{PRINCIPAL_CTE}
        SELECT 'user' AS kind, id FROM all_users
        UNION ALL SELECT 'group' AS kind, id FROM all_groups
        "#
    ))
    .bind(workspace_id)
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("resolving workspace principal set")?;

    let mut principals = PrincipalSet::default();
    for row in rows {
        match row.kind.as_str() {
            "user" => principals.user_ids.push(row.id),
            "group" => principals.group_ids.push(row.id),
            // The query above is the only producer of `kind` — an unknown
            // value means the SQL and this match drifted apart.
            other => tracing::warn!(kind = other, "unknown principal kind"),
        }
    }
    Ok(principals)
}

/// The app-provider ids available to a workspace when its org is in "restricted"
/// availability mode (step 7): the DISTINCT providers of every availability RULE
/// that names one of the workspace's inherited people. Shares the human
/// derivation with `find_principal_set` (the one `PRINCIPAL_CTE` definition) —
/// then joins the rule + rule-identity tables and unnests each
/// matching rule's `providers` array. A person can match multiple rules; the
/// result is their union. Run once at connection resolution (cached), so the
/// per-request pre-check is DB-free.
///
/// Scoping (no cross-org leak): the rule lookup (`r.organization_id = $2`) and
/// every CTE arm are fenced to `$2` (the org); the user→groups expansion joins
/// `groups.organization_id = $2` because a user can belong to OTHER orgs' groups.
pub(super) async fn find_available_providers(
    pool: &PgPool,
    workspace_id: &str,
    organization_id: &str,
) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(&format!(
        r#"{PRINCIPAL_CTE},
        matching_rules AS (
            SELECT DISTINCT r.id, r.providers
            FROM app_availability_rules r
            JOIN app_availability_rule_identities i ON i.rule_id = r.id
            WHERE r.organization_id = $2
              AND ( i.user_id IN (SELECT id FROM all_users)
                 OR i.group_id IN (SELECT id FROM all_groups) )
        )
        SELECT DISTINCT p.provider
        FROM matching_rules mr
        CROSS JOIN LATERAL unnest(mr.providers) AS p(provider)
        WHERE p.provider IS NOT NULL
        "#
    ))
    .bind(workspace_id)
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("resolving available app providers")?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// The org's app-availability posture ("open" | "restricted"), read once at
/// connection resolution (step 7). A missing org (shouldn't happen — the agent
/// was just resolved from it) defaults to "open" (fail-open).
pub(super) async fn find_app_availability_mode(
    pool: &PgPool,
    organization_id: &str,
) -> Result<String> {
    let row: Option<(String,)> =
        sqlx::query_as(r#"SELECT app_availability_mode FROM organizations WHERE id = $1 LIMIT 1"#)
            .bind(organization_id)
            .fetch_optional(pool)
            .await
            .context("querying app availability mode")?;
    Ok(row.map_or_else(|| "open".to_string(), |(m,)| m))
}

/// Parity tests for the free direct-user twin: the licensed CTE's direct arm
/// and the free twin (`policy_engine::find_direct_user_principals`)
/// must stay
/// in lockstep — a divergence would make the unlicensed principal set drift
/// from the licensed one on the shared (free) direct-grant semantics. Gated on
/// `GATEWAY_TEST_DATABASE_URL` exactly like the other database suites.
///
/// LICENSED, and it lives here deliberately: it exercises the licensed CTE and
/// encodes the licensed group-inheritance semantics, so it belongs inside the
/// licensed crate. The free twin is reached through a DEV-dependency — a
/// test-only back-edge — so the production graph still runs one way
/// (policy-engine -> ee) and no free crate depends on licensed code to build.
#[cfg(test)]
mod parity_tests {
    use super::find_principal_set;
    use db::create_pool;
    use policy_engine::find_direct_user_principals;
    use sqlx::PgPool;

    async fn test_pool() -> Option<PgPool> {
        let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "GATEWAY_TEST_DATABASE_URL must be set in CI: the principal parity tests must not silently skip"
            );
            eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
            return None;
        };
        Some(create_pool(&url).await.expect("connect to test database"))
    }

    /// Delete every row this test's key owns, children before parents (same
    /// idempotent-reset pattern as the `crate::rbac` suite).
    async fn reset(pool: &PgPool, key: &str) {
        let like = format!("{key}%");
        for sql in [
            "DELETE FROM workspace_access WHERE workspace_id LIKE $1 OR user_id LIKE $1 OR group_id LIKE $1",
            "DELETE FROM group_members WHERE group_id LIKE $1 OR user_id LIKE $1",
            "DELETE FROM workspaces WHERE id LIKE $1",
            "DELETE FROM organization_members WHERE organization_id LIKE $1 OR user_id LIKE $1",
            "DELETE FROM groups WHERE id LIKE $1",
            "DELETE FROM users WHERE id LIKE $1",
            "DELETE FROM organizations WHERE id LIKE $1",
        ] {
            sqlx::query(sql)
                .bind(&like)
                .execute(pool)
                .await
                .expect("reset test rows");
        }
    }

    async fn seed_world(pool: &PgPool, k: &str) {
        let org = format!("{k}-org");
        sqlx::query(
            "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
        )
        .bind(&org)
        .execute(pool)
        .await
        .expect("insert org");
        sqlx::query(
            "INSERT INTO workspaces (id, organization_id, updated_at) VALUES ($1, $2, NOW())",
        )
        .bind(format!("{k}-ws"))
        .bind(&org)
        .execute(pool)
        .await
        .expect("insert workspace");
        for (user, status) in [
            ("direct", "active"),
            ("viagroup", "active"),
            ("suspended", "suspended"),
        ] {
            let uid = format!("{k}-{user}");
            sqlx::query("INSERT INTO users (id, email, external_auth_id, updated_at) VALUES ($1, $1, $1, NOW())")
                .bind(&uid).execute(pool).await.expect("insert user");
            sqlx::query(
                "INSERT INTO organization_members (organization_id, user_id, user_email, role, status) VALUES ($1, $2, $2, 'member', $3)",
            )
            .bind(&org).bind(&uid).bind(status).execute(pool).await.expect("insert member");
        }
        // The planted cross-org control: a user whose only ACTIVE membership
        // is a FOREIGN org, holding a direct grant on this workspace. The
        // membership join's org fence (`om.organization_id = $2`) is what
        // drops them — delete that fence in either resolver and the exact
        // list assertions below fail (mutation-test-every-guard).
        let xorg = format!("{k}-xorg");
        sqlx::query(
            "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
        )
        .bind(&xorg)
        .execute(pool)
        .await
        .expect("insert foreign org");
        let foreign = format!("{k}-foreign");
        sqlx::query("INSERT INTO users (id, email, external_auth_id, updated_at) VALUES ($1, $1, $1, NOW())")
            .bind(&foreign).execute(pool).await.expect("insert foreign user");
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, user_email, role, status) VALUES ($1, $2, $2, 'member', 'active')",
        )
        .bind(&xorg).bind(&foreign).execute(pool).await.expect("insert foreign member");
        // Direct user grants: the active direct user, the suspended user, and
        // the foreign-org user (who must never resolve).
        for user in ["direct", "suspended", "foreign"] {
            sqlx::query(
                "INSERT INTO workspace_access (id, workspace_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'member', NOW())",
            )
            .bind(format!("{k}-pa-{user}")).bind(format!("{k}-ws")).bind(format!("{k}-{user}"))
            .execute(pool).await.expect("bind user");
        }
        // A granted group whose member is `viagroup` — inherited, not direct.
        sqlx::query(
            "INSERT INTO groups (id, organization_id, name, updated_at) VALUES ($1, $2, $1, NOW())",
        )
        .bind(format!("{k}-grp"))
        .bind(&org)
        .execute(pool)
        .await
        .expect("insert group");
        sqlx::query(
            "INSERT INTO group_members (group_id, user_id, updated_at) VALUES ($1, $2, NOW())",
        )
        .bind(format!("{k}-grp"))
        .bind(format!("{k}-viagroup"))
        .execute(pool)
        .await
        .expect("add member");
        sqlx::query(
            "INSERT INTO workspace_access (id, workspace_id, group_id, updated_at) VALUES ($1, $2, $3, NOW())",
        )
        .bind(format!("{k}-pa-grp")).bind(format!("{k}-ws")).bind(format!("{k}-grp"))
        .execute(pool).await.expect("bind group");
    }

    /// The licensed CTE inherits through groups; the free twin resolves ONLY
    /// direct grants. Both must agree on the direct arm: active direct users
    /// in; suspended ones out; a foreign-org member with a stray direct grant
    /// out (the org fence — the exact-list assertions cover its deletion).
    #[tokio::test]
    async fn direct_arm_stays_in_lockstep_with_the_free_twin() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let k = "eeps1";
        reset(&pool, k).await;
        seed_world(&pool, k).await;
        let (ws, org) = (format!("{k}-ws"), format!("{k}-org"));

        let licensed = find_principal_set(&pool, &ws, &org).await.unwrap();
        let mut licensed_users = licensed.user_ids.clone();
        licensed_users.sort();
        // Licensed: direct + group-inherited, suspended excluded.
        assert_eq!(
            licensed_users,
            vec![format!("{k}-direct"), format!("{k}-viagroup")]
        );
        assert_eq!(licensed.group_ids, vec![format!("{k}-grp")]);

        let mut free = find_direct_user_principals(&pool, &ws, &org).await.unwrap();
        free.sort();
        // Free twin: the direct arm only — no group inheritance, and the same
        // suspension rule as the CTE's membership join.
        assert_eq!(free, vec![format!("{k}-direct")]);
    }

    /// With only direct grants in play the two resolvers must be IDENTICAL —
    /// this is the lockstep pin for the shared free semantics.
    #[tokio::test]
    async fn direct_only_world_resolves_identically() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let k = "eeps2";
        reset(&pool, k).await;
        let org = format!("{k}-org");
        sqlx::query(
            "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
        )
        .bind(&org)
        .execute(&pool)
        .await
        .expect("insert org");
        sqlx::query(
            "INSERT INTO workspaces (id, organization_id, updated_at) VALUES ($1, $2, NOW())",
        )
        .bind(format!("{k}-ws"))
        .bind(&org)
        .execute(&pool)
        .await
        .expect("insert workspace");
        let uid = format!("{k}-user");
        sqlx::query("INSERT INTO users (id, email, external_auth_id, updated_at) VALUES ($1, $1, $1, NOW())")
            .bind(&uid).execute(&pool).await.expect("insert user");
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, user_email, role, status) VALUES ($1, $2, $2, 'member', 'active')",
        )
        .bind(&org).bind(&uid).execute(&pool).await.expect("insert member");
        sqlx::query(
            "INSERT INTO workspace_access (id, workspace_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'member', NOW())",
        )
        .bind(format!("{k}-pa")).bind(format!("{k}-ws")).bind(&uid)
        .execute(&pool).await.expect("bind user");

        let (ws,) = (format!("{k}-ws"),);
        let licensed = find_principal_set(&pool, &ws, &org).await.unwrap();
        let free = find_direct_user_principals(&pool, &ws, &org).await.unwrap();
        assert_eq!(licensed.user_ids, free);
        assert!(licensed.group_ids.is_empty());
    }
}
