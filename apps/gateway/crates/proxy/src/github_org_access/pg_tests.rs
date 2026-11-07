//! The per-organization GitHub access record against a real Postgres: what
//! `forward` writes when an organization refuses the GitHub OAuth connection,
//! and clears once the refused endpoint answers again.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB suites:
//! skipped locally when unset, required in CI. Each test seeds its own rows
//! under a random id and deletes them on drop.

use serde_json::{json, Value};
use sqlx::PgPool;

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the gateway DB tests must not silently skip"
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

struct World {
    pool: PgPool,
    org_id: String,
    connection_id: String,
}

impl World {
    async fn seed(pool: PgPool, metadata: Value) -> Self {
        let tag = format!("goa-{}", uuid::Uuid::new_v4().simple());
        let org_id = format!("{tag}-org");
        let workspace_id = format!("{tag}-ws");
        let connection_id = format!("{tag}-conn");
        sqlx::query(
            "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ($1, $1, $1, now(), now())",
        )
        .bind(&org_id)
        .execute(&pool)
        .await
        .expect("seed org");
        sqlx::query(
            "INSERT INTO workspaces (id, organization_id, created_at, updated_at) VALUES ($1, $2, now(), now())",
        )
        .bind(&workspace_id)
        .bind(&org_id)
        .execute(&pool)
        .await
        .expect("seed workspace");
        sqlx::query(
            "INSERT INTO app_connections (id, workspace_id, provider, status, scope, metadata, updated_at)
             VALUES ($1, $2, 'github', 'connected', 'workspace', $3, now())",
        )
        .bind(&connection_id)
        .bind(&workspace_id)
        .bind(metadata)
        .execute(&pool)
        .await
        .expect("seed connection");
        Self {
            pool,
            org_id,
            connection_id,
        }
    }

    async fn metadata(&self) -> Value {
        sqlx::query_scalar::<_, Option<Value>>("SELECT metadata FROM app_connections WHERE id = $1")
            .bind(&self.connection_id)
            .fetch_one(&self.pool)
            .await
            .expect("read metadata")
            .unwrap_or(Value::Null)
    }

    async fn record(&self, org: &str, entry: &Value) -> bool {
        db::record_github_org_access(&self.pool, &self.connection_id, org, entry)
            .await
            .expect("record")
    }

    async fn clear(&self, org: &str, expected: &Value) -> bool {
        db::clear_github_org_access(&self.pool, &self.connection_id, org, expected)
            .await
            .expect("clear")
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let pool = self.pool.clone();
        let org_id = self.org_id.clone();
        // Neither foreign key cascades, so the rows go child-first.
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async move {
                let _ = sqlx::query("DELETE FROM app_connections WHERE workspace_id IN (SELECT id FROM workspaces WHERE organization_id = $1)")
                    .bind(&org_id)
                    .execute(&pool)
                    .await;
                let _ = sqlx::query("DELETE FROM workspaces WHERE organization_id = $1")
                    .bind(&org_id)
                    .execute(&pool)
                    .await;
                let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
                    .bind(&org_id)
                    .execute(&pool)
                    .await;
            });
        });
    }
}

fn entry(reason: &str, endpoint: &str) -> Value {
    json!({ "reason": reason, "write": false, "endpoint": endpoint })
}

#[tokio::test(flavor = "multi_thread")]
async fn records_per_org_keeps_other_metadata_and_clears() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let world = World::seed(pool, json!({ "username": "octo", "name": "Octo" })).await;
    let acme = entry("approval_required", "repos/acme/api/pulls");
    let beta = entry("sso_required", "orgs/beta/members");

    // First sighting writes; the profile metadata survives.
    assert!(world.record("acme", &acme).await);
    let md = world.metadata().await;
    assert_eq!(md["username"], "octo");
    assert_eq!(md["githubOrgAccess"]["acme"], acme);

    // The same refusal again rewrites nothing.
    assert!(!world.record("acme", &acme).await);

    // A second organization sits beside the first; a changed entry updates.
    assert!(world.record("beta", &beta).await);
    let acme_sso = entry("sso_required", "repos/acme/api/pulls");
    assert!(world.record("acme", &acme_sso).await);
    let md = world.metadata().await;
    assert_eq!(md["githubOrgAccess"]["acme"], acme_sso);
    assert_eq!(md["githubOrgAccess"]["beta"], beta);

    // Clearing one keeps the other; clearing the last drops the key.
    assert!(world.clear("acme", &acme_sso).await);
    assert!(!world.clear("acme", &acme_sso).await);
    let md = world.metadata().await;
    assert!(md["githubOrgAccess"].get("acme").is_none());
    assert_eq!(md["githubOrgAccess"]["beta"], beta);
    assert!(world.clear("beta", &beta).await);
    let md = world.metadata().await;
    assert!(md.get("githubOrgAccess").is_none());
    assert_eq!(md["username"], "octo");
}

/// The clear is a compare-and-delete: a refusal recorded after the proof was
/// read (another endpoint refused meanwhile) is not wiped by that proof.
#[tokio::test(flavor = "multi_thread")]
async fn a_clear_never_drops_a_newer_refusal() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let world = World::seed(pool, json!({})).await;
    let proven = entry("approval_required", "repos/acme/api/pulls");
    let newer = entry("approval_required", "repos/acme/api/issues");
    assert!(world.record("acme", &proven).await);
    assert!(world.record("acme", &newer).await);
    assert!(
        !world.clear("acme", &proven).await,
        "the stored entry moved on"
    );
    assert_eq!(world.metadata().await["githubOrgAccess"]["acme"], newer);
}

#[tokio::test(flavor = "multi_thread")]
async fn tracks_at_most_fifty_orgs() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let world = World::seed(pool, json!({})).await;
    let sso = json!({ "reason": "sso_required", "write": false });
    for i in 0..50 {
        assert!(world.record(&format!("org{i}"), &sso).await);
    }
    assert!(
        !world.record("org50", &sso).await,
        "a 51st organization is not recorded"
    );
    assert!(
        world
            .record(
                "org0",
                &json!({ "reason": "approval_required", "write": false })
            )
            .await,
        "an existing organization can still change at the cap"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn records_on_null_metadata_and_skips_disconnected() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let world = World::seed(pool.clone(), Value::Null).await;
    let sso = json!({ "reason": "sso_required", "write": false });
    assert!(world.record("acme", &sso).await);
    assert_eq!(world.metadata().await["githubOrgAccess"]["acme"], sso);

    sqlx::query("UPDATE app_connections SET status = 'disconnected' WHERE id = $1")
        .bind(&world.connection_id)
        .execute(&pool)
        .await
        .expect("disconnect");
    assert!(
        !world.record("beta", &sso).await,
        "a disconnected connection is never written"
    );
}
