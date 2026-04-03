//! 1Password CLI (`op`) wrapper.
//!
//! Executes `op` commands via `tokio::process::Command`, parses JSON output,
//! and handles auth context (service-account token).

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::time::Duration;
use tokio::process::Command;

const OP_TIMEOUT: Duration = Duration::from_secs(15);
const MIN_OP_VERSION: (u32, u32, u32) = (2, 18, 0);

/// Auth context for op commands.
pub(crate) enum OpAuth<'a> {
    ServiceAccount { token: &'a str },
}

// 1Password env vars that must be cleared before spawning op.
const OP_ENV_VARS: &[&str] = &[
    "OP_SERVICE_ACCOUNT_TOKEN",
    "OP_CONNECT_HOST",
    "OP_CONNECT_TOKEN",
    "OP_DEVICE",
    "OP_BIOMETRIC_UNLOCK_CIID",
];

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct OpWhoami {
    pub account_uuid: Option<String>,
    pub user_uuid: Option<String>,
    pub url: Option<String>,
    pub email: Option<String>,
}

/// Configure a Command with the correct auth context.
fn configure_command(cmd: &mut Command, auth: &OpAuth<'_>) {
    // Clear all 1Password env vars to prevent cross-contamination
    for var in OP_ENV_VARS {
        cmd.env_remove(var);
    }
    match auth {
        OpAuth::ServiceAccount { token } => {
            cmd.env("OP_SERVICE_ACCOUNT_TOKEN", token);
        }
    }
}

/// Run an op command and return stdout as parsed JSON.
async fn run_op<T: serde::de::DeserializeOwned>(cmd: &mut Command) -> Result<T> {
    let output = tokio::time::timeout(OP_TIMEOUT, cmd.output())
        .await
        .context("op command timed out")?
        .context("failed to execute op")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("op command failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8(output.stdout).context("op output not UTF-8")?;
    serde_json::from_str(&stdout).context("failed to parse op JSON output")
}

/// Check op CLI version >= 2.18.0.
pub(crate) async fn op_check_version() -> Result<()> {
    let mut cmd = Command::new("op");
    cmd.arg("--version");
    for var in OP_ENV_VARS {
        cmd.env_remove(var);
    }

    let output = tokio::time::timeout(OP_TIMEOUT, cmd.output())
        .await
        .context("op --version timed out")?
        .context("op not found in PATH")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("op --version failed: {}", stderr.trim());
    }

    let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<u32> = version_str
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();

    if parts.len() < 3 || (parts[0], parts[1], parts[2]) < MIN_OP_VERSION {
        bail!(
            "op version {version_str} is too old; >= {}.{}.{} required",
            MIN_OP_VERSION.0,
            MIN_OP_VERSION.1,
            MIN_OP_VERSION.2
        );
    }
    Ok(())
}

/// Run `op whoami --format=json`.
pub(crate) async fn op_whoami(auth: &OpAuth<'_>) -> Result<OpWhoami> {
    let mut cmd = Command::new("op");
    cmd.args(["whoami", "--format=json"]);
    configure_command(&mut cmd, auth);
    run_op(&mut cmd).await
}

/// Validate that a string is a well-formed `op://` secret reference.
/// Format: `op://vault/item/[section/]field` — minimum 3 path segments.
pub(crate) fn validate_op_ref(op_ref: &str) -> Result<()> {
    if !op_ref.starts_with("op://") {
        bail!("secret reference must start with op://");
    }
    let path = &op_ref[5..]; // strip "op://"
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 3 {
        bail!(
            "op:// reference needs at least 3 parts (vault/item/field), got {}",
            segments.len()
        );
    }
    Ok(())
}

/// Read a secret value from an `op://` reference.
/// Returns the plaintext value as a string.
pub(crate) async fn op_read(auth: &OpAuth<'_>, op_ref: &str) -> Result<String> {
    let mut cmd = Command::new("op");
    cmd.args(["read", op_ref, "--no-newline"]);
    configure_command(&mut cmd, auth);

    let output = tokio::time::timeout(OP_TIMEOUT, cmd.output())
        .await
        .context("op read timed out")?
        .context("failed to execute op read")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("op read failed: {}", stderr.trim());
    }

    String::from_utf8(output.stdout).context("op read output not UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_validates_minimum() {
        let version = "2.18.0";
        let parts: Vec<u32> = version.split('.').filter_map(|s| s.parse().ok()).collect();
        assert!(parts.len() >= 3);
        assert!((parts[0], parts[1], parts[2]) >= MIN_OP_VERSION);

        let old_version = "2.17.0";
        let old_parts: Vec<u32> = old_version
            .split('.')
            .filter_map(|s| s.parse().ok())
            .collect();
        assert!((old_parts[0], old_parts[1], old_parts[2]) < MIN_OP_VERSION);
    }

    #[test]
    fn validate_op_ref_accepts_valid() {
        assert!(validate_op_ref("op://MyVault/MyItem/password").is_ok());
        assert!(validate_op_ref("op://API Keys/Anthropic/credential").is_ok());
        assert!(validate_op_ref("op://vault/item/section/field").is_ok());
    }

    #[test]
    fn validate_op_ref_rejects_invalid() {
        assert!(validate_op_ref("").is_err());
        assert!(validate_op_ref("not-an-op-ref").is_err());
        assert!(validate_op_ref("op://").is_err());
        assert!(validate_op_ref("op://vault").is_err());
        assert!(validate_op_ref("op://vault/item").is_err());
    }
}
