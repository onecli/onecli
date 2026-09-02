//! The gateway binary: the composition root.
//!
//! Parses the CLI, wires every runtime backend choice (`wiring`), builds the
//! shared context once, and runs the configured entrypoints
//! (`server::entrypoint`) until shutdown, then drives the drain.
//! Everything else lives in the workspace's library crates.

// Re-exported at the crate root so this crate's paths read like the module
// tree the code grew up with (`crate::edition::…`), and — load-bearing — so
// the licensed crate keeps its counted `crate::ee::…` spelling, which is what
// the boundary detector greps for (see ee-boundary.ts).
use common::edition;
use context::auth;
#[allow(clippy::single_component_path_imports)]
use ee;
#[allow(clippy::single_component_path_imports)]
use telemetry;

mod wiring;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use ca::CertificateAuthority;
use context::PolicyEngine;
use server::{Entrypoint, GatewayServer};
use vault::bitwarden::{BitwardenConfig, BitwardenVaultProvider};
use vault::onepassword::OnePasswordVaultProvider;
use vault::{VaultProvider, VaultService};

#[derive(Parser)]
#[command(
    name = "onecli-gateway",
    about = "OneCLI MITM gateway for credential injection"
)]
struct Cli {
    /// Port to listen on.
    #[arg(long, default_value = "10255")]
    port: u16,

    /// Data directory for CA certificates and persistent state.
    #[arg(long, default_value = default_data_dir())]
    data_dir: PathBuf,

    /// Probe a running gateway's /healthz on --port and exit 0/1. Lets the
    /// image healthcheck run without curl/wget in the runtime image.
    #[arg(long)]
    healthcheck: bool,
}

/// Cap on the final telemetry flush, inside the overall shutdown budget.
const TELEMETRY_FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Cap on closing the database pool — cosmetic cleanliness, never worth a hang.
const POOL_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

fn default_data_dir() -> &'static str {
    if cfg!(target_os = "linux") && Path::new("/app/data").exists() {
        "/app/data"
    } else {
        "~/.onecli"
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Install ring as the default rustls CryptoProvider (required by reqwest)
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        eprintln!("fatal: failed to install rustls CryptoProvider");
        std::process::exit(1);
    }

    let cli = Cli::parse();

    // Healthcheck self-probe: before the tracing stack (silent output) and
    // after the rustls provider install above (reqwest needs it). Exits.
    if cli.healthcheck {
        run_healthcheck(cli.port).await;
    }

    // Initialize logging — JSON for production (CloudWatch), text for dev
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    if std::env::var("LOG_FORMAT").as_deref() == Ok("json") {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(env_filter)
            .with_target(true)
            .flatten_event(true)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(env_filter).init();
    }

    // Before anything that can block: as PID 1 the kernel discards a SIGTERM
    // whose handler is still the default, so until this runs the process
    // cannot be stopped by anything short of SIGKILL. A signal arriving during
    // the startup below simply sets the flag, and the accept loop exits on its
    // first poll.
    shutdown::install();

    let data_dir = expand_tilde(&cli.data_dir);

    // The e2e suite asserts the boot line's `edition` field (Debug shape, e.g.
    // "Cloud") — keep the key and value format stable.
    info!(
        data_dir = %data_dir.display(),
        edition = ?crate::edition::edition(),
        "starting onecli-gateway"
    );

    // Cloud fail-fast: a cloud process missing a hard dependency (or holding a
    // config that must never run there) dies loudly at startup instead of
    // degrading into onprem-ish behavior mid-request.
    if edition::edition() == edition::Edition::Cloud {
        check_cloud_startup_env(
            std::env::var("COGNITO_USER_POOL_ID").ok().as_deref(),
            std::env::var("REDIS_HOST").ok().as_deref(),
            std::env::var("KMS_KEY_ARN").ok().as_deref(),
        )?;
    }

    // Multi-instance operation (#7) is licensed: a Redis-backed self-host —
    // the config that exists to run >1 gateway — refuses to start unlicensed,
    // mirroring the cloud fail-fast above. Every feature works on the
    // in-memory stores; unset REDIS_HOST to run unlicensed.
    crate::ee::ha::check_ha_entitlement(
        std::env::var("REDIS_HOST").ok().as_deref(),
        crate::edition::entitled(),
    )?;

    // The gateway puts absolute links into the responses agents relay to humans
    // ("open this URL to connect the app"). It answers proxy traffic, so unlike
    // the web app it has no incoming browser request to derive its own address
    // from — the configured external URL is the only thing that can tell it.
    // Say so once, loudly, rather than emitting links that look real and go
    // nowhere. All three warnings derive from the cached resolution, so they
    // describe the value actually in use.
    {
        use context::DashboardUrlSource;
        let resolved = context::resolved_dashboard();
        match resolved.source {
            DashboardUrlSource::Fallback => warn!(
                fallback = context::DASHBOARD_URL_FALLBACK,
                "ONECLI_EXTERNAL_URL is not set — links in agent-facing \
                 responses will point at the fallback and will not open for \
                 anyone reaching OneCLI on a different address. Set \
                 ONECLI_EXTERNAL_URL (the legacy APP_URL alias also works) to \
                 the URL users browse to."
            ),
            DashboardUrlSource::LegacyBind => warn!(
                url = resolved.url.as_str(),
                "ONECLI_BIND_HOST is seeding the dashboard URL (deprecated, \
                 removed next major). Pin it: add ONECLI_EXTERNAL_URL={} to \
                 the .env beside docker-compose.yml.",
                resolved.url
            ),
            DashboardUrlSource::Canonical => {
                if let Some(alias) = resolved.alias_conflict.as_deref() {
                    warn!(
                        canonical = resolved.url.as_str(),
                        alias,
                        "ONECLI_EXTERNAL_URL and APP_URL disagree; \
                         ONECLI_EXTERNAL_URL wins. Remove the APP_URL line \
                         unless the difference is intentional."
                    );
                }
            }
            DashboardUrlSource::Alias => {}
        }
    }

    // Session auth arm: install the licensed Cognito validator when edition +
    // config select it (see wiring::install_session_validator).
    wiring::install_session_validator();
    // Key ROLE rechecks: install the licensed RBAC resolver when edition +
    // entitlement select enforcement (see wiring::install_role_resolver).
    wiring::install_role_resolver();

    let ca = CertificateAuthority::load_or_generate(&data_dir).await?;
    info!("CA certificate loaded");

    // Support both DATABASE_URL (OSS) and individual DB_* vars (cloud ECS from Secrets Manager)
    let database_url = match std::env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            let host =
                std::env::var("DB_HOST").context("DATABASE_URL or DB_HOST env var must be set")?;
            let port = std::env::var("DB_PORT").unwrap_or_else(|_| "5432".to_string());
            let user = std::env::var("DB_USERNAME").context("DB_USERNAME env var must be set")?;
            let pass = std::env::var("DB_PASSWORD").context("DB_PASSWORD env var must be set")?;
            let name = std::env::var("DB_NAME").unwrap_or_else(|_| "onecli".to_string());
            database_url_from_parts(&host, &port, &user, &pass, &name)
        }
    };
    let pool = db::create_pool(&database_url).await?;
    info!("database pool created");
    let telemetry_pool = pool.clone();
    // The pool itself moves into the PolicyEngine below, and that moves into
    // the server — so the shutdown sequence needs its own handle to close it.
    let shutdown_pool = pool.clone();

    // Load crypto service for secret decryption/encryption.
    // SECRET_ENCRYPTION_KEY set → local AES-256-GCM; else KMS envelope.
    // Decrypt dispatches per ciphertext, so a mixed database keeps working.
    let crypto = Arc::new(wiring::create_crypto_service().await?);
    info!("crypto service initialized");

    // Build the 1Password provider once and share the Arc: the PolicyEngine
    // resolves `op://` secret values through it, and the VaultService registers
    // it as a provider (connection holder for pair/status/picker).
    let onepassword = Arc::new(OnePasswordVaultProvider::new(
        pool.clone(),
        Arc::clone(&crypto),
    ));

    let policy_engine = Arc::new(PolicyEngine {
        pool,
        crypto: Arc::clone(&crypto),
        onepassword: Arc::clone(&onepassword),
    });

    let proxy_url = std::env::var("BITWARDEN_PROXY_URL")
        .unwrap_or_else(|_| "wss://ap.lesspassword.dev".to_string());
    let bitwarden = BitwardenVaultProvider::new(
        BitwardenConfig { proxy_url },
        policy_engine.pool.clone(),
        Arc::clone(&crypto),
    );
    let providers: Vec<Arc<dyn VaultProvider>> = vec![Arc::new(bitwarden), onepassword];
    let vault_service = Arc::new(VaultService::new(providers, policy_engine.pool.clone()));
    info!("vault service initialized");

    // Redis (ElastiCache with TLS + AUTH) when REDIS_HOST is set, else in-memory.
    let cache = wiring::create_cache_store().await?;
    info!("cache store created");

    // Redis + BLPOP when REDIS_HOST is set, else in-memory DashMap + channels.
    let approval_store = wiring::create_approval_store().await?;
    info!("approval store created");

    // Budget spend persistence: installed before the telemetry flush starts so
    // a metered charge can never observe a missing sink.
    wiring::install_spend_sink();
    telemetry::init(telemetry_pool, Arc::clone(&cache));
    info!("telemetry initialized");

    // No port here: it would report the *requested* value, which is `0` when the
    // OS is asked to choose. The listening line logs the address actually bound.
    info!("gateway ready");

    // Serve until a shutdown signal stops the listener.
    let server = GatewayServer::new(
        ca,
        cli.port,
        policy_engine,
        vault_service,
        cache,
        approval_store,
    );
    let entrypoints: Vec<Box<dyn Entrypoint>> = vec![Box::new(server)];
    let result = server::entrypoint::run_all(entrypoints).await;

    // The drain, in the one order that does not lose data: connections first
    // (they are still emitting telemetry as they finish), then the telemetry
    // flush that persists what they emitted, then the database it wrote to.
    // Every phase draws from one budget, so the total cannot outrun the
    // orchestrator's patience however it is configured.
    let budget = shutdown::Budget::start();
    let drained = shutdown::drain_connections(budget.drain_share()).await;
    if !drained {
        warn!("drain deadline reached — remaining connections will be cut");
    }
    telemetry::core::shutdown(budget.allow(TELEMETRY_FLUSH_TIMEOUT)).await;
    // Bounded: a detached approval-cleanup task can briefly hold a connection,
    // and no amount of tidiness is worth missing the SIGKILL deadline.
    let _ = tokio::time::timeout(budget.allow(POOL_CLOSE_TIMEOUT), shutdown_pool.close()).await;

    info!(drained, "drain complete");
    result
}

/// Expand `~` at the start of a path to the user's home directory.
fn expand_tilde(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("~/") || s == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(s.strip_prefix("~/").unwrap_or(""));
        }
    }
    path.to_path_buf()
}

/// Assemble a postgres URL from the individual DB_* parts (cloud ECS injects
/// them from Secrets Manager). Username and password are percent-encoded —
/// RDS-managed passwords contain special characters that would corrupt the
/// URL. Env values come in as parameters so tests never mutate process env.
fn database_url_from_parts(host: &str, port: &str, user: &str, pass: &str, name: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let user = utf8_percent_encode(user, NON_ALPHANUMERIC);
    let pass = utf8_percent_encode(pass, NON_ALPHANUMERIC);
    format!("postgresql://{user}:{pass}@{host}:{port}/{name}")
}

/// Self-probe for container healthchecks (`onecli-gateway --healthcheck`):
/// GET /healthz on 127.0.0.1:{port}, exit 0 on a 2xx, exit 1 otherwise. The
/// explicit exits matter — the release profile is panic=abort, so any
/// unwind-free failure path must still produce a clean 0/1 for Docker/ECS.
async fn run_healthcheck(port: u16) -> ! {
    let healthy = healthcheck_ok(port).await;
    std::process::exit(if healthy { 0 } else { 1 });
}

async fn healthcheck_ok(port: u16) -> bool {
    // .no_proxy(): with a proxy env var set, reqwest would send the request
    // absolute-form through the proxy — and the gateway dispatches
    // absolute-form requests down its own proxy path, never to /healthz.
    // Failures go to stderr, which `docker inspect` and the ECS console keep
    // as the probe's output — an unhealthy verdict should say why.
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("healthcheck: building the probe client failed: {error}");
            return false;
        }
    };
    match client
        .get(format!("http://127.0.0.1:{port}/healthz"))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            eprintln!("healthcheck: /healthz answered {}", response.status());
            false
        }
        Err(error) => {
            eprintln!("healthcheck: probing /healthz failed: {error}");
            false
        }
    }
}

/// Cloud fail-fast: refuse to start a cloud-edition process that is missing a
/// hard dependency.
///
/// `COGNITO_USER_POOL_ID`, `REDIS_HOST`, and `KMS_KEY_ARN` must be set and
/// non-blank — each has an implicit fallback (self-hosted session auth,
/// in-memory stores, local AES) that is wrong on cloud. Env values come in as
/// parameters so tests never mutate process env.
fn check_cloud_startup_env(
    cognito_user_pool_id: Option<&str>,
    redis_host: Option<&str>,
    kms_key_arn: Option<&str>,
) -> Result<()> {
    for (name, value) in [
        ("COGNITO_USER_POOL_ID", cognito_user_pool_id),
        ("REDIS_HOST", redis_host),
        ("KMS_KEY_ARN", kms_key_arn),
    ] {
        if value.is_none_or(|v| v.trim().is_empty()) {
            anyhow::bail!("EDITION=cloud requires the {name} env var to be set");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_url_from_parts_is_table_driven() {
        // (host, port, user, pass, name) → expected URL. The special-character
        // rows are MUTATION-PROOF: drop the percent-encoding and they fail —
        // an RDS-managed password with `@:/?#[]%` would corrupt the URL.
        let cases: &[(&str, &str, &str, &str, &str, &str)] = &[
            (
                "db.internal",
                "5432",
                "onecli",
                "plain",
                "onecli",
                "postgresql://onecli:plain@db.internal:5432/onecli",
            ),
            (
                "db.internal",
                "6543",
                "user@corp",
                "p@ss:w/rd?#[]%",
                "onecli",
                "postgresql://user%40corp:p%40ss%3Aw%2Frd%3F%23%5B%5D%25@db.internal:6543/onecli",
            ),
            (
                "db.internal",
                "5432",
                "onecli",
                "pässwörd",
                "onecli",
                "postgresql://onecli:p%C3%A4ssw%C3%B6rd@db.internal:5432/onecli",
            ),
        ];

        for (host, port, user, pass, name, want) in cases {
            assert_eq!(
                database_url_from_parts(host, port, user, pass, name),
                *want,
                "parts ({host:?}, {port:?}, {user:?}, {pass:?}, {name:?})"
            );
        }
    }

    #[test]
    fn cloud_startup_env_check_is_table_driven() {
        let ok = Some("value");
        // (cognito, redis, kms) → expected error fragment (None = starts).
        #[allow(clippy::type_complexity)]
        let cases: &[(Option<&str>, Option<&str>, Option<&str>, Option<&str>)] = &[
            // Fully configured → starts.
            (ok, ok, ok, None),
            // Each hard dependency missing or blank → bails naming the var.
            (None, ok, ok, Some("COGNITO_USER_POOL_ID")),
            (Some("  "), ok, ok, Some("COGNITO_USER_POOL_ID")),
            (ok, None, ok, Some("REDIS_HOST")),
            (ok, Some(""), ok, Some("REDIS_HOST")),
            (ok, ok, None, Some("KMS_KEY_ARN")),
            (ok, ok, Some(""), Some("KMS_KEY_ARN")),
        ];

        for (cognito, redis, kms, want_err) in cases {
            let result = check_cloud_startup_env(*cognito, *redis, *kms);
            match want_err {
                None => assert!(
                    result.is_ok(),
                    "expected Ok for ({cognito:?}, {redis:?}, {kms:?}): {result:?}"
                ),
                Some(fragment) => {
                    let err = result
                        .expect_err(&format!(
                            "expected Err for ({cognito:?}, {redis:?}, {kms:?})"
                        ))
                        .to_string();
                    assert!(
                        err.contains(fragment),
                        "error {err:?} does not name {fragment:?}"
                    );
                }
            }
        }
    }
}
