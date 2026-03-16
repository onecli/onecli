//! Direct database access via SQLx.
//!
//! Used when `DATABASE_URL` is set to query the PostgreSQL database directly,
//! bypassing the Next.js API. The gateway is read-only — Prisma (Next.js)
//! remains the sole writer.

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
    #[allow(dead_code)]
    pub id: String,
    #[sqlx(rename = "userId")]
    pub user_id: String,
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

/// A user row from the `User` table.
#[derive(Debug, FromRow)]
pub(crate) struct UserRow {
    pub id: String,
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
        r#"SELECT id, "userId" FROM "Agent" WHERE "accessToken" = $1 LIMIT 1"#,
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
