//! Shared fixtures for the proxy crate's Postgres-backed tests.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB tests:
//! skipped with a notice when unset locally, but MUST run in CI (fails loudly
//! otherwise).

use sqlx::PgPool;

pub(crate) async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the gateway proxy DB tests must not silently skip"
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

/// An organization row whose name and slug are its id.
pub(crate) async fn org(pool: &PgPool, id: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, now())",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}

/// A workspace row in `org`, named by its id.
pub(crate) async fn workspace(pool: &PgPool, id: &str, org: &str) {
    sqlx::query(
        "INSERT INTO workspaces (id, name, organization_id, updated_at) VALUES ($1, $1, $2, now())",
    )
    .bind(id)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
}
