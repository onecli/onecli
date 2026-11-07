//! Vendor OAuth client groups against REAL PostgreSQL: the gateway's actual
//! `db::find_app_config*` queries, fed the actual `apps::config_keys_for`
//! keys, resolve a shared `google` / `atlassian` row for member apps, prefer a
//! legacy per-app row, and refuse a cross-vendor provenance link.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB tests:
//!
//!   GATEWAY_TEST_DATABASE_URL=postgres://… cargo test -p proxy byoc_groups_pg

use db::{create_pool, find_app_config, find_app_config_by_connection, find_app_config_by_org};
use sqlx::PgPool;

const P: &str = "gwgrp-";

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the gateway BYOC group tests must not silently skip"
        );
        eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
        return None;
    };
    Some(create_pool(&url).await.expect("connect to test database"))
}

fn client_id(row: Option<db::AppConfigRow>) -> Option<String> {
    row?.settings?.get("clientId")?.as_str().map(str::to_string)
}

async fn seed(pool: &PgPool) {
    let org = format!("{P}org");
    let (ws_a, ws_b) = (format!("{P}ws-a"), format!("{P}ws-b"));
    for sql in [
        "DELETE FROM app_connections WHERE id LIKE 'gwgrp-%'",
        "DELETE FROM app_configs WHERE id LIKE 'gwgrp-%'",
        "DELETE FROM workspaces WHERE id LIKE 'gwgrp-%'",
        "DELETE FROM organizations WHERE id LIKE 'gwgrp-%'",
    ] {
        sqlx::query(sql).execute(pool).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, now())",
    )
    .bind(&org)
    .execute(pool)
    .await
    .unwrap();
    for ws in [&ws_a, &ws_b] {
        sqlx::query(
            "INSERT INTO workspaces (id, name, organization_id, updated_at) VALUES ($1, $1, $2, now())",
        )
        .bind(ws)
        .bind(&org)
        .execute(pool)
        .await
        .unwrap();
    }
    let cfg =
        |id: &str, scope: &str, ws: Option<&str>, org: Option<&str>, provider: &str, cid: &str| {
            (
                id.to_string(),
                scope.to_string(),
                ws.map(str::to_string),
                org.map(str::to_string),
                provider.to_string(),
                serde_json::json!({ "clientId": cid }),
            )
        };
    for (id, scope, ws, o, provider, settings) in [
        cfg(
            "gwgrp-org-google",
            "organization",
            None,
            Some(&org),
            "google",
            "org-google",
        ),
        cfg(
            "gwgrp-org-atl",
            "organization",
            None,
            Some(&org),
            "atlassian",
            "org-atl",
        ),
        cfg(
            "gwgrp-wsa-google",
            "workspace",
            Some(&ws_a),
            None,
            "google",
            "ws-a-google",
        ),
        cfg(
            "gwgrp-wsb-gmail",
            "workspace",
            Some(&ws_b),
            None,
            "gmail",
            "ws-b-legacy-gmail",
        ),
    ] {
        sqlx::query(
            "INSERT INTO app_configs (id, scope, workspace_id, organization_id, provider, enabled, settings, credentials, updated_at)
             VALUES ($1, $2, $3, $4, $5, true, $6, 'enc', now())",
        )
        .bind(id)
        .bind(scope)
        .bind(ws)
        .bind(o)
        .bind(provider)
        .bind(settings)
        .execute(pool)
        .await
        .unwrap();
    }
    for (id, provider, cfg_id) in [
        ("gwgrp-conn-drive", "google-drive", "gwgrp-org-google"),
        ("gwgrp-conn-gmail-bad", "gmail", "gwgrp-org-atl"),
    ] {
        sqlx::query(
            "INSERT INTO app_connections (id, provider, scope, workspace_id, app_config_id, status, updated_at)
             VALUES ($1, $2, 'workspace', $3, $4, 'connected', now())",
        )
        .bind(id)
        .bind(provider)
        .bind(&ws_b)
        .bind(cfg_id)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// One test (not two) so the shared `gwgrp-` seed is never raced by a
/// parallel test reseeding it.
#[tokio::test]
async fn byoc_groups_pg() {
    let Some(pool) = test_pool().await else {
        return;
    };
    seed(&pool).await;
    let org = format!("{P}org");

    // Org Google client serves any Google app.
    for app in ["gmail", "google-drive", "youtube"] {
        let keys = apps::config_keys_for(app);
        assert_eq!(
            client_id(find_app_config_by_org(&pool, &org, &keys).await.unwrap()).as_deref(),
            Some("org-google"),
            "{app}"
        );
    }
    // Atlassian client serves Jira and Confluence.
    for app in ["jira", "confluence"] {
        let keys = apps::config_keys_for(app);
        assert_eq!(
            client_id(find_app_config_by_org(&pool, &org, &keys).await.unwrap()).as_deref(),
            Some("org-atl")
        );
    }
    // Workspace A's Google override serves every Google app in A.
    let keys = apps::config_keys_for("google-calendar");
    assert_eq!(
        client_id(
            find_app_config(&pool, &format!("{P}ws-a"), &keys)
                .await
                .unwrap()
        )
        .as_deref(),
        Some("ws-a-google")
    );
    // Workspace B has only a legacy gmail row: it serves gmail, not Drive.
    let ws_b = format!("{P}ws-b");
    assert_eq!(
        client_id(
            find_app_config(&pool, &ws_b, &apps::config_keys_for("gmail"))
                .await
                .unwrap()
        )
        .as_deref(),
        Some("ws-b-legacy-gmail")
    );
    assert_eq!(
        client_id(
            find_app_config(&pool, &ws_b, &apps::config_keys_for("google-drive"))
                .await
                .unwrap()
        ),
        None
    );

    // A Drive connection minted by the org's Google client refreshes with it.
    let keys = apps::config_keys_for("google-drive");
    assert_eq!(
        client_id(
            find_app_config_by_connection(&pool, "gwgrp-conn-drive", &keys)
                .await
                .unwrap()
        )
        .as_deref(),
        Some("org-google")
    );
    // A Gmail connection mislinked to the Atlassian row is refused.
    let keys = apps::config_keys_for("gmail");
    assert_eq!(
        client_id(
            find_app_config_by_connection(&pool, "gwgrp-conn-gmail-bad", &keys)
                .await
                .unwrap()
        ),
        None
    );
}
