//! Shared v2 policy loaders. The org-scope rule set loads and enforces in
//! every edition (only its group-identity arm is licensed, and that degrades
//! in `enforce.rs`), and the direct-user principal resolver serves unlicensed
//! deployments. The licensed resolvers — the full principal-set CTE (group
//! grants + inherited members) and the app-availability queries — live in
//! `ee::principals`.

use anyhow::{Context, Result};
use sqlx::PgPool;

use db::{PolicyRuleV2Row, POLICY_V2_SELECT};

/// Active published organization-scope rules (max published generation),
/// first-match ordered.
pub async fn find_published_policy_rules_v2_by_org(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<PolicyRuleV2Row>> {
    sqlx::query_as::<_, PolicyRuleV2Row>(&format!(
        r#"{POLICY_V2_SELECT}
           WHERE r.organization_id = $1 AND r.scope = 'organization'
             AND r.status = 'published' AND r.enabled = true
             AND r.generation = (
               SELECT max(generation) FROM policy_rules_v2
               WHERE organization_id = $1 AND scope = 'organization'
                 AND status = 'published')
           ORDER BY r.priority, r.id"#
    ))
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("querying policy_rules_v2 by organization_id")
}

/// The unlicensed principal set: DIRECT WorkspaceAccess user grants only,
/// filtered to ACTIVE (non-suspended) members of the workspace's org.
/// Individual-user rule targeting is free; inheritance through directory
/// groups is licensed (#51) and resolved by the full CTE in
/// `ee::principals` instead — an unlicensed deployment never expands
/// groups, so group-bound rules cannot match and group-inherited members do
/// not count as user principals.
pub async fn find_direct_user_principals(
    pool: &PgPool,
    workspace_id: &str,
    organization_id: &str,
) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        // Keep in lockstep with the licensed CTE's direct-user arm: the org
        // fence is the membership join alone, and the liveness predicate is
        // `status <> 'suspended'` (NOT `= 'active'`). Parity is pinned by a
        // database test beside the CTE (`ee::principals`).
        r#"SELECT DISTINCT wa.user_id
           FROM workspace_access wa
           JOIN organization_members om
             ON om.user_id = wa.user_id
            AND om.organization_id = $2
            AND om.status <> 'suspended'
           WHERE wa.workspace_id = $1
             AND wa.user_id IS NOT NULL"#,
    )
    .bind(workspace_id)
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("resolving direct-user principal set")?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}
