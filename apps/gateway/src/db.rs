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
    pub account_id: String,
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

/// Find the account ID for a user (from account_members table).
pub(crate) async fn find_account_id_by_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as(r#"SELECT account_id FROM account_members WHERE user_id = $1 LIMIT 1"#)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .context("querying account_members by user_id")?;

    Ok(row.map(|(id,)| id))
}

/// Look up an agent by its access token.
pub(crate) async fn find_agent_by_token(
    pool: &PgPool,
    access_token: &str,
) -> Result<Option<AgentRow>> {
    sqlx::query_as::<_, AgentRow>(
        r#"SELECT id, account_id, secret_mode FROM agents WHERE access_token = $1 LIMIT 1"#,
    )
    .bind(access_token)
    .fetch_optional(pool)
    .await
    .context("querying agent by access_token")
}

/// Find all secrets for a given account.
pub(crate) async fn find_secrets_by_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT type, encrypted_value, host_pattern, path_pattern, injection_config FROM secrets WHERE account_id = $1"#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by account_id")
}

/// Find secrets assigned to a specific agent (selective mode).
pub(crate) async fn find_secrets_by_agent(pool: &PgPool, agent_id: &str) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT s.type, s.encrypted_value, s.host_pattern, s.path_pattern, s.injection_config
           FROM secrets s
           INNER JOIN agent_secrets as_ ON s.id = as_.secret_id
           WHERE as_.agent_id = $1"#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .context("querying secrets by agent_id")
}

/// Find all enabled policy rules for a given account.
pub(crate) async fn find_policy_rules_by_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<PolicyRuleRow>> {
    sqlx::query_as::<_, PolicyRuleRow>(
        r#"SELECT id, host_pattern, path_pattern, method, agent_id,
                  action, rate_limit, rate_limit_window
           FROM policy_rules
           WHERE account_id = $1 AND enabled = true
             AND action IN ('block', 'rate_limit')"#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .context("querying policy_rules by account_id")
}

// ── Vault connection queries ────────────────────────────────────────────

/// Find a vault connection for an account + provider pair.
pub(crate) async fn find_vault_connection(
    pool: &PgPool,
    account_id: &str,
    provider: &str,
) -> Result<Option<VaultConnectionRow>> {
    sqlx::query_as::<_, VaultConnectionRow>(
        r#"SELECT id, provider, name, status, connection_data FROM vault_connections WHERE account_id = $1 AND provider = $2 LIMIT 1"#,
    )
    .bind(account_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying vault_connection by account_id + provider")
}

/// Upsert a vault connection (insert or update on account_id + provider conflict).
pub(crate) async fn upsert_vault_connection(
    pool: &PgPool,
    account_id: &str,
    provider: &str,
    status: &str,
    connection_data: Option<&serde_json::Value>,
) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO vault_connections (id, account_id, provider, status, connection_data, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (account_id, provider)
           DO UPDATE SET status = $3, connection_data = $4, updated_at = NOW()"#,
    )
    .bind(account_id)
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
    account_id: &str,
    provider: &str,
    connection_data: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        r#"UPDATE vault_connections SET connection_data = $3, updated_at = NOW() WHERE account_id = $1 AND provider = $2"#,
    )
    .bind(account_id)
    .bind(provider)
    .bind(connection_data)
    .execute(pool)
    .await
    .context("updating vault_connection connection_data")?;
    Ok(())
}

/// Delete a vault connection for an account + provider pair.
pub(crate) async fn delete_vault_connection(
    pool: &PgPool,
    account_id: &str,
    provider: &str,
) -> Result<()> {
    sqlx::query(r#"DELETE FROM vault_connections WHERE account_id = $1 AND provider = $2"#)
        .bind(account_id)
        .bind(provider)
        .execute(pool)
        .await
        .context("deleting vault_connection")?;
    Ok(())
}
