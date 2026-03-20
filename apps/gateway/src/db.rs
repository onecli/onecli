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

/// An agent row from the `Agent` table.
#[derive(Debug, FromRow)]
pub(crate) struct AgentRow {
    pub id: String,
    #[sqlx(rename = "userId")]
    pub user_id: String,
    #[sqlx(rename = "secretMode")]
    pub secret_mode: String,
}

/// A secret row from the `Secret` table.
#[derive(Debug, FromRow)]
pub(crate) struct SecretRow {
    #[sqlx(rename = "type")]
    pub type_: String,
    #[sqlx(rename = "encryptedValue")]
    pub encrypted_value: String,
    #[sqlx(rename = "hostPattern")]
    pub host_pattern: String,
    #[sqlx(rename = "pathPattern")]
    pub path_pattern: Option<String>,
    #[sqlx(rename = "injectionConfig")]
    pub injection_config: Option<serde_json::Value>,
}

/// A policy rule row from the `PolicyRule` table.
#[derive(Debug, FromRow)]
pub(crate) struct PolicyRuleRow {
    #[sqlx(rename = "hostPattern")]
    pub host_pattern: String,
    #[sqlx(rename = "pathPattern")]
    pub path_pattern: Option<String>,
    pub method: Option<String>,
    #[sqlx(rename = "agentId")]
    pub agent_id: Option<String>,
}

/// A user row from the `User` table.
#[derive(Debug, FromRow)]
pub(crate) struct UserRow {
    pub id: String,
}

/// A vault connection row from the `VaultConnection` table.
#[derive(Debug, FromRow)]
#[allow(dead_code)]
pub(crate) struct VaultConnectionRow {
    pub id: String,
    #[sqlx(rename = "userId")]
    pub user_id: String,
    pub provider: String,
    pub name: Option<String>,
    pub status: String,
    #[sqlx(rename = "connectionData")]
    pub connection_data: Option<serde_json::Value>,
}

// ── Queries ─────────────────────────────────────────────────────────────

/// Look up a user by their external auth ID (e.g. OAuth `sub` claim or "local-admin").
pub(crate) async fn find_user_by_external_auth_id(
    pool: &PgPool,
    external_auth_id: &str,
) -> Result<Option<UserRow>> {
    sqlx::query_as::<_, UserRow>(r#"SELECT id FROM "User" WHERE "externalAuthId" = $1 LIMIT 1"#)
        .bind(external_auth_id)
        .fetch_optional(pool)
        .await
        .context("querying User by externalAuthId")
}

/// Look up an agent by its access token.
pub(crate) async fn find_agent_by_token(
    pool: &PgPool,
    access_token: &str,
) -> Result<Option<AgentRow>> {
    sqlx::query_as::<_, AgentRow>(
        r#"SELECT id, "userId", "secretMode" FROM "Agent" WHERE "accessToken" = $1 LIMIT 1"#,
    )
    .bind(access_token)
    .fetch_optional(pool)
    .await
    .context("querying Agent by accessToken")
}

/// Find all secrets for a given user.
pub(crate) async fn find_secrets_by_user(pool: &PgPool, user_id: &str) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT "type", "encryptedValue", "hostPattern", "pathPattern", "injectionConfig" FROM "Secret" WHERE "userId" = $1"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("querying Secrets by userId")
}

/// Find secrets assigned to a specific agent (selective mode).
pub(crate) async fn find_secrets_by_agent(pool: &PgPool, agent_id: &str) -> Result<Vec<SecretRow>> {
    sqlx::query_as::<_, SecretRow>(
        r#"SELECT s."type", s."encryptedValue", s."hostPattern", s."pathPattern", s."injectionConfig"
           FROM "Secret" s
           INNER JOIN "AgentSecret" as_ ON s.id = as_."secretId"
           WHERE as_."agentId" = $1"#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .context("querying Secrets by agentId")
}

/// Find all enabled policy rules for a given user.
pub(crate) async fn find_policy_rules_by_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<PolicyRuleRow>> {
    sqlx::query_as::<_, PolicyRuleRow>(
        r#"SELECT "hostPattern", "pathPattern", method, "agentId"
           FROM "PolicyRule"
           WHERE "userId" = $1 AND enabled = true AND action = 'block'"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("querying PolicyRules by userId")
}

// ── Vault connection queries ────────────────────────────────────────────

/// Find a vault connection for a user + provider pair.
pub(crate) async fn find_vault_connection(
    pool: &PgPool,
    user_id: &str,
    provider: &str,
) -> Result<Option<VaultConnectionRow>> {
    sqlx::query_as::<_, VaultConnectionRow>(
        r#"SELECT id, "userId", provider, name, status, "connectionData" FROM "VaultConnection" WHERE "userId" = $1 AND provider = $2 LIMIT 1"#,
    )
    .bind(user_id)
    .bind(provider)
    .fetch_optional(pool)
    .await
    .context("querying VaultConnection by userId + provider")
}

/// Upsert a vault connection (insert or update on userId + provider conflict).
pub(crate) async fn upsert_vault_connection(
    pool: &PgPool,
    user_id: &str,
    provider: &str,
    status: &str,
    connection_data: Option<&serde_json::Value>,
) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO "VaultConnection" (id, "userId", provider, status, "connectionData", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT ("userId", provider)
           DO UPDATE SET status = $3, "connectionData" = $4, "updatedAt" = NOW()"#,
    )
    .bind(user_id)
    .bind(provider)
    .bind(status)
    .bind(connection_data)
    .execute(pool)
    .await
    .context("upserting VaultConnection")?;
    Ok(())
}

/// Update only the connectionData JSON for an existing vault connection.
pub(crate) async fn update_vault_connection_data(
    pool: &PgPool,
    user_id: &str,
    provider: &str,
    connection_data: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        r#"UPDATE "VaultConnection" SET "connectionData" = $3, "updatedAt" = NOW() WHERE "userId" = $1 AND provider = $2"#,
    )
    .bind(user_id)
    .bind(provider)
    .bind(connection_data)
    .execute(pool)
    .await
    .context("updating VaultConnection connectionData")?;
    Ok(())
}

/// Delete a vault connection for a user + provider pair.
pub(crate) async fn delete_vault_connection(
    pool: &PgPool,
    user_id: &str,
    provider: &str,
) -> Result<()> {
    sqlx::query(r#"DELETE FROM "VaultConnection" WHERE "userId" = $1 AND provider = $2"#)
        .bind(user_id)
        .bind(provider)
        .execute(pool)
        .await
        .context("deleting VaultConnection")?;
    Ok(())
}
