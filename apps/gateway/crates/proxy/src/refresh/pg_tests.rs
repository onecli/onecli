//! The refresh-token spend against a real Postgres: two engines with their own
//! pools and gates stand in for two gateway instances sharing one database,
//! and a local token endpoint plays a provider that rotates refresh tokens and
//! revokes the grant on reuse. That is the GitLab/Atlassian behaviour that made
//! the old read → refresh → overwrite path break connections.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB suites:
//! skipped locally when unset, required in CI. Each test seeds its own rows
//! under a random id and deletes them when its fixture drops (on a failed
//! assertion too), so the suite needs nothing but a migrated database.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Form, Json, Router};
use serde_json::{json, Value};
use sqlx::PgPool;

use super::{refresh_oauth_token, OAuthRefresh, RefreshOutcome};
use crate::connect::PolicyEngine;

// ── The fake provider ────────────────────────────────────────────────────

/// A token endpoint with GitLab's semantics: each refresh token is accepted
/// once; presenting a spent one is `invalid_grant` and revokes the family.
#[derive(Default)]
struct Provider {
    calls: AtomicUsize,
    live: Mutex<Option<String>>,
    spent: Mutex<HashSet<String>>,
    revoked: Mutex<bool>,
    delay: Mutex<Duration>,
    /// Answer every exchange with a transient 503, whatever the token.
    outage: Mutex<bool>,
}

impl Provider {
    fn with_live(token: &str) -> Arc<Self> {
        let p = Self::default();
        *p.live.lock().expect("lock") = Some(token.to_string());
        Arc::new(p)
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn revoked(&self) -> bool {
        *self.revoked.lock().expect("lock")
    }
}

async fn token_endpoint(
    State(p): State<Arc<Provider>>,
    Form(form): Form<std::collections::HashMap<String, String>>,
) -> (axum::http::StatusCode, Json<Value>) {
    let n = p.calls.fetch_add(1, Ordering::SeqCst) + 1;
    let delay = *p.delay.lock().expect("lock");
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    // Only the workspace's own OAuth client may exchange: the pair `World::seed`
    // stores in the app config. Every success below therefore also proves the
    // refresh resolved that config (inside the lock) and sent its pair.
    if form.get("client_id").map(String::as_str) != Some("test-client")
        || form.get("client_secret").map(String::as_str) != Some("test-secret")
    {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid_client" })),
        );
    }
    if *p.outage.lock().expect("lock") {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "temporarily_unavailable" })),
        );
    }
    let presented = form.get("refresh_token").cloned().unwrap_or_default();
    let mut live = p.live.lock().expect("lock");
    let mut spent = p.spent.lock().expect("lock");
    if *p.revoked.lock().expect("lock") || live.as_deref() != Some(presented.as_str()) {
        if spent.contains(&presented) {
            // Reuse of a spent token: the provider revokes the whole grant.
            *p.revoked.lock().expect("lock") = true;
            *live = None;
        }
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant" })),
        );
    }
    spent.insert(presented);
    let next = format!("rt-{n}");
    *live = Some(next.clone());
    (
        axum::http::StatusCode::OK,
        Json(json!({
            "access_token": format!("at-{n}"),
            "refresh_token": next,
            "expires_in": 3600,
        })),
    )
}

/// Serve the fake provider on an OS-chosen port; returns its token URL.
async fn serve(provider: Arc<Provider>) -> &'static str {
    let app = Router::new()
        .route("/token", post(token_endpoint))
        .with_state(provider);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake provider");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    // Leaked on purpose: `RefreshConfig` holds `'static` strings, exactly as
    // the provider registry does.
    Box::leak(format!("http://{addr}/token").into_boxed_str())
}

fn config(token_url: &'static str) -> &'static apps::RefreshConfig {
    Box::leak(Box::new(apps::RefreshConfig {
        token_url,
        alternate_token_urls: &[],
        // Never set in the test process: the client pair comes from the
        // seeded app config (the BYOC tier), like a real connection's would.
        client_id_env: "ONECLI_REFRESH_TEST_UNSET_ID",
        client_secret_env: "ONECLI_REFRESH_TEST_UNSET_SECRET",
        body_format: apps::TokenBodyFormat::Form,
        client_auth: apps::ClientCredentialMethod::Body,
    }))
}

// ── Fixtures ─────────────────────────────────────────────────────────────

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the refresh serialization tests must not silently skip"
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

/// One simulated gateway instance: its own shared pool, refresh pool and
/// in-process stripes, pointed at the same database as every other.
async fn instance(lock_wait: Duration) -> PolicyEngine {
    let url = std::env::var("GATEWAY_TEST_DATABASE_URL").expect("checked by test_pool");
    let pool = db::create_pool(&url).await.expect("connect");
    PolicyEngine::test_with_pool(pool, lock_wait)
}

struct World {
    pool: PgPool,
    tag: String,
    connection_id: String,
    workspace_id: String,
}

impl World {
    /// A workspace with an enabled BYOC app config and one connected,
    /// EXPIRED connection holding refresh token `rt-0`, minted by that config.
    async fn seed(pool: PgPool, engine: &PolicyEngine) -> Self {
        let tag = format!("rfx-{}", uuid::Uuid::new_v4().simple());
        let workspace_id = format!("{tag}-ws");
        let org_id = format!("{tag}-org");
        let config_id = format!("{tag}-cfg");
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

        let client_secret = engine
            .crypto
            .encrypt(&json!({ "clientSecret": "test-secret" }).to_string())
            .await
            .expect("encrypt client secret");
        sqlx::query(
            "INSERT INTO app_configs (id, workspace_id, provider, enabled, credentials, settings, scope, updated_at)
             VALUES ($1, $2, 'gitlab', true, $3, $4, 'workspace', now())",
        )
        .bind(&config_id)
        .bind(&workspace_id)
        .bind(client_secret)
        .bind(json!({ "clientId": "test-client" }))
        .execute(&pool)
        .await
        .expect("seed app config");

        let creds = engine
            .crypto
            .encrypt(
                &json!({
                    "access_token": "at-0",
                    "refresh_token": "rt-0",
                    "expires_at": 1,
                    "scope": "api",
                })
                .to_string(),
            )
            .await
            .expect("encrypt credentials");
        sqlx::query(
            "INSERT INTO app_connections (id, workspace_id, provider, status, credentials, scope, app_config_id, updated_at)
             VALUES ($1, $2, 'gitlab', 'connected', $3, 'workspace', $4, now())",
        )
        .bind(&connection_id)
        .bind(&workspace_id)
        .bind(creds)
        .bind(&config_id)
        .execute(&pool)
        .await
        .expect("seed connection");

        Self {
            pool,
            tag,
            connection_id,
            workspace_id,
        }
    }

    async fn stored(&self, engine: &PolicyEngine) -> Option<Value> {
        let row: Option<Option<String>> =
            sqlx::query_scalar("SELECT credentials FROM app_connections WHERE id = $1")
                .bind(&self.connection_id)
                .fetch_optional(&self.pool)
                .await
                .expect("read connection");
        let ciphertext = row.flatten()?;
        let json = engine.crypto.decrypt(&ciphertext).await.expect("decrypt");
        Some(serde_json::from_str(&json).expect("credentials json"))
    }

    /// Whether the row carries the needs-reconnect flag.
    async fn flagged(&self) -> bool {
        sqlx::query_scalar(
            "SELECT reauth_required_at IS NOT NULL FROM app_connections WHERE id = $1",
        )
        .bind(&self.connection_id)
        .fetch_one(&self.pool)
        .await
        .expect("read flag")
    }

    /// Store `creds` the way the API's reconnect does: a new ciphertext, and
    /// the needs-reconnect flag cleared, under no gateway lock.
    async fn reconnect(&self, engine: &PolicyEngine, creds: &Value) {
        let ciphertext = engine
            .crypto
            .encrypt(&creds.to_string())
            .await
            .expect("encrypt");
        sqlx::query(
            "UPDATE app_connections SET credentials = $1, reauth_required_at = NULL WHERE id = $2",
        )
        .bind(ciphertext)
        .bind(&self.connection_id)
        .execute(&self.pool)
        .await
        .expect("reconnect");
    }

    fn refresh<'a>(&'a self, config: &'static apps::RefreshConfig) -> OAuthRefresh<'a> {
        OAuthRefresh {
            connection_id: &self.connection_id,
            provider: "gitlab",
            workspace_id: &self.workspace_id,
            config,
        }
    }
}

/// Deletes the fixture's rows however the test ends. A panicking test never
/// reaches an explicit cleanup call, and leftovers would accumulate in the
/// shared database every gateway DB suite runs against.
impl Drop for World {
    fn drop(&mut self) {
        let like = format!("{}%", self.tag);
        let cleanup = async move {
            use sqlx::Connection as _;
            // Its own connection: the fixture's pool belongs to the test's
            // runtime, which this cleanup deliberately does not run on.
            let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
                return;
            };
            let Ok(mut conn) = sqlx::PgConnection::connect(&url).await else {
                return;
            };
            for sql in [
                "DELETE FROM app_connections WHERE id LIKE $1",
                "DELETE FROM app_configs WHERE id LIKE $1",
                "DELETE FROM workspaces WHERE id LIKE $1",
                "DELETE FROM organizations WHERE id LIKE $1",
            ] {
                let _ = sqlx::query(sql).bind(&like).execute(&mut conn).await;
            }
            let _ = conn.close().await;
        };
        // A fresh runtime on its own thread: the test's runtime may be
        // shutting down (a panic unwinds through it) and cannot be blocked on.
        let _ = std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                rt.block_on(cleanup);
            }
        })
        .join();
    }
}

fn token(outcome: &RefreshOutcome) -> Option<&str> {
    match outcome {
        RefreshOutcome::Token { access_token, .. } => Some(access_token),
        _ => None,
    }
}

/// Resolve once the provider has been asked, panicking after a bound. A
/// regression that never reaches the provider must fail the test, not hang
/// the suite until CI's job timeout.
async fn provider_asked(provider: &Provider) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while provider.calls() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the refresh never reached the provider");
}

// ── Tests ────────────────────────────────────────────────────────────────

/// The bug itself: concurrent refreshes from two instances must reach the
/// provider exactly once, every caller must get the one fresh token, and the
/// rotated refresh token must be what is stored afterwards.
#[tokio::test]
async fn concurrent_refreshes_across_instances_spend_the_token_once() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let b = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("rt-0");
    // A slow provider widens the window every racer lands in.
    *provider.delay.lock().expect("lock") = Duration::from_millis(300);
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    let mut racers = Vec::new();
    for i in 0..8 {
        let engine = if i % 2 == 0 { &a } else { &b };
        racers.push(refresh_oauth_token(engine, world.refresh(cfg)));
    }
    let outcomes = futures_util::future::join_all(racers).await;

    assert_eq!(
        provider.calls(),
        1,
        "one spend for one expiry, across both instances"
    );
    assert!(!provider.revoked(), "the grant must survive");
    for outcome in &outcomes {
        assert_eq!(
            token(outcome),
            Some("at-1"),
            "every caller gets the one fresh token"
        );
    }
    let stored = world.stored(&a).await.expect("row still there");
    assert_eq!(
        stored["refresh_token"], "rt-1",
        "the rotated token is stored"
    );
    assert_eq!(stored["access_token"], "at-1");
    assert_eq!(
        stored["scope"], "api",
        "fields the refresh does not own survive"
    );
    assert!(stored["expires_at"].as_i64().expect("expiry") > super::now_secs());
}

/// The next expiry spends the token the previous refresh stored. This proves
/// the rotation chain continues instead of replaying a dead token.
#[tokio::test]
async fn a_later_expiry_spends_the_rotated_token() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("rt-0");
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    assert_eq!(
        token(&refresh_oauth_token(&a, world.refresh(cfg)).await),
        Some("at-1")
    );
    // Expire what was just stored, as the clock eventually will.
    let mut stored = world.stored(&a).await.expect("row");
    stored["expires_at"] = json!(1);
    let ciphertext = a
        .crypto
        .encrypt(&stored.to_string())
        .await
        .expect("encrypt");
    sqlx::query("UPDATE app_connections SET credentials = $1 WHERE id = $2")
        .bind(ciphertext)
        .bind(&world.connection_id)
        .execute(&world.pool)
        .await
        .expect("expire");

    assert_eq!(
        token(&refresh_oauth_token(&a, world.refresh(cfg)).await),
        Some("at-2")
    );
    assert_eq!(provider.calls(), 2);
    assert!(!provider.revoked());
}

/// A reconnect that lands while a refresh is in flight wins: the refresh's
/// compare-and-set misses, and the user's fresh credentials stay stored.
#[tokio::test]
async fn a_reconnect_during_a_refresh_is_never_overwritten() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("rt-0");
    *provider.delay.lock().expect("lock") = Duration::from_millis(400);
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    let in_flight = refresh_oauth_token(&a, world.refresh(cfg));
    let reconnect = async {
        // Land the reconnect while the provider is answering: after the
        // refresh read the row, before it writes back.
        provider_asked(&provider).await;
        let fresh = a
            .crypto
            .encrypt(
                &json!({ "access_token": "user-at", "refresh_token": "user-rt", "expires_at": 4_102_444_800_i64 })
                    .to_string(),
            )
            .await
            .expect("encrypt");
        // The API's reconnect writes the row directly, under no gateway lock.
        sqlx::query("UPDATE app_connections SET credentials = $1 WHERE id = $2")
            .bind(fresh)
            .bind(&world.connection_id)
            .execute(&world.pool)
            .await
            .expect("reconnect");
    };
    let (outcome, ()) = tokio::join!(in_flight, reconnect);

    assert_eq!(
        token(&outcome),
        Some("at-1"),
        "the minted token still serves this request"
    );
    let stored = world.stored(&a).await.expect("row");
    assert_eq!(
        stored["refresh_token"], "user-rt",
        "the reconnect is never clobbered"
    );
    assert_eq!(stored["access_token"], "user-at");
}

/// A connection disconnected (or deleted) since the caller's cached copy was
/// read refreshes nothing and yields nothing to inject.
#[tokio::test]
async fn a_disconnected_connection_is_never_refreshed() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("rt-0");
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;
    sqlx::query("UPDATE app_connections SET status = 'disconnected' WHERE id = $1")
        .bind(&world.connection_id)
        .execute(&world.pool)
        .await
        .expect("disconnect");

    assert_eq!(
        refresh_oauth_token(&a, world.refresh(cfg)).await,
        RefreshOutcome::Revoked
    );
    assert_eq!(provider.calls(), 0);

    sqlx::query("DELETE FROM app_connections WHERE id = $1")
        .bind(&world.connection_id)
        .execute(&world.pool)
        .await
        .expect("delete");
    assert_eq!(
        refresh_oauth_token(&a, world.refresh(cfg)).await,
        RefreshOutcome::Revoked
    );
    assert_eq!(provider.calls(), 0);
}

/// The re-read is what makes the second instance cheap: the stored token is
/// already fresh, so nothing is spent and the stored token is served.
#[tokio::test]
async fn a_token_refreshed_elsewhere_is_reused_without_a_provider_call() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("rt-0");
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;
    let fresh = a
        .crypto
        .encrypt(
            &json!({ "access_token": "elsewhere", "refresh_token": "rt-9", "expires_at": 4_102_444_800_i64 })
                .to_string(),
        )
        .await
        .expect("encrypt");
    sqlx::query("UPDATE app_connections SET credentials = $1 WHERE id = $2")
        .bind(fresh)
        .bind(&world.connection_id)
        .execute(&world.pool)
        .await
        .expect("refresh elsewhere");

    let outcome = refresh_oauth_token(&a, world.refresh(cfg)).await;
    assert_eq!(token(&outcome), Some("elsewhere"));
    assert_eq!(provider.calls(), 0);
}

/// A refusal of the refresh token (`invalid_grant`) is reported as needing a
/// reconnect and leaves the stored pair untouched: nothing the provider said
/// replaces what the user connected.
#[tokio::test]
async fn a_provider_refusal_leaves_the_stored_pair_untouched() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    // The provider never issued rt-0, so it refuses it.
    let provider = Provider::with_live("something-else");
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    assert_eq!(
        refresh_oauth_token(&a, world.refresh(cfg)).await,
        RefreshOutcome::NeedsReconnect
    );
    let stored = world.stored(&a).await.expect("row");
    assert_eq!(stored["refresh_token"], "rt-0");
    assert_eq!(stored["access_token"], "at-0");
}

/// A holder that never finishes costs a waiter its bounded wait, not a hang:
/// the waiter gives up, spends nothing, and keeps its own token.
#[tokio::test]
async fn a_stuck_lock_holder_bounds_the_waiter() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_millis(300)).await;
    let provider = Provider::with_live("rt-0");
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool.clone(), &a).await;

    // Another "instance" holds the connection's lock and does nothing.
    let mut holder = pool.begin().await.expect("begin");
    assert!(
        db::lock_app_connection_refresh(&mut holder, &world.connection_id, 1_000)
            .await
            .expect("lock")
    );

    let started = std::time::Instant::now();
    let outcome = refresh_oauth_token(&a, world.refresh(cfg)).await;
    assert_eq!(outcome, RefreshOutcome::Unavailable);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "bounded by the lock wait"
    );
    assert_eq!(provider.calls(), 0);
    holder.rollback().await.expect("release");
}

/// A request cancelled after the provider was asked must not lose the new
/// token: the spend runs detached, so the rotated pair is still stored and a
/// later refresh does not replay the spent token.
#[tokio::test]
async fn a_cancelled_request_still_stores_the_rotated_token() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("rt-0");
    *provider.delay.lock().expect("lock") = Duration::from_millis(400);
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    // Drop the request mid-flight, the moment the provider has been asked.
    // This keys on the call itself, not a fixed delay, so a slow CI box cannot
    // cancel before the spend starts and pass for the wrong reason.
    let request = refresh_oauth_token(&a, world.refresh(cfg));
    tokio::select! {
        _ = request => panic!("the request should still be waiting on the provider"),
        () = provider_asked(&provider) => {}
    }

    // Give the detached spend time to finish and commit.
    let mut stored = Value::Null;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        stored = world.stored(&a).await.expect("row");
        if stored["refresh_token"] == "rt-1" {
            break;
        }
    }
    assert_eq!(
        stored["refresh_token"], "rt-1",
        "the minted pair reached the database"
    );
    assert_eq!(provider.calls(), 1);
    assert!(!provider.revoked());
}

// ── Needs reconnect ──────────────────────────────────────────────────────

/// `invalid_grant` flags the connection, and from then on it is answered
/// without asking the provider again, until a reconnect stores a new
/// credential and clears the flag.
#[tokio::test]
async fn a_refused_refresh_token_flags_the_connection_until_a_reconnect() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    // The provider never issued rt-0, so it refuses it.
    let provider = Provider::with_live("something-else");
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    assert_eq!(
        refresh_oauth_token(&a, world.refresh(cfg)).await,
        RefreshOutcome::NeedsReconnect
    );
    assert!(world.flagged().await, "the refusal is recorded");
    assert_eq!(
        refresh_oauth_token(&a, world.refresh(cfg)).await,
        RefreshOutcome::NeedsReconnect
    );
    assert_eq!(provider.calls(), 1, "a refused token is not sent again");

    // The user reconnects: a fresh, live pair and the flag cleared. The next
    // expiry spends the new token like any healthy connection.
    *provider.live.lock().expect("lock") = Some("rt-new".to_string());
    world
        .reconnect(
            &a,
            &json!({ "access_token": "user-at", "refresh_token": "rt-new", "expires_at": 1 }),
        )
        .await;
    assert_eq!(
        token(&refresh_oauth_token(&a, world.refresh(cfg)).await),
        Some("at-2")
    );
    assert!(!world.flagged().await);
}

/// A reconnect that lands while the provider is refusing the OLD token is
/// never flagged: the flag is conditional on the refused credential still
/// being stored, and this request falls back instead.
#[tokio::test]
async fn a_reconnect_during_a_refusal_is_never_flagged() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("something-else");
    *provider.delay.lock().expect("lock") = Duration::from_millis(400);
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    let in_flight = refresh_oauth_token(&a, world.refresh(cfg));
    let reconnect = async {
        provider_asked(&provider).await;
        world
            .reconnect(
                &a,
                &json!({ "access_token": "user-at", "refresh_token": "user-rt", "expires_at": 4_102_444_800_i64 }),
            )
            .await;
    };
    let (outcome, ()) = tokio::join!(in_flight, reconnect);

    assert_eq!(outcome, RefreshOutcome::Unavailable);
    assert!(!world.flagged().await, "the new credential is healthy");
    let stored = world.stored(&a).await.expect("row");
    assert_eq!(stored["refresh_token"], "user-rt");
}

/// A transient provider failure (here a 503) says nothing about the refresh
/// token, so it must not flag a healthy connection.
#[tokio::test]
async fn a_transient_provider_failure_does_not_flag_the_connection() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let provider = Provider::with_live("rt-0");
    *provider.outage.lock().expect("lock") = true;
    let cfg = config(serve(Arc::clone(&provider)).await);
    let world = World::seed(pool, &a).await;

    assert_eq!(
        refresh_oauth_token(&a, world.refresh(cfg)).await,
        RefreshOutcome::Unavailable
    );
    assert!(!world.flagged().await);
}

/// Through the real resolution path: a request its flagged connection serves
/// resolves to `NeedsReconnect` (which both proxy paths answer with
/// `connection_needs_reconnect` before policy or any approval hold), nothing
/// is injected, and nothing is cached, since a cached expired token would be
/// forwarded on the next request. A request on a host the connection does not
/// serve is not its problem.
#[tokio::test]
async fn a_flagged_connection_resolves_to_needs_reconnect_without_caching() {
    use crate::connect::{AppConnectionResult, PolicyEngineExt as _};

    let Some(pool) = test_pool().await else {
        return;
    };
    let a = instance(Duration::from_secs(20)).await;
    let world = World::seed(pool, &a).await;
    sqlx::query("UPDATE app_connections SET reauth_required_at = now() WHERE id = $1")
        .bind(&world.connection_id)
        .execute(&world.pool)
        .await
        .expect("flag");
    let credentials: Option<String> =
        sqlx::query_scalar("SELECT credentials FROM app_connections WHERE id = $1")
            .bind(&world.connection_id)
            .fetch_one(&world.pool)
            .await
            .expect("read");
    let row = db::AppConnectionRow {
        id: world.connection_id.clone(),
        provider: "gitlab".to_string(),
        scope: "workspace".to_string(),
        credentials,
        label: Some("jo@acme.test".to_string()),
        metadata: None,
        session_policy: None,
    };
    let cache = cache::in_memory();

    let resolved = a
        .resolve_app_injection_for_request(
            std::slice::from_ref(&row),
            "gitlab.com",
            Some("/api/v4/projects"),
            None,
            "org",
            &world.workspace_id,
            &*cache,
        )
        .await
        .expect("resolution");
    match resolved {
        AppConnectionResult::NeedsReconnect { connection } => {
            assert_eq!(connection.id, world.connection_id);
            assert_eq!(connection.label.as_deref(), Some("jo@acme.test"));
        }
        _ => panic!("expected NeedsReconnect"),
    }
    let key = format!(
        "app_injection:org:{}:{}:gitlab.com",
        world.workspace_id, world.connection_id
    );
    assert!(cache.get_raw(&key).await.is_none(), "nothing may be cached");
}
