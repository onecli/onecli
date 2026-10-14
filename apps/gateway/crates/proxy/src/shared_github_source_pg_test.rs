//! The borrowed signing key of a shared GitHub App connection against REAL
//! PostgreSQL: `db::find_source_connection_credentials` lends the source's
//! credentials only to a connection built on it in the same organization,
//! only while the source is a connected original, and never across an
//! organization boundary, however the link arose.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB tests:
//!
//!   GATEWAY_TEST_DATABASE_URL=postgres://… cargo test -p proxy shared_github_source_pg

use db::{create_pool, find_source_connection_credentials};
use sqlx::PgPool;

const P: &str = "gwshr-";

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the shared GitHub App source tests must not silently skip"
        );
        eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
        return None;
    };
    Some(create_pool(&url).await.expect("connect to test database"))
}

async fn reset(pool: &PgPool) {
    let like = format!("{P}%");
    for sql in [
        // Derived rows first: they reference their source.
        "DELETE FROM app_connections WHERE id LIKE $1 AND source_connection_id IS NOT NULL",
        "DELETE FROM app_connections WHERE id LIKE $1",
        "DELETE FROM workspaces WHERE id LIKE $1",
        "DELETE FROM organizations WHERE id LIKE $1",
    ] {
        sqlx::query(sql).bind(&like).execute(pool).await.unwrap();
    }
}

async fn org(pool: &PgPool, id: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, now())",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}

async fn workspace(pool: &PgPool, id: &str, org: &str) {
    sqlx::query(
        "INSERT INTO workspaces (id, name, organization_id, updated_at) VALUES ($1, $1, $2, now())",
    )
    .bind(id)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
}

/// A github-app connection: workspace-scoped when `ws` is set, else org-scoped
/// in `org`. `source` makes it a derived (shared) connection.
async fn connection(
    pool: &PgPool,
    id: &str,
    ws: Option<&str>,
    org: Option<&str>,
    source: Option<&str>,
    status: &str,
) {
    sqlx::query(
        "INSERT INTO app_connections
           (id, scope, workspace_id, organization_id, provider, status, credentials, source_connection_id, updated_at)
         VALUES ($1, $2, $3, $4, 'github-app', $5, $6, $7, now())",
    )
    .bind(id)
    .bind(if ws.is_some() { "workspace" } else { "organization" })
    .bind(ws)
    .bind(org)
    .bind(status)
    .bind(format!("ciphertext-of-{id}"))
    .bind(source)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn shared_github_source_pg_lends_the_key_only_inside_the_org() {
    let Some(pool) = test_pool().await else {
        return;
    };
    reset(&pool).await;
    let (org_a, org_b) = (format!("{P}org-a"), format!("{P}org-b"));
    let (ws_a1, ws_a2, ws_b) = (format!("{P}ws-a1"), format!("{P}ws-a2"), format!("{P}ws-b"));
    org(&pool, &org_a).await;
    org(&pool, &org_b).await;
    workspace(&pool, &ws_a1, &org_a).await;
    workspace(&pool, &ws_a2, &org_a).await;
    workspace(&pool, &ws_b, &org_b).await;

    // Originals: one in a workspace of org A, one at org A's level.
    let ws_source = format!("{P}src-ws");
    let org_source = format!("{P}src-org");
    connection(&pool, &ws_source, Some(&ws_a1), None, None, "connected").await;
    connection(&pool, &org_source, None, Some(&org_a), None, "connected").await;

    // Same org, other workspace, built on the workspace original: lent.
    let same_org = format!("{P}d-same");
    connection(
        &pool,
        &same_org,
        Some(&ws_a2),
        None,
        Some(&ws_source),
        "connected",
    )
    .await;
    assert_eq!(
        find_source_connection_credentials(&pool, &same_org)
            .await
            .unwrap()
            .as_deref(),
        Some(format!("ciphertext-of-{ws_source}").as_str())
    );

    // A workspace connection built on the org-level original: lent.
    let from_org = format!("{P}d-org");
    connection(
        &pool,
        &from_org,
        Some(&ws_a1),
        None,
        Some(&org_source),
        "connected",
    )
    .await;
    assert!(find_source_connection_credentials(&pool, &from_org)
        .await
        .unwrap()
        .is_some());

    // Planted cross-tenant link: a workspace of org B pointing at org A's
    // installation. The API never builds one; the gateway must not honor it.
    let foreign_ws = format!("{P}d-foreign-ws");
    connection(
        &pool,
        &foreign_ws,
        Some(&ws_b),
        None,
        Some(&ws_source),
        "connected",
    )
    .await;
    assert_eq!(
        find_source_connection_credentials(&pool, &foreign_ws)
            .await
            .unwrap(),
        None,
        "a source in another organization must never lend its key"
    );
    let foreign_org = format!("{P}d-foreign-org");
    connection(
        &pool,
        &foreign_org,
        None,
        Some(&org_b),
        Some(&org_source),
        "connected",
    )
    .await;
    assert_eq!(
        find_source_connection_credentials(&pool, &foreign_org)
            .await
            .unwrap(),
        None,
        "an org-level link across organizations must never lend a key"
    );

    // A disconnected source lends nothing.
    sqlx::query("UPDATE app_connections SET status = 'disconnected' WHERE id = $1")
        .bind(&ws_source)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        find_source_connection_credentials(&pool, &same_org)
            .await
            .unwrap(),
        None
    );

    reset(&pool).await;
}
