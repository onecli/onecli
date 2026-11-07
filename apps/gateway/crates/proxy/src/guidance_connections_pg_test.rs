//! The connections an auth-failure guidance may point an agent at, against
//! REAL PostgreSQL: `db::find_guidance_connections` sees only the agent's own
//! workspace and its organization's shared accounts, of the asked providers,
//! connected, with the reconnect flag the guidance filters on. Another
//! workspace's or another organization's account is never seen.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB tests:
//!
//!   GATEWAY_TEST_DATABASE_URL=postgres://… cargo test -p proxy guidance_connections_pg

use db::{create_pool, find_guidance_connections, GuidanceConnectionRow};
use sqlx::PgPool;

const P: &str = "gwgd-";

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the guidance connection fence tests must not silently skip"
        );
        eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
        return None;
    };
    Some(create_pool(&url).await.expect("connect to test database"))
}

async fn reset(pool: &PgPool) {
    let like = format!("{P}%");
    for sql in [
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

/// One account of `provider`: workspace-scoped in `ws` when set, else
/// organization-scoped in `org`, written the way the API writes each.
struct Account<'a> {
    id: &'a str,
    provider: &'a str,
    ws: Option<&'a str>,
    org: &'a str,
    status: &'a str,
    reauth_required: bool,
}

async fn account(pool: &PgPool, a: Account<'_>) {
    let id = format!("{P}{}", a.id);
    sqlx::query(
        "INSERT INTO app_connections
           (id, scope, workspace_id, organization_id, provider, status, credentials,
            reauth_required_at, connected_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ciphertext',
                 CASE WHEN $7 THEN now() END, now(), now())",
    )
    .bind(&id)
    .bind(if a.ws.is_some() {
        "workspace"
    } else {
        "organization"
    })
    .bind(a.ws)
    // A workspace row carries no organization id (the API's scopeCreate).
    .bind(a.ws.is_none().then_some(a.org))
    .bind(a.provider)
    .bind(a.status)
    .bind(a.reauth_required)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn guidance_connections_pg_sees_only_the_agents_own_tenancy() {
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

    let live = |id, provider, ws, org| Account {
        id,
        provider,
        ws,
        org,
        status: "connected",
        reauth_required: false,
    };
    // Visible to an agent of ws-a1: its workspace's own, and org A's shared.
    account(&pool, live("own", "resend", Some(&ws_a1), &org_a)).await;
    account(&pool, live("shared", "resend", None, &org_a)).await;
    account(
        &pool,
        Account {
            reauth_required: true,
            ..live("stale", "resend", Some(&ws_a1), &org_a)
        },
    )
    .await;
    // Never visible: a sibling workspace's account, another organization's
    // (workspace and shared), a disconnected one, another provider's.
    account(&pool, live("sibling", "resend", Some(&ws_a2), &org_a)).await;
    account(&pool, live("foreign-ws", "resend", Some(&ws_b), &org_b)).await;
    account(&pool, live("foreign-org", "resend", None, &org_b)).await;
    account(
        &pool,
        Account {
            status: "disconnected",
            ..live("gone", "resend", Some(&ws_a1), &org_a)
        },
    )
    .await;
    account(&pool, live("other-app", "github", Some(&ws_a1), &org_a)).await;

    let rows = find_guidance_connections(&pool, &ws_a1, &org_a, &["resend"])
        .await
        .unwrap();
    let row = |id: &str, scope: &str, reauth_required| GuidanceConnectionRow {
        id: format!("{P}{id}"),
        provider: "resend".to_string(),
        scope: scope.to_string(),
        reauth_required,
    };
    let mut seen = rows.clone();
    seen.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(
        seen,
        vec![
            row("own", "workspace", false),
            row("shared", "organization", false),
            row("stale", "workspace", true),
        ]
    );

    // The other organization's agent sees only its own tenancy, never org A's.
    let rows = find_guidance_connections(&pool, &ws_b, &org_b, &["resend"])
        .await
        .unwrap();
    let mut ids: Vec<String> = rows.into_iter().map(|r| r.id).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![format!("{P}foreign-org"), format!("{P}foreign-ws")]
    );

    reset(&pool).await;
}
