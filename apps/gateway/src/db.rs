//! Direct database access via SQLx.
//!
//! Used when `DATABASE_URL` is set to query the PostgreSQL database directly,
//! bypassing the Next.js API. Vault connection state is managed by the gateway;
//! all other tables are read-only (Prisma / Next.js remains the writer).

use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::{FromRow, PgPool};

/// Create a PostgreSQL connection pool from `DATABASE_URL`.
pub(crate) async fn create_pool(database_url: &str) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await
        .context("connecting to PostgreSQL")
}

// ── Row types ───────────────────────────────────────────────────────────

/// An agent row from the `agents` table.
#[derive(Debug, FromRow)]
pub(crate) struct AgentRow {
    pub id: String,
    pub name: String,
    pub identifier: Option<String>,
    pub project_id: String,
    pub organization_id: String,
    pub secret_mode: String,
    pub subscription_status: String,
    pub policy_mode: String,
}

/// A secret row from the `secrets` table.
#[derive(Debug, FromRow)]
pub(crate) struct SecretRow {
    pub id: String,
    /// "project" | "organization" | "partner". Lets the budget layer identify the
    /// partner-tier credential by its actual scope — regardless of how the secret
    /// was resolved (inherited vs. selectively assigned to an agent). Read only by
    /// the cloud budget module (`BudgetSecret` impl), hence the cfg'd allow.
    #[cfg_attr(not(edition_cloud), allow(dead_code))]
    pub scope: String,
    #[sqlx(rename = "type")]
    pub type_: String,
    /// "inline" (value stored in `encrypted_value`) | "onepassword" (value
    /// resolved from `op_ref` via the 1Password connection at request time).
    pub value_source: String,
    /// Present for inline secrets; `None` for 1Password-sourced ones.
    pub encrypted_value: Option<String>,
    /// `op://vault/item/field` reference, set for 1Password-sourced secrets.
    pub op_ref: Option<String>,
    pub host_pattern: String,
    pub path_pattern: Option<String>,
    pub injection_config: Option<serde_json::Value>,
    pub metadata: Option<serde_json::Value>,
}

/// A policy rule row from the `policy_rules` table.
#[derive(Debug, FromRow)]
pub(crate) struct PolicyRuleRow {
    pub id: String,
    pub name: String,
    pub host_pattern: String,
    pub path_pattern: Option<String>,
    pub method: Option<String>,
    pub agent_id: Option<String>,
    pub action: String,
    pub rate_limit: Option<i32>,
    pub rate_limit_window: Option<String>,
    pub conditions: Option<serde_json::Value>,
}

/// A user row from the `users` table.
#[derive(Debug, FromRow)]
pub(crate) struct UserRow {
    pub id: String,
}

/// An API key row from the `api_keys` table (project-scoped).
#[derive(Debug, FromRow)]
pub(crate) struct ApiKeyRow {
    pub user_id: String,
    pub project_id: String,
}

/// An org-scoped API key row from the `api_keys` table.
#[cfg(edition_cloud)]
#[derive(Debug, FromRow)]
pub(crate) struct OrgApiKeyRow {
    pub user_id: String,
    pub organization_id: String,
}

/// A vault connection row from the `vault_connections` table.
#[derive(Debug, FromRow)]
#[allow(dead_code)]
pub(crate) struct VaultConnectionRow {
    pub id: String,
    pub provider: String,
    pub name: Option<String>,
    pub status: String,
    pub connection_data: Option<serde_json::Value>,
}

// ── Queries ─────────────────────────────────────────────────────────────

/// Look up a user by their external auth ID (e.g. OAuth `sub` claim or "local-admin").
pub(crate) async fn find_user_by_external_auth_id(
    pool: &PgPool,
    external_auth_id: &str,
) -> Result<Option<UserRow>> {
    sqlx::query_as::<_, UserRow>(r#"SELECT id FROM users WHERE external_auth_id = $1 LIMIT 1"#)
        .bind(external_auth_id)
        .fetch_optional(pool)
        .await
        .context("querying user by external_auth_id")
}

/// Find the default project ID for a user (OSS only).
///
/// Resolves user → first organization → first project in that organization.
/// Mirrors the web's `resolveUser()` (apps/web/src/lib/actions/resolve-user.ts).
///
/// OSS-only: the cloud edition is multi-project and never falls back to a
/// default project — it requires an explicit `X-Project-Id` and validates it
/// with [`user_can_access_project`]. Gating this `not(cloud)` makes that a
/// compile-time guarantee (a cloud caller fails to build).
#[cfg(not(edition_cloud))]
pub(crate) async fn find_default_project_id_by_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT p.id
           FROM organization_members om
           INNER JOIN projects p ON p.organization_id = om.organization_id
           WHERE om.user_id = $1
           ORDER BY om.created_at ASC, p.created_at ASC
           LIMIT 1"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .context("querying default project for user via organization_members")?;

    Ok(row.map(|(id,)| id))
}

/// Look up an API key (`oc_...`) and return its user_id and project_id.
pub(crate) async fn find_api_key(pool: &PgPool, key: &str) -> Result<Option<ApiKeyRow>> {
    sqlx::query_as::<_, ApiKeyRow>(
        r#"SELECT user_id, project_id FROM api_keys WHERE key = $1 LIMIT 1"#,
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .context("querying api_keys by key")
}

/// Look up an org-scoped API key (`oc_org_...`) and return its user_id and organization_id.
#[cfg(edition_cloud)]
pub(crate) async fn find_org_api_key(pool: &PgPool, key: &str) -> Result<Option<OrgApiKeyRow>> {
    sqlx::query_as::<_, OrgApiKeyRow>(
        r#"SELECT user_id, organization_id
           FROM api_keys
           WHERE key = $1 AND scope = 'organization' AND organization_id IS NOT NULL
           LIMIT 1"#,
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .context("querying org api_keys by key")
}

/// Verify that a project belongs to the given organization.
#[cfg(edition_cloud)]
pub(crate) async fn verify_project_in_org(
    pool: &PgPool,
    project_id: &str,
    organization_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> =
        sqlx::query_as(r#"SELECT id FROM projects WHERE id = $1 AND organization_id = $2 LIMIT 1"#)
            .bind(project_id)
            .bind(organization_id)
            .fetch_optional(pool)
            .await
            .context("verifying project belongs to organization")?;
    Ok(row.is_some())
}

/// Verify that a user may access a project — i.e. the project belongs to an
/// organization the user is a member of. Scopes cloud browser (Cognito)
/// requests to the `X-Project-Id` they specify instead of a default project.
#[cfg(edition_cloud)]
pub(crate) async fn user_can_access_project(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT p.id
           FROM organization_members om
           INNER JOIN projects p ON p.organization_id = om.organization_id
           WHERE om.user_id = $1 AND p.id = $2
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .context("verifying user has access to project")?;
    Ok(row.is_some())
}

/// Whether a user may manage a project — its creator, or an admin/owner of the
/// project's organization. Re-checked on every API-key auth so a key stops
/// working once its user loses access (e.g. demotion or removal). Cloud-only.
#[cfg(edition_cloud)]
pub(crate) async fn user_can_manage_project(
    pool: &PgPool,
    user_id: &str,
    project_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT p.id
           FROM projects p
           LEFT JOIN organization_members om
             ON om.organization_id = p.organization_id AND om.user_id = $1
           WHERE p.id = $2
             AND (p.created_by_user_id = $1 OR om.role IN ('owner', 'admin'))
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .context("verifying user can manage project")?;
    Ok(row.is_some())
}

/// Whether a user is an admin or owner of an organization. Re-checked on every
/// org-scoped API-key auth so the key stops working after a demotion. Cloud-only.
#[cfg(edition_cloud)]
pub(crate) async fn user_is_org_admin(
    pool: &PgPool,
    user_id: &str,
    organization_id: &str,
) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT user_id
           FROM organization_members
           WHERE user_id = $1 AND organization_id = $2
             AND role IN ('owner', 'admin')
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await
    .context("verifying user is org admin")?;
    Ok(row.is_some())
}

/// Look up an agent by its access token.
pub(crate) async fn find_agent_by_token(
    pool: &PgPool,
    access_token: &str,
) -> Result<Option<AgentRow>> {
    sqlx::query_as::<_, AgentRow>(
        r#"SELECT a.id, a.name, a.identifier, a.project_id, p.organization_id, a.secret_mode, o.subscription_status, o.policy_mode
           FROM agents a
           JOIN projects p ON a.project_id = p.id
           JOIN organizations o ON p.organization_id = o.id
           WHERE a.access_token = $1
           LIMIT 1"#,
    )
    .bind(access_token)
    .fetch_optional(pool)
    .await
    .context("querying agent by access_token")
}

/// Look up the organization ID for a project.
pub(crate) async fn find_organization_id_by_project(
    pool: &PgPool,
    project_id: &str,
) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as(r#"SELECT organization_id FROM projects WHERE id = $1 LIMIT 1"#)
            .bind(project_id)
            .fetch_optional(pool)
            .await
            .context("querying organization_id by project_id")?;
    Ok(row.map(|(oid,)| oid))
}

/// Find all secrets for a given project.
pub(crate) async fn find_secrets_by_project(
    pool: &PgPool,
    project_id: &str,
) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT id, scope, type, value_source, encrypted_value, op_ref, host_pattern, path_pattern, injection_config, metadata FROM secrets WHERE project_id = $1"#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by project_id")
}

/// Find secrets assigned to a specific agent (selective mode).
pub(crate) async fn find_secrets_by_agent(pool: &PgPool, agent_id: &str) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT s.id, s.scope, s.type, s.value_source, s.encrypted_value, s.op_ref, s.host_pattern, s.path_pattern, s.injection_config, s.metadata
           FROM secrets s
           INNER JOIN agent_secrets as_ ON s.id = as_.secret_id
           WHERE as_.agent_id = $1"#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by agent_id")
}

/// Find all organization-level secrets.
pub(crate) async fn find_secrets_by_org(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT id, scope, type, value_source, encrypted_value, op_ref, host_pattern, path_pattern, injection_config, metadata
           FROM secrets
           WHERE organization_id = $1 AND scope = 'organization'"#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by organization_id")
}

/// Update a secret's encrypted value (used for token refresh).
pub(crate) async fn update_secret_value(
    pool: &PgPool,
    secret_id: &str,
    encrypted_value: &str,
) -> Result<()> {
    sqlx::query(r#"UPDATE secrets SET encrypted_value = $1, updated_at = NOW() WHERE id = $2"#)
        .bind(encrypted_value)
        .bind(secret_id)
        .execute(pool)
        .await
        .context("updating secret encrypted value")?;
    Ok(())
}

/// Find all enabled policy rules for a given project.
pub(crate) async fn find_policy_rules_by_project(
    pool: &PgPool,
    project_id: &str,
) -> Result<Vec<PolicyRuleRow>> {
    sqlx::query_as::<_, PolicyRuleRow>(
        r#"SELECT id, name, host_pattern, path_pattern, method, agent_id,
                  action, rate_limit, rate_limit_window, conditions
           FROM policy_rules
           WHERE project_id = $1 AND enabled = true
             AND action IN ('block', 'rate_limit', 'manual_approval', 'allow')"#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .context("querying policy_rules by project_id")
}

/// Find all enabled organization-level policy rules.
pub(crate) async fn find_policy_rules_by_org(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<PolicyRuleRow>> {
    sqlx::query_as::<_, PolicyRuleRow>(
        r#"SELECT id, name, host_pattern, path_pattern, method, agent_id,
                  action, rate_limit, rate_limit_window, conditions
           FROM policy_rules
           WHERE organization_id = $1 AND scope = 'organization' AND enabled = true
             AND action IN ('block', 'rate_limit', 'manual_approval', 'allow')"#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("querying policy_rules by organization_id")
}

// ── App config queries (BYOC credentials) ─────────────────────────────

/// An app config row from the `app_configs` table.
#[derive(Debug, FromRow)]
pub(crate) struct AppConfigRow {
    pub settings: Option<serde_json::Value>,
    pub credentials: Option<String>,
}

/// Find an enabled BYOC app config for a project + provider.
pub(crate) async fn find_app_config(
    pool: &PgPool,
    project_id: &str,
    provider: &str,
) -> Result<Option<AppConfigRow>> {
    sqlx::query_as::<_, AppConfigRow>(
        r#"SELECT settings, credentials FROM app_configs
           WHERE project_id = $1 AND provider = $2 AND enabled = true
           LIMIT 1"#,
    )
    .bind(project_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying app_config by project_id + provider")
}

// ── App connection queries ─────────────────────────────────────────────

/// An app connection row from the `app_connections` table.
#[derive(Debug, Clone, PartialEq, FromRow, serde::Serialize, serde::Deserialize)]
pub(crate) struct AppConnectionRow {
    pub id: String,
    pub provider: String,
    pub credentials: Option<String>,
    pub label: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub session_policy: Option<serde_json::Value>,
}

/// Find all connected app connections for a given project.
pub(crate) async fn find_app_connections_by_project(
    pool: &PgPool,
    project_id: &str,
) -> Result<Vec<AppConnectionRow>> {
    sqlx::query_as::<_, AppConnectionRow>(
        r#"SELECT id, provider, credentials, label, metadata, NULL::jsonb AS session_policy FROM app_connections WHERE project_id = $1 AND status = 'connected'"#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .context("querying app_connections by project_id")
}

/// Find app connections assigned to a specific agent (selective mode).
pub(crate) async fn find_app_connections_by_agent(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Vec<AppConnectionRow>> {
    sqlx::query_as::<_, AppConnectionRow>(
        r#"SELECT ac.id, ac.provider, ac.credentials, ac.label, ac.metadata, aac.session_policy
           FROM app_connections ac
           INNER JOIN agent_app_connections aac ON ac.id = aac.app_connection_id
           WHERE aac.agent_id = $1 AND ac.status = 'connected'"#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .context("querying app_connections by agent_id")
}

/// Find all organization-level app connections.
pub(crate) async fn find_app_connections_by_org(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<AppConnectionRow>> {
    sqlx::query_as::<_, AppConnectionRow>(
        r#"SELECT id, provider, credentials, label, metadata, NULL::jsonb AS session_policy
           FROM app_connections
           WHERE organization_id = $1 AND scope = 'organization' AND status = 'connected'"#,
    )
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("querying app_connections by organization_id")
}

/// Update the encrypted credentials for an app connection (e.g., after token refresh).
pub(crate) async fn update_app_connection_credentials(
    pool: &PgPool,
    connection_id: &str,
    encrypted_credentials: &str,
) -> Result<()> {
    sqlx::query(r#"UPDATE app_connections SET credentials = $1 WHERE id = $2"#)
        .bind(encrypted_credentials)
        .bind(connection_id)
        .execute(pool)
        .await
        .context("updating app_connection credentials")?;
    Ok(())
}

// ── Vault connection queries ────────────────────────────────────────────

/// Find a vault connection for a project + provider pair.
pub(crate) async fn find_vault_connection(
    pool: &PgPool,
    project_id: &str,
    provider: &str,
) -> Result<Option<VaultConnectionRow>> {
    sqlx::query_as::<_, VaultConnectionRow>(
        r#"SELECT id, provider, name, status, connection_data FROM vault_connections WHERE project_id = $1 AND provider = $2 LIMIT 1"#,
    )
    .bind(project_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying vault_connection by project_id + provider")
}

/// Upsert a vault connection (insert or update on project_id + provider conflict).
pub(crate) async fn upsert_vault_connection(
    pool: &PgPool,
    project_id: &str,
    provider: &str,
    status: &str,
    connection_data: Option<&serde_json::Value>,
) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO vault_connections (id, project_id, provider, status, connection_data, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (project_id, provider)
           DO UPDATE SET status = $3, connection_data = $4, updated_at = NOW()"#,
    )
    .bind(project_id)
    .bind(provider)
    .bind(status)
    .bind(connection_data)
    .execute(pool)
    .await
    .context("upserting vault_connection")?;
    Ok(())
}

/// Update only the connection_data JSON for an existing vault connection.
pub(crate) async fn update_vault_connection_data(
    pool: &PgPool,
    project_id: &str,
    provider: &str,
    connection_data: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        r#"UPDATE vault_connections SET connection_data = $3, updated_at = NOW() WHERE project_id = $1 AND provider = $2"#,
    )
    .bind(project_id)
    .bind(provider)
    .bind(connection_data)
    .execute(pool)
    .await
    .context("updating vault_connection connection_data")?;
    Ok(())
}

/// Delete a vault connection for a project + provider pair.
pub(crate) async fn delete_vault_connection(
    pool: &PgPool,
    project_id: &str,
    provider: &str,
) -> Result<()> {
    sqlx::query(r#"DELETE FROM vault_connections WHERE project_id = $1 AND provider = $2"#)
        .bind(project_id)
        .bind(provider)
        .execute(pool)
        .await
        .context("deleting vault_connection")?;
    Ok(())
}
