#[cfg(edition_oss)]
mod auth;

#[cfg(any(edition_onprem_slim, edition_onprem_full))]
#[path = "ee/onprem/auth.rs"]
mod auth;

#[cfg(edition_cloud)]
#[path = "ee/auth.rs"]
mod auth;

mod ca;

#[cfg(not(edition_cloud))]
mod cache;

#[cfg(edition_cloud)]
#[path = "ee/cache.rs"]
mod cache;

#[cfg(not(edition_cloud))]
mod approval;

#[cfg(edition_cloud)]
#[path = "ee/approval.rs"]
mod approval;

mod apps;

#[cfg(edition_oss)]
mod ee_apps;

#[cfg(not(edition_oss))]
#[path = "ee/ee_apps.rs"]
mod ee_apps;

#[cfg(edition_oss)]
mod org_routes;

#[cfg(not(edition_oss))]
#[path = "ee/org_routes.rs"]
mod org_routes;

mod connect;

#[cfg(not(edition_cloud))]
mod condition_match;

#[cfg(edition_cloud)]
#[path = "ee/condition_match.rs"]
mod condition_match;

#[cfg(not(edition_cloud))]
mod crypto;

#[cfg(edition_cloud)]
#[path = "ee/crypto.rs"]
mod crypto;

mod db;
mod default_interceptions;
mod edition;
mod gateway;
mod inject;
mod policy;
mod secret_inject;
mod summary;

// Cloud-only request summarizers for manual-approval cards. OSS build uses the
// no-op `cloud_summary.rs` stub; the cloud build swaps in `ee/cloud_summary.rs`
// (+ the `ee/cloud_summary/` submodules). Mirrors the `ee_apps` split, and
// is the fall-through arm of `summary`'s per-provider dispatch.
#[cfg(not(edition_cloud))]
mod cloud_summary;

#[cfg(edition_cloud)]
#[path = "ee/cloud_summary.rs"]
mod cloud_summary;

mod telemetry_core;
mod util;
mod version;

#[cfg(not(edition_cloud))]
mod telemetry;

#[cfg(edition_cloud)]
#[path = "ee/telemetry.rs"]
mod telemetry;

// Partner layer (cloud-only). OSS build uses the no-op `partner.rs` stub; the
// cloud build swaps in `ee/partner.rs` (+ the `ee/partner/` submodules).
#[cfg(not(edition_cloud))]
mod partner;

#[cfg(edition_cloud)]
#[path = "ee/partner.rs"]
mod partner;

// Granular access (EE — cloud + onprem): generic per-agent scoping for app
// connections — token-level (e.g. GitHub repo-scoped tokens) or request-level
// (e.g. Dropbox folder allowlist). No OSS stub: referenced only from the cloud/
// onprem hooks + ee_apps modules, which are all cfg'd out for oss.
#[cfg(not(edition_oss))]
#[path = "ee/granular_access.rs"]
mod granular_access;

// Budget layer (cloud-only). OSS build uses the no-op `budget.rs` stub; the
// cloud build swaps in `ee/budget.rs` (+ the `ee/budget/` submodules).
#[cfg(not(edition_cloud))]
mod budget;

#[cfg(edition_cloud)]
#[path = "ee/budget.rs"]
mod budget;

mod vault;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::ca::CertificateAuthority;
use crate::connect::PolicyEngine;
use crate::gateway::GatewayServer;
use crate::vault::bitwarden::{BitwardenConfig, BitwardenVaultProvider};
use crate::vault::onepassword::OnePasswordVaultProvider;
use crate::vault::{VaultProvider, VaultService};

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
}

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

    let cli = Cli::parse();

    // Expand ~ in data dir
    let data_dir = expand_tilde(&cli.data_dir);

    let caps = edition::capabilities();
    info!(
        data_dir = %data_dir.display(),
        edition = ?caps.edition,
        demo = caps.demo,
        "starting onecli-gateway"
    );

    // Load or generate CA
    let ca = CertificateAuthority::load_or_generate(&data_dir).await?;
    info!("CA certificate loaded");

    // Connect to PostgreSQL
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
            format!("postgresql://{user}:{pass}@{host}:{port}/{name}")
        }
    };
    let pool = db::create_pool(&database_url).await?;
    info!("database pool created");
    let telemetry_pool = pool.clone();

    // Load crypto service for secret decryption
    // OSS: AES-256-GCM with local key from SECRET_ENCRYPTION_KEY
    // Cloud: KMS envelope decryption (calls KMS Decrypt for each data key)
    let crypto = Arc::new(crypto::CryptoService::from_env().await?);
    info!("crypto service initialized");

    // Initialize cache store (before PolicyEngine — SA token resolution needs it).
    // OSS: in-memory DashMap. Cloud: Redis (ElastiCache with TLS + AUTH).
    let cache = cache::create_store().await?;
    info!("cache store created");

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
        cache: Arc::clone(&cache),
    });

    // Initialize vault service with Bitwarden + 1Password providers.
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

    // Initialize approval store for manual approval policy action
    // OSS: in-memory DashMap + tokio channels. Cloud: Redis + BLPOP.
    let approval_store = approval::create_store().await?;
    info!("approval store created");

    telemetry::init(telemetry_pool, Arc::clone(&cache));
    info!("telemetry initialized");

    info!(port = cli.port, "gateway ready");

    // Start the gateway server (blocks forever)
    let server = GatewayServer::new(
        ca,
        cli.port,
        policy_engine,
        vault_service,
        cache,
        approval_store,
    );
    server.run().await
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
