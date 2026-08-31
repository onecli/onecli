//! Role-based access control (#66) — the API-key role rechecks.
//!
//! Covered by the OneCLI Enterprise License (this crate's `LICENSE`). These are
//! the licensed halves of API-key auth: the org-key admin/owner recheck and
//! the workspace-key access recheck (admin-or-binding). Both run only when
//! `enforce_key_rechecks` (shared, `context::auth`) enables them — cloud, or a
//! licensed self-host. The unconditional LIVENESS gates that every edition
//! checks (`user_is_active_org_member`, `user_can_access_workspace`) stay in
//! `db` — the free product depends on them.

use anyhow::{Context, Result};
use sqlx::PgPool;

/// Whether a workspace API key's user may still USE its workspace — re-checked on
/// every workspace-key auth so a key stops working once its user loses access
/// (demotion, suspension, removal, or an unshared workspace).
///
/// Named `manage` for historical reasons; it is really the workspace-key *usage*
/// gate, and it mirrors the web's `canAccessWorkspaceAsUser`
/// (`packages/api/src/middleware/auth/resolve.ts`) exactly: the user must be an
/// ACTIVE (non-suspended) member of the workspace's organization, and then either
/// an org admin/owner, or the holder of a `WorkspaceAccess` binding — directly
/// (`user_id`) or through a group they belong to. Bindings are the sole
/// per-workspace grant since step 13b; `created_by_user_id` is no longer read
/// (pure provenance), so a creator who is no longer an active member — suspended
/// or removed — is denied like anyone else. Runs only where
/// `enforce_key_rechecks` enables it: cloud, or a licensed self-host.
pub async fn user_can_manage_workspace(
    pool: &PgPool,
    user_id: &str,
    workspace_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        // Active-membership INNER JOIN is the suspension/removal gate (mirrors
        // `if (!role) return false`); then admin-or-binding. The two EXISTS are
        // the two `workspaceAccessBindingArms` — a direct user binding, or one via
        // a group the user is a member of.
        r#"SELECT p.id
           FROM workspaces p
           INNER JOIN organization_members om
             ON om.organization_id = p.organization_id
            AND om.user_id = $1
            AND om.status <> 'suspended'
           WHERE p.id = $2
             AND (
               om.role IN ('owner', 'admin')
               OR EXISTS (
                 SELECT 1 FROM workspace_access pa
                 WHERE pa.workspace_id = p.id AND pa.user_id = $1
               )
               OR EXISTS (
                 SELECT 1 FROM workspace_access pa
                 JOIN group_members gm ON gm.group_id = pa.group_id
                 WHERE pa.workspace_id = p.id AND gm.user_id = $1
               )
             )
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .context("verifying workspace-key user still has access to workspace")?;
    Ok(row.is_some())
}

/// Whether a user is an admin or owner of an organization. Re-checked on every
/// org-scoped API-key auth so the key stops working after a demotion or
/// suspension.
pub async fn user_is_org_admin(
    pool: &PgPool,
    user_id: &str,
    organization_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT user_id
           FROM organization_members
           WHERE user_id = $1 AND organization_id = $2
             AND role IN ('owner', 'admin')
             AND status <> 'suspended'
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await
    .context("verifying user is org admin")?;
    Ok(row.is_some())
}

// ── Workspace-key usage recheck (DB integration) ─────────────────────────────

/// Integration tests for the workspace-key usage recheck
/// (`crate::rbac::user_can_manage_workspace`, step 14) against a real
/// Postgres.
///
/// The recheck enforces on cloud and licensed self-hosts (see
/// `context::auth::enforce_key_rechecks`); these tests exercise the SQL itself,
/// so they run in every build. Gated on
/// `GATEWAY_TEST_DATABASE_URL` — skipped with a notice when it is unset, so
/// `cargo test` without a database still passes; CI sets it (against a
/// throwaway Postgres) and runs them for real. Each test owns a unique id
/// prefix and resets it first, so they are re-runnable and safe to run in
/// parallel.
/// The licensed role resolver, installed by the composition root when
/// [`context::auth::enforce_key_rechecks`] selects enforcement.
pub struct RbacRoleResolver;

#[async_trait::async_trait]
impl context::auth::RoleResolver for RbacRoleResolver {
    async fn user_is_org_admin(
        &self,
        pool: &sqlx::PgPool,
        user_id: &str,
        organization_id: &str,
    ) -> anyhow::Result<bool> {
        user_is_org_admin(pool, user_id, organization_id).await
    }

    async fn user_can_manage_workspace(
        &self,
        pool: &sqlx::PgPool,
        user_id: &str,
        workspace_id: &str,
    ) -> anyhow::Result<bool> {
        user_can_manage_workspace(pool, user_id, workspace_id).await
    }
}

#[cfg(test)]
mod workspace_access_recheck_tests {
    use super::{user_can_manage_workspace, user_is_org_admin};
    use db::create_pool;
    use sqlx::PgPool;

    async fn test_pool() -> Option<PgPool> {
        let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
            // Skipping is only for local runs without a database. In CI these
            // tests MUST run — a silent skip would let an access-control
            // regression through — so fail loudly if the URL wasn't wired up.
            assert!(
                std::env::var("CI").is_err(),
                "GATEWAY_TEST_DATABASE_URL must be set in CI: the workspace-access recheck tests must not silently skip"
            );
            eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
            return None;
        };
        Some(create_pool(&url).await.expect("connect to test database"))
    }

    /// Delete every row this test's key owns, children before parents, so the
    /// test is idempotent across local re-runs (CI starts from a fresh database).
    /// Keys are distinct 4-char prefixes (`s14a`..`s14k`) so no key is a prefix
    /// of another.
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

    async fn insert_org(pool: &PgPool, id: &str) {
        sqlx::query(
            "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
        )
        .bind(id)
        .execute(pool)
        .await
        .expect("insert org");
    }

    async fn insert_user(pool: &PgPool, id: &str) {
        sqlx::query(
            "INSERT INTO users (id, email, external_auth_id, updated_at) VALUES ($1, $1, $1, NOW())",
        )
        .bind(id)
        .execute(pool)
        .await
        .expect("insert user");
    }

    async fn insert_member(pool: &PgPool, org: &str, user: &str, role: &str, status: &str) {
        sqlx::query(
            "INSERT INTO organization_members (organization_id, user_id, user_email, role, status) \
             VALUES ($1, $2, $2, $3, $4)",
        )
        .bind(org)
        .bind(user)
        .bind(role)
        .bind(status)
        .execute(pool)
        .await
        .expect("insert member");
    }

    async fn insert_workspace(pool: &PgPool, id: &str, org: &str, created_by: Option<&str>) {
        sqlx::query(
            "INSERT INTO workspaces (id, organization_id, created_by_user_id, updated_at) \
             VALUES ($1, $2, $3, NOW())",
        )
        .bind(id)
        .bind(org)
        .bind(created_by)
        .execute(pool)
        .await
        .expect("insert workspace");
    }

    async fn bind_user(pool: &PgPool, workspace: &str, user: &str, role: &str) {
        sqlx::query(
            "INSERT INTO workspace_access (id, workspace_id, user_id, role, updated_at) \
             VALUES ($1, $2, $3, $4, NOW())",
        )
        .bind(format!("{workspace}-pa-{user}"))
        .bind(workspace)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .expect("bind user to workspace");
    }

    async fn insert_group(pool: &PgPool, id: &str, org: &str) {
        sqlx::query(
            "INSERT INTO groups (id, organization_id, name, updated_at) VALUES ($1, $2, $1, NOW())",
        )
        .bind(id)
        .bind(org)
        .execute(pool)
        .await
        .expect("insert group");
    }

    async fn add_group_member(pool: &PgPool, group: &str, user: &str) {
        sqlx::query(
            "INSERT INTO group_members (group_id, user_id, updated_at) VALUES ($1, $2, NOW())",
        )
        .bind(group)
        .bind(user)
        .execute(pool)
        .await
        .expect("add group member");
    }

    async fn bind_group(pool: &PgPool, workspace: &str, group: &str) {
        sqlx::query(
            "INSERT INTO workspace_access (id, workspace_id, group_id, updated_at) \
             VALUES ($1, $2, $3, NOW())",
        )
        .bind(format!("{workspace}-pa-{group}"))
        .bind(workspace)
        .bind(group)
        .execute(pool)
        .await
        .expect("bind group to workspace");
    }

    macro_rules! skip_without_db {
        () => {{
            let Some(pool) = test_pool().await else {
                eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
                return;
            };
            pool
        }};
    }

    // An active member holding a direct WorkspaceAccess binding → allowed.
    #[tokio::test]
    async fn active_member_with_direct_binding_is_allowed() {
        let pool = skip_without_db!();
        let k = "s14a";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "member", "active").await;
        insert_workspace(&pool, &proj, &org, None).await;
        bind_user(&pool, &proj, &user, "member").await;

        assert!(user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // An active member bound through a group they belong to → allowed.
    #[tokio::test]
    async fn active_member_with_group_binding_is_allowed() {
        let pool = skip_without_db!();
        let k = "s14b";
        let (org, user, proj, group) = (
            format!("{k}-org"),
            format!("{k}-user"),
            format!("{k}-ws"),
            format!("{k}-group"),
        );
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "member", "active").await;
        insert_workspace(&pool, &proj, &org, None).await;
        insert_group(&pool, &group, &org).await;
        add_group_member(&pool, &group, &user).await;
        bind_group(&pool, &proj, &group).await;

        assert!(user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // An org admin with no binding of any kind → allowed (the admin arm).
    #[tokio::test]
    async fn org_admin_without_binding_is_allowed() {
        let pool = skip_without_db!();
        let k = "s14c";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "admin", "active").await;
        insert_workspace(&pool, &proj, &org, None).await;

        assert!(user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // An active member with no binding and no admin role → denied.
    #[tokio::test]
    async fn active_member_without_binding_is_denied() {
        let pool = skip_without_db!();
        let k = "s14d";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "member", "active").await;
        insert_workspace(&pool, &proj, &org, None).await;

        assert!(!user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // A suspended member is denied even though a binding exists — suspension
    // beats the binding (the active-membership gate runs first).
    #[tokio::test]
    async fn suspended_member_with_binding_is_denied() {
        let pool = skip_without_db!();
        let k = "s14e";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "member", "suspended").await;
        insert_workspace(&pool, &proj, &org, None).await;
        bind_user(&pool, &proj, &user, "member").await;

        assert!(!user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // The step-14 tightening: a creator who is no longer a member (removed) is
    // denied — the old `created_by_user_id` door is gone.
    #[tokio::test]
    async fn removed_creator_is_denied() {
        let pool = skip_without_db!();
        let k = "s14f";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        // No membership row: the user created the workspace, then left the org.
        insert_workspace(&pool, &proj, &org, Some(&user)).await;

        assert!(!user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // Revocation: an active member's key stops validating the moment their
    // binding is removed.
    #[tokio::test]
    async fn revoked_binding_is_denied() {
        let pool = skip_without_db!();
        let k = "s14g";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "member", "active").await;
        insert_workspace(&pool, &proj, &org, None).await;
        bind_user(&pool, &proj, &user, "member").await;
        assert!(user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());

        sqlx::query("DELETE FROM workspace_access WHERE workspace_id = $1 AND user_id = $2")
            .bind(&proj)
            .bind(&user)
            .execute(&pool)
            .await
            .expect("revoke binding");

        assert!(!user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // Baseline / behavior-preservation: an active creator with the binding 13a
    // seeded for them (role "owner") is still allowed — usage is role-blind.
    #[tokio::test]
    async fn active_creator_with_seeded_binding_is_allowed() {
        let pool = skip_without_db!();
        let k = "s14h";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "member", "active").await;
        insert_workspace(&pool, &proj, &org, Some(&user)).await;
        bind_user(&pool, &proj, &user, "owner").await;

        assert!(user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // Security edge: a WorkspaceAccess binding never rescues a non-member. A stale
    // binding row with no active membership (a cross-org row, or one left behind
    // after removal) is denied by the active-membership gate — the binding is
    // consulted only for rows that survive the INNER JOIN.
    #[tokio::test]
    async fn binding_without_active_membership_is_denied() {
        let pool = skip_without_db!();
        let k = "s14i";
        let (org, user, proj) = (format!("{k}-org"), format!("{k}-user"), format!("{k}-ws"));
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        // No membership row for this user in the workspace's org.
        insert_workspace(&pool, &proj, &org, None).await;
        bind_user(&pool, &proj, &user, "member").await;

        assert!(!user_can_manage_workspace(&pool, &user, &proj)
            .await
            .unwrap());
    }

    // A binding is scoped to its workspace: holding one on workspace A does not grant
    // access to workspace B in the same org (the recheck correlates on workspace id).
    #[tokio::test]
    async fn binding_on_another_workspace_does_not_grant_access() {
        let pool = skip_without_db!();
        let k = "s14j";
        let (org, user, bound, other) = (
            format!("{k}-org"),
            format!("{k}-user"),
            format!("{k}-bound"),
            format!("{k}-other"),
        );
        reset(&pool, k).await;
        insert_org(&pool, &org).await;
        insert_user(&pool, &user).await;
        insert_member(&pool, &org, &user, "member", "active").await;
        insert_workspace(&pool, &bound, &org, None).await;
        insert_workspace(&pool, &other, &org, None).await;
        bind_user(&pool, &bound, &user, "member").await;

        // Bound workspace → allowed; the sibling workspace → denied.
        assert!(user_can_manage_workspace(&pool, &user, &bound)
            .await
            .unwrap());
        assert!(!user_can_manage_workspace(&pool, &user, &other)
            .await
            .unwrap());
    }

    // The org-key admin recheck: admin/owner pass; member, suspended-admin,
    // and non-member refuse. The suspended arm is the liveness-predicate
    // control (`status <> 'suspended'`), same law as the workspace recheck.
    #[tokio::test]
    async fn org_admin_recheck_requires_active_admin_or_owner() {
        let pool = skip_without_db!();
        let k = "s14k";
        reset(&pool, k).await;
        let org = format!("{k}-org");
        insert_org(&pool, &org).await;
        for (user, role, status) in [
            ("owner", "owner", "active"),
            ("admin", "admin", "active"),
            ("member", "member", "active"),
            ("susp", "admin", "suspended"),
        ] {
            let uid = format!("{k}-{user}");
            insert_user(&pool, &uid).await;
            insert_member(&pool, &org, &uid, role, status).await;
        }

        for (user, expected) in [
            ("owner", true),
            ("admin", true),
            ("member", false),
            ("susp", false),
            ("ghost", false), // never inserted — a non-member
        ] {
            assert_eq!(
                user_is_org_admin(&pool, &format!("{k}-{user}"), &org)
                    .await
                    .unwrap(),
                expected,
                "{user}"
            );
        }
    }
}
