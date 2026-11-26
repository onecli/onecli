//! Shared fixtures for the vault crate's Postgres-backed tests.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB tests:
//! skipped with a notice when unset locally, but MUST run in CI (fails loudly
//! otherwise). Each test owns a unique id prefix and resets it first, so the
//! tests are re-runnable and safe to run in parallel.

use std::sync::Arc;

use crypto::CryptoService;
use sqlx::PgPool;

pub(crate) async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        // Skipping is only for local runs without a database. In CI these
        // tests MUST run — a silent skip would let a revocation regression
        // through — so fail loudly if the URL wasn't wired up.
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the vault session tests must not silently skip"
        );
        eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
        return None;
    };
    Some(
        db::create_pool(&url)
            .await
            .expect("connect to test database"),
    )
}

/// A fresh org + workspace owned by `key`; returns the workspace id. Rows from
/// a previous run of the same test are removed first.
pub(crate) async fn seed_workspace(pool: &PgPool, key: &str) -> String {
    let like = format!("{key}%");
    for sql in [
        "DELETE FROM vault_connections WHERE workspace_id LIKE $1",
        "DELETE FROM workspaces WHERE id LIKE $1",
        "DELETE FROM organizations WHERE id LIKE $1",
    ] {
        sqlx::query(sql)
            .bind(&like)
            .execute(pool)
            .await
            .expect("reset test rows");
    }

    let org = format!("{key}-org");
    let workspace = format!("{key}-ws");
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
    )
    .bind(&org)
    .execute(pool)
    .await
    .expect("insert org");
    sqlx::query("INSERT INTO workspaces (id, organization_id, updated_at) VALUES ($1, $2, NOW())")
        .bind(&workspace)
        .bind(&org)
        .execute(pool)
        .await
        .expect("insert workspace");
    workspace
}

/// Local AES with a random key — the self-host crypto backend.
pub(crate) fn test_crypto() -> Arc<CryptoService> {
    use base64::Engine;
    use ring::rand::{SecureRandom, SystemRandom};
    let mut key = [0u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .expect("generate random key");
    let key_b64 = base64::engine::general_purpose::STANDARD.encode(key);
    Arc::new(CryptoService::from_base64_key(&key_b64).expect("create test crypto"))
}
