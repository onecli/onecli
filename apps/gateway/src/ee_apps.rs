//! Cloud app providers (OSS stub — returns an empty slice).

use crate::apps::AppProvider;

/// Returns cloud app provider definitions (supplied by the EE builds).
pub(crate) fn providers() -> &'static [AppProvider] {
    &[]
}

/// Attempt to refresh credentials for an EE-managed cloud-app credential type.
/// Returns `None` if the credential type is not recognized (falls through to standard refresh).
pub(crate) async fn try_refresh_credentials(
    _cred_type: &str,
    _creds: &serde_json::Value,
    _session_policy: Option<&serde_json::Value>,
) -> Option<anyhow::Result<(String, i64)>> {
    None
}
