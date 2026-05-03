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
    pub secret_mode: String,
}

/// A secret row from the `secrets` table.
#[derive(Debug, FromRow)]
pub(crate) struct SecretRow {
    #[sqlx(rename = "type")]
    pub type_: String,
    pub encrypted_value: String,
    pub host_pattern: String,
    pub path_pattern: Option<String>,
    pub injection_config: Option<serde_json::Value>,
    pub is_platform: bool,
}

/// A policy rule row from the `policy_rules` table.
#[derive(Debug, FromRow)]
pub(crate) struct PolicyRuleRow {
    pub id: String,
    pub host_pattern: String,
    pub path_pattern: Option<String>,
    pub method: Option<String>,
    pub agent_id: Option<String>,
    pub action: String,
    pub rate_limit: Option<i32>,
    pub rate_limit_window: Option<String>,
}

/// A user row from the `users` table.
#[derive(Debug, FromRow)]
pub(crate) struct UserRow {
    pub id: String,
}

/// An API key row from the `api_keys` table.
#[derive(Debug, FromRow)]
pub(crate) struct ApiKeyRow {
    pub user_id: String,
    pub project_id: String,
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

/// Find the default project ID for a user.
///
/// Resolves user → first organization → first project in that organization.
/// Mirrors the web's `resolveUser()` (apps/web/src/lib/actions/resolve-user.ts).
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

/// Look up an agent by its access token.
pub(crate) async fn find_agent_by_token(
    pool: &PgPool,
    access_token: &str,
) -> Result<Option<AgentRow>> {
    sqlx::query_as::<_, AgentRow>(
        r#"SELECT id, name, identifier, project_id, secret_mode FROM agents WHERE access_token = $1 LIMIT 1"#,
    )
    .bind(access_token)
    .fetch_optional(pool)
    .await
    .context("querying agent by access_token")
}

/// Find all secrets for a given project.
pub(crate) async fn find_secrets_by_project(
    pool: &PgPool,
    project_id: &str,
) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT type, encrypted_value, host_pattern, path_pattern, injection_config, is_platform FROM secrets WHERE project_id = $1"#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by project_id")
}

/// Find secrets assigned to a specific agent (selective mode).
pub(crate) async fn find_secrets_by_agent(pool: &PgPool, agent_id: &str) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT s.type, s.encrypted_value, s.host_pattern, s.path_pattern, s.injection_config, s.is_platform
           FROM secrets s
           INNER JOIN agent_secrets as_ ON s.id = as_.secret_id
           WHERE as_.agent_id = $1"#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by agent_id")
}

/// Find all enabled policy rules for a given project.
pub(crate) async fn find_policy_rules_by_project(
    pool: &PgPool,
    project_id: &str,
) -> Result<Vec<PolicyRuleRow>> {
    sqlx::query_as::<_, PolicyRuleRow>(
        r#"SELECT id, host_pattern, path_pattern, method, agent_id,
                  action, rate_limit, rate_limit_window
           FROM policy_rules
           WHERE project_id = $1 AND enabled = true
             AND action IN ('block', 'rate_limit', 'manual_approval')"#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .context("querying policy_rules by project_id")
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
}

/// Find all connected app connections for a given project.
pub(crate) async fn find_app_connections_by_project(
    pool: &PgPool,
    project_id: &str,
) -> Result<Vec<AppConnectionRow>> {
    sqlx::query_as::<_, AppConnectionRow>(
        r#"SELECT id, provider, credentials, label, metadata FROM app_connections WHERE project_id = $1 AND status = 'connected'"#,
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
        r#"SELECT ac.id, ac.provider, ac.credentials, ac.label, ac.metadata
           FROM app_connections ac
           INNER JOIN agent_app_connections aac ON ac.id = aac.app_connection_id
           WHERE aac.agent_id = $1 AND ac.status = 'connected'"#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .context("querying app_connections by agent_id")
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

/// Check if the trial budget for the project's owner is exhausted.
pub(crate) async fn is_trial_budget_blocked(pool: &PgPool, project_id: &str) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT tb.status
           FROM trial_budgets tb
           INNER JOIN organization_members om ON om.user_id = tb.user_id
           INNER JOIN projects p ON p.organization_id = om.organization_id
           WHERE p.id = $1 AND tb.status = 'exhausted'
           LIMIT 1"#,
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .context("checking trial budget status")?;
    Ok(row.is_some())
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
