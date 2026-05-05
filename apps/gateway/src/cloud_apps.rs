//! Cloud-only app providers (OSS stub — returns an empty slice).

use crate::apps::AppProvider;

/// Returns cloud-only app provider definitions.
pub(crate) fn providers() -> &'static [AppProvider] {
    &[]
}

/// Attempt to refresh credentials for a cloud-only credential type.
/// Returns `None` if the credential type is not recognized (falls through to standard refresh).
pub(crate) async fn try_refresh_credentials(
    _cred_type: &str,
    _creds: &serde_json::Value,
) -> Option<anyhow::Result<(String, i64)>> {
    None
}
