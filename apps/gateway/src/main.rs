#[cfg(not(feature = "cloud"))]
mod auth;

#[cfg(feature = "cloud")]
#[path = "cloud/auth.rs"]
mod auth;

mod ca;
mod connect;
mod crypto;
mod db;
mod gateway;
mod inject;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::ca::CertificateAuthority;
use crate::connect::PolicyEngine;
use crate::gateway::GatewayServer;

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
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls CryptoProvider");

    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    // Expand ~ in data dir
    let data_dir = expand_tilde(&cli.data_dir);

    info!(data_dir = %data_dir.display(), "starting onecli-gateway");

    // Load or generate CA
    let ca = CertificateAuthority::load_or_generate(&data_dir).await?;

    // Connect to PostgreSQL
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL env var is required")?;
    let pool = db::create_pool(&database_url).await?;

    // Load encryption key for secret decryption
    let crypto = Arc::new(crypto::CryptoService::from_env()?);

    let policy_engine = Arc::new(PolicyEngine { pool, crypto });

    info!(port = cli.port, "gateway ready");

    // Start the gateway server (blocks forever)
    let server = GatewayServer::new(ca, cli.port, policy_engine);
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
