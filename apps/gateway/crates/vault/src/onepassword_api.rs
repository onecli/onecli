//! Internal HTTP client for the Node "1Password SDK service".
//!
//! The gateway holds the (decrypted) 1Password Service-Account token and
//! delegates the actual SDK work — validating a token and resolving an
//! `op://` reference — to the Node API over an authenticated, VPC-internal
//! channel. This replaces the old `op` CLI wrapper: no subprocess, no
//! third-party binary in the image, no macOS TCC prompts.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// A failed internal-API call, classified so the provider can tell a stale
/// reference (skip the secret) from a transient outage (back off + retry).
#[derive(Debug)]
pub enum OpError {
    /// The reference resolved to nothing — the item was deleted or renamed.
    NotFound(String),
    /// The request was rejected as invalid (bad reference or bad token).
    BadRequest(String),
    /// Network failure, timeout, or server error — retry after a cooldown.
    Transient(String),
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(m) | Self::BadRequest(m) | Self::Transient(m) => write!(f, "{m}"),
        }
    }
}

/// Where the api-server answers when nothing overrides it — the bare-metal /
/// dev default. Containerized layouts always set `INTERNAL_API_URL` (the
/// self-host compose points it at the api service, cloud at the in-VPC
/// api-server).
const INTERNAL_API_URL_DEFAULT: &str = "http://localhost:10256";

/// Base URL of the internal Node API: `INTERNAL_API_URL` when set (cloud points
/// it at the in-VPC api-server, e.g. `http://api-server:10256`), else loopback.
///
/// Deliberately **not** `APP_URL`. That is the *public* URL users browse to —
/// a different concept, and since it can now name a real external host, using
/// it here would send in-container vault calls out over the internet. Split out
/// for testability, as [`super::super::gateway::response::dashboard_url`] is.
fn resolve_internal_api_url(explicit: Option<&str>) -> String {
    explicit
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(INTERNAL_API_URL_DEFAULT)
        .trim_end_matches('/')
        .to_string()
}

fn internal_api_url() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| resolve_internal_api_url(std::env::var("INTERNAL_API_URL").ok().as_deref()))
}

/// Shared secret presented to the internal API as `X-Gateway-Secret`.
fn internal_secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| std::env::var("GATEWAY_INTERNAL_SECRET").unwrap_or_default())
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Deserialize)]
struct ResolveResponse {
    value: String,
}

/// The Node API formats errors as `{ "error": { "message": ..., "type": ... } }`.
#[derive(Deserialize)]
struct ErrorBody {
    error: Option<ErrorDetail>,
}

#[derive(Deserialize)]
struct ErrorDetail {
    message: Option<String>,
}

/// Validate a Service-Account token (used at pair time and for `status`).
pub async fn validate(token: &str) -> Result<(), OpError> {
    let resp = send("validate", &serde_json::json!({ "token": token })).await?;
    if resp.status().is_success() {
        return Ok(());
    }
    Err(classify(resp).await)
}

/// Resolve an `op://` reference to its plaintext secret value.
pub async fn resolve(token: &str, op_ref: &str) -> Result<String, OpError> {
    let resp = send(
        "resolve",
        &serde_json::json!({ "token": token, "op_ref": op_ref }),
    )
    .await?;
    if !resp.status().is_success() {
        return Err(classify(resp).await);
    }
    let body: ResolveResponse = resp
        .json()
        .await
        .map_err(|e| OpError::Transient(format!("invalid resolve response: {e}")))?;
    Ok(body.value)
}

/// List the vaults the Service Account can read (picker step 1).
pub async fn list_vaults(token: &str) -> Result<serde_json::Value, OpError> {
    list("list-vaults", &serde_json::json!({ "token": token })).await
}

/// List the items in a vault (picker step 2).
pub async fn list_items(token: &str, vault_id: &str) -> Result<serde_json::Value, OpError> {
    list(
        "list-items",
        &serde_json::json!({ "token": token, "vaultId": vault_id }),
    )
    .await
}

/// List an item's field labels — never values (picker step 3).
pub async fn list_fields(
    token: &str,
    vault_id: &str,
    item_id: &str,
) -> Result<serde_json::Value, OpError> {
    list(
        "list-fields",
        &serde_json::json!({ "token": token, "vaultId": vault_id, "itemId": item_id }),
    )
    .await
}

/// Shared body for the picker passthroughs: POST and return the raw JSON the
/// Node service produced (labels/types only), or a classified error.
async fn list(op: &str, body: &serde_json::Value) -> Result<serde_json::Value, OpError> {
    let resp = send(op, body).await?;
    if !resp.status().is_success() {
        return Err(classify(resp).await);
    }
    resp.json()
        .await
        .map_err(|e| OpError::Transient(format!("invalid {op} response: {e}")))
}

async fn send(op: &str, body: &serde_json::Value) -> Result<reqwest::Response, OpError> {
    http()
        .post(format!(
            "{}/v1/internal/onepassword/{op}",
            internal_api_url()
        ))
        .header("X-Gateway-Secret", internal_secret())
        .timeout(REQUEST_TIMEOUT)
        .json(body)
        .send()
        .await
        .map_err(|e| OpError::Transient(format!("internal 1Password API unreachable: {e}")))
}

async fn classify(resp: reqwest::Response) -> OpError {
    let status = resp.status();
    let msg = match resp.json::<ErrorBody>().await {
        Ok(ErrorBody {
            error: Some(ErrorDetail { message: Some(m) }),
        }) => m,
        _ => format!("internal 1Password API returned {status}"),
    };
    match status.as_u16() {
        404 => OpError::NotFound(msg),
        400 => OpError::BadRequest(msg),
        _ => OpError::Transient(msg),
    }
}

// `op://` reference shape is validated Node-side (`opRefSchema`) at secret
// write time; the gateway trusts the refs it reads back from validated rows.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_internal_url_wins_and_is_trimmed() {
        assert_eq!(
            resolve_internal_api_url(Some("http://api-server:10256/")),
            "http://api-server:10256"
        );
    }

    // The regression guard. This used to fall back to APP_URL — the *public*
    // URL — which, now that APP_URL can name a real external host, would send
    // in-container vault calls out over the internet. Loopback is the only
    // correct answer when nothing explicit is set.
    //
    // Asserted through the parameter rather than by setting APP_URL in the
    // environment: the resolver takes its only input as an argument, so there is
    // nothing for an env var to reach, and mutating process-wide env here would
    // race the sibling suites that read APP_URL through a cached `OnceLock`.
    #[test]
    fn falls_back_to_loopback_never_to_a_public_url() {
        assert_eq!(resolve_internal_api_url(None), INTERNAL_API_URL_DEFAULT);
        assert_eq!(resolve_internal_api_url(Some("")), INTERNAL_API_URL_DEFAULT);
        assert_eq!(
            resolve_internal_api_url(Some("   ")),
            INTERNAL_API_URL_DEFAULT
        );
    }
}
