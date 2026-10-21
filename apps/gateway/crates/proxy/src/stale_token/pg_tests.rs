//! The refused-token recovery through the real `forward_request`, against a
//! real Postgres: a Salesforce-shaped upstream refuses the stored token with
//! `INVALID_AUTH_HEADER`, a local token endpoint mints a new one, and the
//! request is answered with the upstream's response to the retry.
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` like the other gateway DB suites:
//! skipped locally when unset, required in CI.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{any, post};
use axum::{Form, Json, Router};
use hyper::body::Incoming;
use hyper::{Request, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::connect::PolicyEngine;
use crate::forward::forward_request;
use crate::mitm::ResolvedRules;
use context::ProxyContext;

const DEAD: &str = "at-dead";
const SF_401: &str = r#"[{"message":"INVALID_JWT_FORMAT","errorCode":"INVALID_AUTH_HEADER"}]"#;

// ── Fakes ────────────────────────────────────────────────────────────────

/// What the Salesforce-shaped upstream saw.
#[derive(Default)]
struct Seen {
    /// Every bearer it was sent, in order.
    bearers: Mutex<Vec<String>>,
    /// Every body it was sent, in order.
    bodies: Mutex<Vec<String>>,
    /// Tokens it refuses besides [`DEAD`].
    also_dead: Mutex<Vec<String>>,
}

/// Refuses the dead tokens like Salesforce does; accepts any other.
async fn upstream(
    State(seen): State<Arc<Seen>>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    seen.bearers.lock().expect("lock").push(bearer.clone());
    seen.bodies.lock().expect("lock").push(body);
    if bearer == DEAD || seen.also_dead.lock().expect("lock").contains(&bearer) {
        (StatusCode::UNAUTHORIZED, SF_401.to_string())
    } else {
        (
            StatusCode::OK,
            r#"{"totalSize":0,"records":[]}"#.to_string(),
        )
    }
}

/// A Salesforce token endpoint shared by every test in this binary (the
/// refresh config pointing at it is process-wide): like Salesforce's, it
/// never rotates the refresh token and reports no `expires_in` (so the
/// one-hour default applies, which the gateway must cap). Counts exchanges
/// per refresh token so parallel tests stay apart.
#[derive(Default)]
struct TokenEndpoint {
    calls: Mutex<std::collections::HashMap<String, usize>>,
}

impl TokenEndpoint {
    fn calls(&self, refresh_token: &str) -> usize {
        self.calls
            .lock()
            .expect("lock")
            .get(refresh_token)
            .copied()
            .unwrap_or(0)
    }
}

async fn token_endpoint(
    State(endpoint): State<Arc<TokenEndpoint>>,
    Form(form): Form<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    let refresh_token = form.get("refresh_token").cloned().unwrap_or_default();
    if !refresh_token.starts_with("rt-stl-")
        || form.get("client_id").map(String::as_str) != Some("test-client")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant" })),
        );
    }
    let n = {
        let mut calls = endpoint.calls.lock().expect("lock");
        let n = calls.entry(refresh_token.clone()).or_default();
        *n += 1;
        *n
    };
    (
        StatusCode::OK,
        Json(json!({ "access_token": format!("at-{n}-{refresh_token}") })),
    )
}

/// The shared token endpoint, served from its own runtime so it outlives
/// every test's runtime, and Salesforce's refresh config pointed at it.
fn shared_token_endpoint() -> Arc<TokenEndpoint> {
    static ENDPOINT: std::sync::OnceLock<Arc<TokenEndpoint>> = std::sync::OnceLock::new();
    Arc::clone(ENDPOINT.get_or_init(|| {
        let endpoint = Arc::new(TokenEndpoint::default());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind token endpoint");
        listener.set_nonblocking(true).expect("nonblocking");
        let addr = listener.local_addr().expect("addr");
        let state = Arc::clone(&endpoint);
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                let router = Router::new()
                    .route("/token", post(token_endpoint))
                    .with_state(state);
                let _ = axum::serve(listener, router).await;
            });
        });
        let token_url: &'static str = Box::leak(format!("http://{addr}/token").into_boxed_str());
        super::set_test_refresh_config(salesforce_config(token_url));
        endpoint
    }))
}

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    addr
}

/// Salesforce's real refresh semantics (cap, stale codes) pointed at the
/// local token endpoint.
fn salesforce_config(token_url: &'static str) -> &'static apps::RefreshConfig {
    let real = apps::refresh_config("salesforce").expect("salesforce refreshes");
    Box::leak(Box::new(apps::RefreshConfig {
        token_url,
        alternate_token_urls: &[],
        client_id_env: "ONECLI_STALE_TEST_UNSET_ID",
        client_secret_env: "ONECLI_STALE_TEST_UNSET_SECRET",
        body_format: apps::TokenBodyFormat::Form,
        client_auth: apps::ClientCredentialMethod::Body,
        max_lifetime_secs: real.max_lifetime_secs,
        stale_token_error_codes: real.stale_token_error_codes,
    }))
}

// ── Fixture ──────────────────────────────────────────────────────────────

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the stale-token tests must not silently skip"
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
    tag: String,
    org_id: String,
    workspace_id: String,
    connection_id: String,
    refresh_token: String,
}

impl World {
    /// A Salesforce connection whose stored token is DEAD though its stored
    /// expiry is an hour away, minted by a workspace BYOC config.
    async fn seed(pool: PgPool, engine: &PolicyEngine) -> Self {
        let tag = format!("stl-{}", uuid::Uuid::new_v4().simple());
        let org_id = format!("{tag}-org");
        let workspace_id = format!("{tag}-ws");
        let config_id = format!("{tag}-cfg");
        let connection_id = format!("{tag}-conn");
        let refresh_token = format!("rt-{tag}");

        sqlx::query("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ($1, $1, $1, now(), now())")
            .bind(&org_id)
            .execute(&pool)
            .await
            .expect("seed org");
        sqlx::query("INSERT INTO workspaces (id, organization_id, created_at, updated_at) VALUES ($1, $2, now(), now())")
            .bind(&workspace_id)
            .bind(&org_id)
            .execute(&pool)
            .await
            .expect("seed workspace");
        let client_secret = engine
            .crypto
            .encrypt(&json!({ "clientSecret": "test-secret" }).to_string())
            .await
            .expect("encrypt");
        sqlx::query(
            "INSERT INTO app_configs (id, workspace_id, provider, enabled, credentials, settings, scope, updated_at)
             VALUES ($1, $2, 'salesforce', true, $3, $4, 'workspace', now())",
        )
        .bind(&config_id)
        .bind(&workspace_id)
        .bind(client_secret)
        .bind(json!({ "clientId": "test-client" }))
        .execute(&pool)
        .await
        .expect("seed config");
        let creds = engine
            .crypto
            .encrypt(
                &json!({
                    "access_token": DEAD,
                    "refresh_token": refresh_token,
                    "expires_at": crate::refresh::now_secs() + 3600,
                    "instance_host": "acme.my.salesforce.com",
                })
                .to_string(),
            )
            .await
            .expect("encrypt");
        sqlx::query(
            "INSERT INTO app_connections (id, workspace_id, provider, status, credentials, scope, app_config_id, updated_at)
             VALUES ($1, $2, 'salesforce', 'connected', $3, 'workspace', $4, now())",
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
            org_id,
            workspace_id,
            connection_id,
            refresh_token,
        }
    }

    /// The access token the shared endpoint mints for this world's `n`th
    /// exchange.
    fn minted(&self, n: usize) -> String {
        format!("at-{n}-{}", self.refresh_token)
    }

    async fn stored(&self, engine: &PolicyEngine) -> Value {
        let ciphertext: String =
            sqlx::query_scalar("SELECT credentials FROM app_connections WHERE id = $1")
                .bind(&self.connection_id)
                .fetch_one(&self.pool)
                .await
                .expect("read");
        let json = engine.crypto.decrypt(&ciphertext).await.expect("decrypt");
        serde_json::from_str(&json).expect("json")
    }

    /// The rules resolution produces for this connection: `token` injected as
    /// a Bearer, the connection recorded as the winner.
    fn rules(&self, token: &str) -> ResolvedRules {
        ResolvedRules {
            injection_rules: vec![inject::InjectionRule {
                path_pattern: "*".to_string(),
                injections: vec![inject::Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: format!("Bearer {token}"),
                }],
                secret: None,
            }],
            pending_injections: Vec::new(),
            policy_rules_v2: db::PolicyV2Rules::default(),
            available_apps: db::AvailableApps::default(),
            access_restricted: None,
            intercept_token: None,
            plan: "free".to_string(),
            rewrite_host: None,
            connection_label: None,
            finalizer: None,
            body_transform: None,
            session_policy: None,
            winning_connection_id: Some(self.connection_id.clone()),
            winning_provider: Some("salesforce".to_string()),
            github_org_access: None,
            budget_bindings: Vec::new(),
            host_mismatch: None,
        }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let like = format!("{}%", self.tag);
        let _ = std::thread::spawn(move || {
            let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
                return;
            };
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            rt.block_on(async move {
                use sqlx::Connection as _;
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
            });
        })
        .join();
    }
}

/// Serve one request through `forward_request` to `upstream`, the way the
/// MITM lane would with `rules` resolved for this connection. Returns the
/// address to call.
async fn gateway(
    upstream: SocketAddr,
    world: &World,
    rules: ResolvedRules,
    h: &Harness,
) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind gateway");
    let addr = listener.local_addr().expect("addr");
    let rules = Arc::new(rules);
    let (engine, cache) = (Arc::clone(&h.engine), Arc::clone(&h.cache));
    let ctx = Arc::new(ProxyContext {
        workspace_id: Some(world.workspace_id.clone()),
        organization_id: Some(world.org_id.clone()),
        agent_id: None,
        agent_name: None,
        agent_identifier: None,
        agent_token: "agent-token".to_string(),
    });
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        let io = hyper_util::rt::TokioIo::new(stream);
        let service = hyper::service::service_fn(move |req: Request<Incoming>| {
            let (engine, cache, rules, ctx) = (
                Arc::clone(&engine),
                Arc::clone(&cache),
                Arc::clone(&rules),
                Arc::clone(&ctx),
            );
            async move {
                let approvals = approval::in_memory();
                let host = upstream.to_string();
                forward_request(
                    req,
                    &host,
                    &host,
                    "http",
                    reqwest::Client::new(),
                    &rules,
                    &*cache,
                    &ctx,
                    &approvals,
                    &engine,
                )
                .await
            }
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(io, service)
            .await;
    });
    addr
}

struct Harness {
    world: World,
    engine: Arc<PolicyEngine>,
    cache: Arc<dyn cache::CacheStore>,
    seen: Arc<Seen>,
    tokens: Arc<TokenEndpoint>,
    upstream: SocketAddr,
}

async fn harness() -> Option<Harness> {
    let pool = test_pool().await?;
    let url = std::env::var("GATEWAY_TEST_DATABASE_URL").expect("checked");
    let engine_pool = db::create_pool(&url).await.expect("connect");
    let engine = Arc::new(PolicyEngine::test_with_pool(
        engine_pool,
        std::time::Duration::from_secs(20),
    ));
    let world = World::seed(pool, &engine).await;
    let tokens = shared_token_endpoint();

    let seen = Arc::new(Seen::default());
    let upstream = serve(
        Router::new()
            .fallback(any(upstream))
            .with_state(Arc::clone(&seen)),
    )
    .await;

    Some(Harness {
        world,
        engine,
        cache: cache::in_memory(),
        seen,
        tokens,
        upstream,
    })
}

// ── Tests ────────────────────────────────────────────────────────────────

/// The incident, end to end: the refused request is answered with the
/// upstream's answer to the resend on a fresh token, which is stored with a
/// trusted lifetime of 10 minutes whatever the token endpoint reported, and
/// the cached rules holding the refused token are dropped.
#[tokio::test]
async fn a_refused_request_is_resent_with_a_refreshed_token() {
    let Some(h) = harness().await else { return };
    let injection_key = format!(
        "{}acme.my.salesforce.com",
        crate::connect::connection_injection_cache_prefix(
            &h.world.org_id,
            &h.world.workspace_id,
            &h.world.connection_id
        )
    );
    let connect_key = format!(
        "{}agent-token:acme.my.salesforce.com",
        crate::connect::connect_cache_prefix(&h.world.org_id, &h.world.workspace_id)
    );
    for key in [&injection_key, &connect_key] {
        h.cache.set_raw(key, "holds the refused token", 60).await;
    }
    let gw = gateway(h.upstream, &h.world, h.world.rules(DEAD), &h).await;

    let resp = reqwest::Client::new()
        .get(format!("http://{gw}/services/data/v62.0/limits"))
        .send()
        .await
        .expect("gateway answered");

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(h.tokens.calls(&h.world.refresh_token), 1);
    let fresh = h.world.minted(1);
    assert_eq!(
        *h.seen.bearers.lock().expect("lock"),
        vec![DEAD.to_string(), fresh.clone()]
    );
    let stored = h.world.stored(&h.engine).await;
    assert_eq!(stored["access_token"], fresh);
    assert_eq!(
        stored["refresh_token"], h.world.refresh_token,
        "never rotated, kept"
    );
    let ttl = stored["expires_at"].as_i64().expect("expiry") - crate::refresh::now_secs();
    assert!(
        (590..=600).contains(&ttl),
        "trusted for 10 minutes, got {ttl}s"
    );
    for key in [&injection_key, &connect_key] {
        assert!(h.cache.get_raw(key).await.is_none(), "{key} dropped");
    }
}

/// A request with a body streamed it into the first send, so it is never
/// resent: the agent gets the provider's 401 byte for byte, and the token is
/// already replaced for its own retry.
#[tokio::test]
async fn a_request_with_a_body_is_not_resent_but_the_token_is_replaced() {
    let Some(h) = harness().await else { return };
    let gw = gateway(h.upstream, &h.world, h.world.rules(DEAD), &h).await;

    let body = r#"{"Title":"VP of Sales"}"#;
    let resp = reqwest::Client::new()
        .patch(format!(
            "http://{gw}/services/data/v62.0/sobjects/Contact/003QO00000AbCdEfGh"
        ))
        .body(body)
        .send()
        .await
        .expect("gateway answered");

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        resp.text().await.expect("body"),
        SF_401,
        "forwarded byte for byte"
    );
    assert_eq!(h.tokens.calls(&h.world.refresh_token), 1);
    assert_eq!(
        *h.seen.bearers.lock().expect("lock"),
        vec![DEAD.to_string()]
    );
    assert_eq!(*h.seen.bodies.lock().expect("lock"), vec![body.to_string()]);
    assert_eq!(
        h.world.stored(&h.engine).await["access_token"],
        h.world.minted(1)
    );
}

/// A refusal no refresh can fix (Salesforce known issue W-18029118: a
/// JWT-based token from the refresh flow refused at once) is not recovered
/// again: the refresh token is spent once, and every later refusal of the
/// token that refresh obtained is forwarded as is.
#[tokio::test]
async fn a_refused_recovery_is_not_recovered_again() {
    let Some(h) = harness().await else { return };
    let fresh = h.world.minted(1);
    h.seen.also_dead.lock().expect("lock").push(fresh.clone());

    let first = gateway(h.upstream, &h.world, h.world.rules(DEAD), &h).await;
    let resp = reqwest::Client::new()
        .get(format!("http://{first}/services/data/v62.0/limits"))
        .send()
        .await
        .expect("gateway answered");
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "the resend is refused too"
    );

    // The next request resolves the token the recovery stored.
    let second = gateway(h.upstream, &h.world, h.world.rules(&fresh), &h).await;
    let resp = reqwest::Client::new()
        .get(format!("http://{second}/services/data/v62.0/limits"))
        .send()
        .await
        .expect("gateway answered");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(resp.text().await.expect("body"), SF_401);

    assert_eq!(h.tokens.calls(&h.world.refresh_token), 1, "spent once");
    assert_eq!(
        *h.seen.bearers.lock().expect("lock"),
        vec![DEAD.to_string(), fresh.clone(), fresh],
        "the second request is sent once"
    );
}

/// A request a body transform (or a finalizer) applies to is bound to its
/// first send, so its refusal is never recovered here: forwarded untouched,
/// sent once, nothing spent. The expiry-driven refresh still renews it.
#[tokio::test]
async fn a_transformed_request_is_never_resent() {
    let Some(h) = harness().await else { return };
    let rules = ResolvedRules {
        body_transform: Some(apps::BodyTransform::GitHubCommitTrailer),
        ..h.world.rules(DEAD)
    };
    let gw = gateway(h.upstream, &h.world, rules, &h).await;

    let resp = reqwest::Client::new()
        .get(format!("http://{gw}/services/data/v62.0/limits"))
        .send()
        .await
        .expect("gateway answered");

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(resp.text().await.expect("body"), SF_401);
    assert_eq!(h.tokens.calls(&h.world.refresh_token), 0);
    assert_eq!(
        *h.seen.bearers.lock().expect("lock"),
        vec![DEAD.to_string()]
    );
}

/// Any other 401 (not one of the provider's dead-token codes) is forwarded
/// untouched and spends nothing.
#[tokio::test]
async fn another_401_is_forwarded_and_spends_nothing() {
    let Some(h) = harness().await else { return };
    let other = serve(Router::new().fallback(any(|| async {
        (
            StatusCode::UNAUTHORIZED,
            r#"[{"errorCode":"API_DISABLED_FOR_ORG"}]"#,
        )
    })))
    .await;
    let gw = gateway(other, &h.world, h.world.rules(DEAD), &h).await;

    let resp = reqwest::Client::new()
        .get(format!("http://{gw}/services/data/v62.0/limits"))
        .send()
        .await
        .expect("gateway answered");

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(h.tokens.calls(&h.world.refresh_token), 0);
    assert_eq!(h.world.stored(&h.engine).await["access_token"], DEAD);
}
