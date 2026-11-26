//! Internal HTTP client for the Node "Keeper KSM SDK service".
//!
//! The gateway holds the (decrypted) Keeper KSM config and delegates the actual
//! SDK work — validating a config, resolving a `keeper://` reference, and
//! listing records/fields for the dashboard picker — to the Node API over an
//! authenticated, internal channel.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Binding a one-time token registers a new client with Keeper, which can be
/// slow; Keeper's own SDK allows 30s per request, so allow more than that.
const BIND_TIMEOUT: Duration = Duration::from_secs(45);

/// A failed internal-API call, classified so the provider can tell a stale
/// reference (skip the secret) from a transient outage (back off + retry).
#[derive(Debug)]
pub enum KeeperSecurityError {
    /// The reference resolved to nothing — the record was deleted or the field renamed.
    NotFound(String),
    /// The request was rejected as invalid (bad reference or bad config).
    BadRequest(String),
    /// Keeper refused the application itself (`access_denied`): it was revoked
    /// or its client removed. Nothing resolves until the workspace re-pairs.
    AccessDenied(String),
    /// Network failure, timeout, or server error — retry after a cooldown.
    Transient(String),
}

impl std::fmt::Display for KeeperSecurityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(m)
            | Self::BadRequest(m)
            | Self::AccessDenied(m)
            | Self::Transient(m) => {
                write!(f, "{m}")
            }
        }
    }
}

/// What a successful connectivity check learned about the application's
/// access. Every field defaults, so an API server that predates them (and
/// answers `{ "valid": true }`) reads as "no limits known".
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperSecurityHealth {
    /// Distinct records shared with the application; `None` when unknown.
    #[serde(default)]
    pub record_count: Option<u64>,
    /// When the application's access expires (ISO 8601), if Keeper set a limit.
    #[serde(default)]
    pub expires_on: Option<String>,
    /// Warnings Keeper attached to the response, verbatim.
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Where the api-server answers when nothing overrides it — the bare-metal /
/// dev default. Containerized layouts always set `INTERNAL_API_URL` (the
/// self-host compose points it at the api service).
const INTERNAL_API_URL_DEFAULT: &str = "http://localhost:10256";

/// Base URL of the internal Node API: `INTERNAL_API_URL` when set (e.g.
/// `http://api-server:10256`), else loopback.
///
/// Deliberately **not** `APP_URL`. That is the *public* URL users browse to —
/// a different concept, and since it can now name a real external host, using
/// it here would send in-container vault calls out over the internet.
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

/// Bind a single-use one-time token to a reusable KSM config. The token is
/// consumed by this call, so the caller must persist the returned config.
pub async fn bind(token: &str) -> Result<String, KeeperSecurityError> {
    let resp =
        send_with_timeout("bind", &serde_json::json!({ "token": token }), BIND_TIMEOUT).await?;
    if !resp.status().is_success() {
        return Err(classify(resp).await);
    }
    #[derive(Deserialize)]
    struct BindResponse {
        config: String,
    }
    let body: BindResponse = resp
        .json()
        .await
        .map_err(|e| KeeperSecurityError::Transient(format!("invalid bind response: {e}")))?;
    Ok(body.config)
}

/// Validate a KSM config (used at pair time and for `status`), returning what
/// Keeper reported about the application's access.
pub async fn validate(config: &str) -> Result<KeeperSecurityHealth, KeeperSecurityError> {
    let resp = send("validate", &serde_json::json!({ "config": config })).await?;
    if !resp.status().is_success() {
        return Err(classify(resp).await);
    }
    resp.json()
        .await
        .map_err(|e| KeeperSecurityError::Transient(format!("invalid validate response: {e}")))
}

/// Validate a config pasted at pair time, decoded in the format the user chose
/// (`"json"` or `"base64"`), and return it in the form the gateway stores (the
/// JSON every later call sends).
pub async fn validate_pasted(config: &str, format: &str) -> Result<String, KeeperSecurityError> {
    let resp = send(
        "validate",
        &serde_json::json!({ "config": config, "format": format }),
    )
    .await?;
    if !resp.status().is_success() {
        return Err(classify(resp).await);
    }
    #[derive(Deserialize)]
    struct PastedResponse {
        config: String,
    }
    let body: PastedResponse = resp
        .json()
        .await
        .map_err(|e| KeeperSecurityError::Transient(format!("invalid validate response: {e}")))?;
    Ok(body.config)
}

/// Resolve a `keeper://` reference to its plaintext secret value.
pub async fn resolve(
    config: &str,
    keepersecurity_ref: &str,
) -> Result<String, KeeperSecurityError> {
    let resp = send(
        "resolve",
        &serde_json::json!({ "config": config, "keepersecurity_ref": keepersecurity_ref }),
    )
    .await?;
    if !resp.status().is_success() {
        return Err(classify(resp).await);
    }
    let body: ResolveResponse = resp
        .json()
        .await
        .map_err(|e| KeeperSecurityError::Transient(format!("invalid resolve response: {e}")))?;
    Ok(body.value)
}

/// List the records shared with the KSM application.
pub async fn list_records(config: &str) -> Result<serde_json::Value, KeeperSecurityError> {
    list("list-records", &serde_json::json!({ "config": config })).await
}

/// List a record's referenceable fields — labels and refs, never values.
pub async fn list_fields(
    config: &str,
    record_uid: &str,
) -> Result<serde_json::Value, KeeperSecurityError> {
    list(
        "list-fields",
        &serde_json::json!({ "config": config, "recordUid": record_uid }),
    )
    .await
}

/// Shared body for the picker passthroughs: POST and return the raw JSON the
/// Node service produced (labels/refs only), or a classified error.
async fn list(
    op: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, KeeperSecurityError> {
    let resp = send(op, body).await?;
    if !resp.status().is_success() {
        return Err(classify(resp).await);
    }
    resp.json()
        .await
        .map_err(|e| KeeperSecurityError::Transient(format!("invalid {op} response: {e}")))
}

async fn send(
    op: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, KeeperSecurityError> {
    send_with_timeout(op, body, REQUEST_TIMEOUT).await
}

async fn send_with_timeout(
    op: &str,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<reqwest::Response, KeeperSecurityError> {
    http()
        .post(format!(
            "{}/v1/internal/keepersecurity/{op}",
            internal_api_url()
        ))
        .header("X-Gateway-Secret", internal_secret())
        .timeout(timeout)
        .json(body)
        .send()
        .await
        .map_err(|e| {
            KeeperSecurityError::Transient(format!("internal keepersecurity API unreachable: {e}"))
        })
}

async fn classify(resp: reqwest::Response) -> KeeperSecurityError {
    let status = resp.status();
    let msg = match resp.json::<ErrorBody>().await {
        Ok(ErrorBody {
            error: Some(ErrorDetail { message: Some(m) }),
        }) => m,
        _ => format!("internal keepersecurity API returned {status}"),
    };
    classify_status(status.as_u16(), msg)
}

/// Map the internal API's status to an error kind. Only 403 means Keeper
/// refused the application: the internal API's own auth failure is a 401
/// (a gateway misconfiguration, so transient from Keeper's point of view).
fn classify_status(status: u16, msg: String) -> KeeperSecurityError {
    match status {
        404 => KeeperSecurityError::NotFound(msg),
        400 => KeeperSecurityError::BadRequest(msg),
        403 => KeeperSecurityError::AccessDenied(msg),
        _ => KeeperSecurityError::Transient(msg),
    }
}

// `keeper://` reference shape is validated Node-side (`keepersecurityRefSchema`) at secret
// write time; the gateway trusts the refs it reads back from validated rows.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_403_means_keeper_refused_the_application() {
        assert!(matches!(
            classify_status(403, "denied".into()),
            KeeperSecurityError::AccessDenied(m) if m == "denied"
        ));
    }

    // 401 is the internal API rejecting the gateway's shared secret, not
    // Keeper rejecting the application: re-pairing would not fix it.
    #[test]
    fn other_statuses_keep_their_meaning() {
        assert!(matches!(
            classify_status(404, String::new()),
            KeeperSecurityError::NotFound(_)
        ));
        assert!(matches!(
            classify_status(400, String::new()),
            KeeperSecurityError::BadRequest(_)
        ));
        for status in [401, 429, 500, 502] {
            assert!(matches!(
                classify_status(status, String::new()),
                KeeperSecurityError::Transient(_)
            ));
        }
    }

    #[test]
    fn health_reads_the_full_validate_response() {
        let health: KeeperSecurityHealth = serde_json::from_value(serde_json::json!({
            "valid": true,
            "recordCount": 3,
            "expiresOn": "2026-12-01T00:00:00.000Z",
            "warnings": ["w"],
        }))
        .unwrap();
        assert_eq!(
            health,
            KeeperSecurityHealth {
                record_count: Some(3),
                expires_on: Some("2026-12-01T00:00:00.000Z".into()),
                warnings: vec!["w".into()],
            }
        );
    }

    // An API server from before these fields answers `{ "valid": true }`.
    #[test]
    fn health_tolerates_an_older_api_server() {
        let health: KeeperSecurityHealth =
            serde_json::from_value(serde_json::json!({ "valid": true })).unwrap();
        assert_eq!(health, KeeperSecurityHealth::default());
    }

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
