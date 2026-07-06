//! Secret-to-injection mapping, OpenAI OAuth token refresh, and Google
//! Service Account token resolution.
//!
//! Converts decrypted secret values into injection instructions based on the
//! secret type (anthropic, openai, google_service_account, generic). Also
//! handles OpenAI OAuth token refresh, Google SA JWT→access_token exchange
//! with in-memory caching, and credential persistence.

use tracing::{debug, warn};

use crate::apps;
use crate::cache::CacheStore;
use crate::crypto::CryptoService;
use crate::db;
use crate::inject::Injection;
use crate::util;

/// Build injection instructions for a secret based on its type.
pub(crate) fn build_injections(
    secret_type: &str,
    decrypted_value: &str,
    injection_config: Option<&serde_json::Value>,
    metadata: Option<&serde_json::Value>,
) -> Vec<Injection> {
    match secret_type {
        "anthropic" => {
            let is_oauth = decrypted_value.starts_with("sk-ant-oat");
            if is_oauth {
                vec![Injection::ReplaceHeader {
                    name: "authorization".to_string(),
                    value: format!("Bearer {decrypted_value}"),
                }]
            } else {
                vec![
                    Injection::SetHeader {
                        name: "x-api-key".to_string(),
                        value: decrypted_value.to_string(),
                    },
                    Injection::RemoveHeader {
                        name: "authorization".to_string(),
                    },
                ]
            }
        }

        "openai" => {
            let is_oauth = metadata
                .and_then(|m| m.get("authMode"))
                .and_then(|v| v.as_str())
                == Some("oauth");

            if is_oauth {
                let auth: serde_json::Value = match serde_json::from_str(decrypted_value) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(error = %e, "openai oauth secret: failed to parse value");
                        return vec![];
                    }
                };
                let tokens = auth.get("tokens");
                let access_token = tokens
                    .and_then(|t| t.get("access_token"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let account_id = tokens
                    .and_then(|t| t.get("account_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if access_token.is_empty() {
                    warn!("openai oauth secret: no access_token found");
                    return vec![];
                }
                let mut injections = vec![Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: format!("Bearer {access_token}"),
                }];
                if !account_id.is_empty() {
                    injections.push(Injection::SetHeader {
                        name: "chatgpt-account-id".to_string(),
                        value: account_id.to_string(),
                    });
                }
                injections
            } else {
                vec![Injection::SetHeader {
                    name: "authorization".to_string(),
                    value: format!("Bearer {decrypted_value}"),
                }]
            }
        }

        // The effective value is already the resolved access token (not the
        // SA JSON key) — token resolution happens in resolve_secret_injections().
        "google_service_account" => {
            if decrypted_value.is_empty() {
                warn!("google_service_account secret: empty access token");
                return vec![];
            }
            vec![Injection::SetHeader {
                name: "authorization".to_string(),
                value: format!("Bearer {decrypted_value}"),
            }]
        }

        "generic" => {
            let config = injection_config.and_then(|v| v.as_object());

            let header_name = config
                .and_then(|c| c.get("headerName"))
                .and_then(|v| v.as_str());

            let param_name = config
                .and_then(|c| c.get("paramName"))
                .and_then(|v| v.as_str());

            if header_name.is_some() && param_name.is_some() {
                warn!("generic secret has both headerName and paramName; using headerName");
            }

            if let Some(header_name) = header_name {
                let value_format = config
                    .and_then(|c| c.get("valueFormat"))
                    .and_then(|v| v.as_str());

                let value = match value_format {
                    Some(fmt) => fmt.replace("{value}", decrypted_value),
                    None => decrypted_value.to_string(),
                };

                vec![Injection::SetHeader {
                    name: header_name.to_string(),
                    value,
                }]
            } else if let Some(param_name) = param_name {
                let param_format = config
                    .and_then(|c| c.get("paramFormat"))
                    .and_then(|v| v.as_str());

                let value = match param_format {
                    Some(fmt) => fmt.replace("{value}", decrypted_value),
                    None => decrypted_value.to_string(),
                };

                vec![Injection::SetParam {
                    name: param_name.to_string(),
                    value,
                }]
            } else if let Some(path_template) = config
                .and_then(|c| c.get("pathTemplate"))
                .and_then(|v| v.as_str())
            {
                vec![Injection::SetPath {
                    template: path_template.to_string(),
                    value: decrypted_value.to_string(),
                }]
            } else if let (Some(path_regex), Some(path_replacement)) = (
                config
                    .and_then(|c| c.get("pathRegex"))
                    .and_then(|v| v.as_str()),
                config
                    .and_then(|c| c.get("pathReplacement"))
                    .and_then(|v| v.as_str()),
            ) {
                vec![Injection::ReplacePathRegex {
                    pattern: path_regex.to_string(),
                    replacement: path_replacement.to_string(),
                    value: decrypted_value.to_string(),
                }]
            } else {
                vec![]
            }
        }

        _ => vec![],
    }
}

/// If the OpenAI OAuth access_token is expired, refresh it and persist the
/// updated credentials. Returns `Some(updated_json)` on successful refresh,
/// or `None` to fall through with the original (possibly expired) value.
pub(crate) async fn refresh_openai_oauth_if_expired(
    crypto: &CryptoService,
    pool: &sqlx::PgPool,
    decrypted_json: &str,
    secret_id: &str,
) -> Option<String> {
    let mut auth: serde_json::Value = serde_json::from_str(decrypted_json).ok()?;
    let access_token = auth.get("tokens")?.get("access_token")?.as_str()?;

    let exp = util::parse_jwt_exp(access_token)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_secs() as i64;

    if exp > now + 300 {
        return None;
    }

    let refresh_token = auth.get("tokens")?.get("refresh_token")?.as_str()?;
    debug!(secret_id, "openai oauth access_token expired, refreshing");

    match refresh_openai_oauth_token(refresh_token).await {
        Ok((new_access, new_refresh)) => {
            auth["tokens"]["access_token"] = serde_json::Value::String(new_access);
            if let Some(rt) = new_refresh {
                auth["tokens"]["refresh_token"] = serde_json::Value::String(rt);
            }

            let updated_json = serde_json::to_string(&auth).ok()?;

            if let Ok(encrypted) = crypto.encrypt(&updated_json).await {
                if let Err(e) = db::update_secret_value(pool, secret_id, &encrypted).await {
                    warn!(error = ?e, "failed to persist refreshed openai oauth token");
                }
            }

            Some(updated_json)
        }
        Err(e) => {
            warn!(error = ?e, "openai oauth token refresh failed, using expired token");
            None
        }
    }
}

/// Maximum TTL for cached Google SA access tokens (50 minutes).
/// The actual TTL is derived from the token's `expires_at`, capped at this
/// value with a 10-minute safety margin subtracted.
const SA_TOKEN_MAX_CACHE_TTL_SECS: u64 = 3000;

/// Safety margin subtracted from the token lifetime before caching.
/// Ensures the cached token is still valid when eventually used.
const SA_TOKEN_CACHE_MARGIN_SECS: u64 = 600;

/// Resolve a Google Service Account secret into an access token.
///
/// Parses the decrypted SA JSON key, checks the in-memory cache for a valid
/// token, and exchanges a new JWT→access_token if needed. The cache key
/// includes a hash of the decrypted JSON so that key rotation immediately
/// invalidates the cached token (works for both inline and 1Password sources).
///
/// Returns `Some(access_token)` on success, or `None` (after logging) on
/// failure so the caller can skip the secret.
pub(crate) async fn resolve_google_sa_token(
    cache: &dyn CacheStore,
    decrypted_json: &str,
    secret_id: &str,
) -> Option<String> {
    resolve_google_sa_token_with(cache, decrypted_json, secret_id, |pk, ce| {
        Box::pin(apps::refresh_google_sa_secret_token(pk, ce))
    })
    .await
}

/// Inner implementation that accepts a token-fetcher for testability.
async fn resolve_google_sa_token_with<F>(
    cache: &dyn CacheStore,
    decrypted_json: &str,
    secret_id: &str,
    fetch_token: F,
) -> Option<String>
where
    F: for<'a> FnOnce(
        &'a str,
        &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<(String, i64)>> + Send + 'a>,
    >,
{
    let sa: serde_json::Value = serde_json::from_str(decrypted_json)
        .map_err(|e| {
            warn!(secret_id, error = %e, "google_service_account: failed to parse SA JSON");
        })
        .ok()?;

    let private_key = sa.get("private_key").and_then(|v| v.as_str());
    let client_email = sa.get("client_email").and_then(|v| v.as_str());

    let (private_key, client_email) = match (private_key, client_email) {
        (Some(pk), Some(ce)) => (pk, ce),
        _ => {
            warn!(
                secret_id,
                "google_service_account: missing private_key or client_email"
            );
            return None;
        }
    };

    // Cache key includes a short hash of the decrypted JSON so that key
    // rotation invalidates the cache entry. This works for both inline
    // secrets (where encrypted_value changes) and 1Password-sourced secrets
    // (where encrypted_value is None but the decrypted content changes).
    let value_hash = &sha256_hex(decrypted_json)[..16];
    let cache_key = format!("sa_token:{secret_id}:{value_hash}");

    if let Some(token) = cache.get_raw(&cache_key).await {
        debug!(secret_id, "google_service_account: cache hit");
        return Some(token);
    }

    debug!(
        secret_id,
        "google_service_account: cache miss, exchanging JWT"
    );

    match fetch_token(private_key, client_email).await {
        Ok((access_token, expires_at)) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_secs() as i64;
            let remaining = expires_at - now; // signed: can be negative

            if remaining <= 0 {
                // Token is already expired (clock skew or bad response).
                // Do not return or cache it.
                warn!(
                    secret_id,
                    remaining, "google_service_account: received already-expired token"
                );
                return None;
            }

            let remaining_u = remaining as u64;

            if remaining_u <= SA_TOKEN_CACHE_MARGIN_SECS {
                // Token expires soon — return it for this request but
                // don't cache a value that will be stale shortly.
                warn!(
                    secret_id,
                    remaining, "google_service_account: token lifetime too short to cache"
                );
                return Some(access_token);
            }

            let ttl = (remaining_u - SA_TOKEN_CACHE_MARGIN_SECS).min(SA_TOKEN_MAX_CACHE_TTL_SECS);
            cache.set_raw(&cache_key, &access_token, ttl).await;
            Some(access_token)
        }
        Err(e) => {
            warn!(secret_id, error = ?e, "google_service_account: token exchange failed");
            None
        }
    }
}

/// Compute a hex-encoded SHA-256 digest (used for cache key versioning).
fn sha256_hex(input: &str) -> String {
    use ring::digest;
    let hash = digest::digest(&digest::SHA256, input.as_bytes());
    hash.as_ref()
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            use std::fmt::Write;
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Refresh an OpenAI OAuth access_token using the refresh_token.
async fn refresh_openai_oauth_token(
    refresh_token: &str,
) -> anyhow::Result<(String, Option<String>)> {
    let resp = reqwest::Client::new()
        .post("https://auth.openai.com/oauth/token")
        .timeout(std::time::Duration::from_secs(10))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("openai oauth token refresh request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "openai oauth token refresh failed ({status}): {body}"
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("openai oauth token refresh response parse failed: {e}"))?;

    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("openai oauth token refresh response missing access_token"))?
        .to_string();

    let refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(String::from);

    Ok((access_token, refresh_token))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── build_injections: anthropic ────────────────────────────────────

    #[test]
    fn build_injections_anthropic_api_key() {
        let injections = build_injections("anthropic", "sk-ant-api03-test", None, None);
        assert_eq!(injections.len(), 2);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: "sk-ant-api03-test".to_string(),
            }
        );
        assert_eq!(
            injections[1],
            Injection::RemoveHeader {
                name: "authorization".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_anthropic_oauth() {
        let injections = build_injections("anthropic", "sk-ant-oat-test-token", None, None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::ReplaceHeader {
                name: "authorization".to_string(),
                value: "Bearer sk-ant-oat-test-token".to_string(),
            }
        );
    }

    // ── build_injections: openai ───────────────────────────────────────

    #[test]
    fn build_injections_openai() {
        let injections = build_injections("openai", "sk-proj-abc123", None, None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer sk-proj-abc123".to_string(),
            }
        );
    }

    // ── build_injections: openai oauth ──────────────────────────────────

    #[test]
    fn build_injections_openai_oauth_valid() {
        let auth_json = r#"{"auth_mode":"chatgpt","tokens":{"access_token":"eyJhbGciOiJ","refresh_token":"rt_abc","account_id":"acc_123"},"last_refresh":"2025-01-01T00:00:00Z"}"#;
        let meta = serde_json::json!({"authMode": "oauth"});
        let injections = build_injections("openai", auth_json, None, Some(&meta));
        assert_eq!(injections.len(), 2);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer eyJhbGciOiJ".to_string(),
            }
        );
        assert_eq!(
            injections[1],
            Injection::SetHeader {
                name: "chatgpt-account-id".to_string(),
                value: "acc_123".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_openai_oauth_missing_token() {
        let auth_json = r#"{"auth_mode":"chatgpt","tokens":{}}"#;
        let meta = serde_json::json!({"authMode": "oauth"});
        let injections = build_injections("openai", auth_json, None, Some(&meta));
        assert!(injections.is_empty());
    }

    // ── build_injections: generic ──────────────────────────────────────

    #[test]
    fn build_injections_generic_with_format() {
        let config = serde_json::json!({
            "headerName": "authorization",
            "valueFormat": "Bearer {value}"
        });
        let injections = build_injections("generic", "my-secret", Some(&config), None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer my-secret".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_without_format() {
        let config = serde_json::json!({
            "headerName": "x-custom-key"
        });
        let injections = build_injections("generic", "raw-value", Some(&config), None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "x-custom-key".to_string(),
                value: "raw-value".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_missing_header_name() {
        let config = serde_json::json!({});
        let injections = build_injections("generic", "value", Some(&config), None);
        assert!(injections.is_empty());
    }

    #[test]
    fn build_injections_generic_no_config() {
        let injections = build_injections("generic", "value", None, None);
        assert!(injections.is_empty());
    }

    // ── build_injections: paramName ────────────────────────────────────

    #[test]
    fn build_injections_generic_param_name() {
        let config = serde_json::json!({ "paramName": "api_key" });
        let injections = build_injections("generic", "my-secret", Some(&config), None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetParam {
                name: "api_key".to_string(),
                value: "my-secret".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_param_name_with_format() {
        let config = serde_json::json!({ "paramName": "token", "paramFormat": "Bearer-{value}" });
        let injections = build_injections("generic", "my-secret", Some(&config), None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetParam {
                name: "token".to_string(),
                value: "Bearer-my-secret".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_header_takes_precedence_over_param() {
        let config = serde_json::json!({
            "headerName": "Authorization",
            "paramName": "api_key"
        });
        let injections = build_injections("generic", "my-secret", Some(&config), None);
        assert_eq!(injections.len(), 1);
        assert!(matches!(injections[0], Injection::SetHeader { .. }));
    }

    // ── build_injections: path ─────────────────────────────────────────

    #[test]
    fn build_injections_generic_path_template() {
        let config = serde_json::json!({ "pathTemplate": "/bot{value}" });
        let injections = build_injections("generic", "123:ABC", Some(&config), None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetPath {
                template: "/bot{value}".to_string(),
                value: "123:ABC".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_generic_path_regex() {
        let config = serde_json::json!({
            "pathRegex": "^/bot[^/]+(/.*)?$",
            "pathReplacement": "/bot{value}$1"
        });
        let injections = build_injections("generic", "123:ABC", Some(&config), None);
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::ReplacePathRegex {
                pattern: "^/bot[^/]+(/.*)?$".to_string(),
                replacement: "/bot{value}$1".to_string(),
                value: "123:ABC".to_string(),
            }
        );
    }

    /// Regex mode needs both keys; a lone `pathRegex` injects nothing.
    #[test]
    fn build_injections_generic_path_regex_missing_replacement() {
        let config = serde_json::json!({ "pathRegex": "^/x$" });
        let injections = build_injections("generic", "value", Some(&config), None);
        assert!(injections.is_empty());
    }

    // ── build_injections: google_service_account ─────────────────────

    #[test]
    fn build_injections_google_sa_bearer_token() {
        let injections = build_injections(
            "google_service_account",
            "ya29.test-access-token",
            None,
            None,
        );
        assert_eq!(injections.len(), 1);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer ya29.test-access-token".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_google_sa_empty_token() {
        let injections = build_injections("google_service_account", "", None, None);
        assert!(injections.is_empty());
    }

    // ── build_injections: unknown ──────────────────────────────────────

    #[test]
    fn build_injections_unknown_type() {
        let injections = build_injections("unknown", "value", None, None);
        assert!(injections.is_empty());
    }

    // ── resolve_google_sa_token: cache behavior ────────────────────────

    /// Valid SA JSON used across resolve tests.
    const TEST_SA_JSON: &str = r#"{"type":"service_account","private_key":"pk","client_email":"test@test.iam.gserviceaccount.com"}"#;

    /// Helper: returns a fetcher that succeeds with the given token and
    /// an expires_at of now + `lifetime_secs`.
    fn ok_fetcher(
        token: &str,
        lifetime_secs: i64,
    ) -> impl for<'a> FnOnce(
        &'a str,
        &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<(String, i64)>> + Send + 'a>,
    > {
        let token = token.to_string();
        move |_pk, _ce| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_secs() as i64;
            Box::pin(async move { Ok((token, now + lifetime_secs)) })
        }
    }

    /// Helper: returns a fetcher that always fails.
    fn err_fetcher() -> impl for<'a> FnOnce(
        &'a str,
        &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<(String, i64)>> + Send + 'a>,
    > {
        |_pk, _ce| Box::pin(async { Err(anyhow::anyhow!("exchange failed")) })
    }

    #[tokio::test]
    async fn resolve_google_sa_token_cache_hit() {
        let cache = crate::cache::InMemoryCacheStore::new();
        let secret_id = "secret_123";

        // Pre-populate cache
        let value_hash = &sha256_hex(TEST_SA_JSON)[..16];
        let cache_key = format!("sa_token:{secret_id}:{value_hash}");
        cache.set_raw(&cache_key, "ya29.cached-token", 3000).await;

        // The fetcher should NOT be called (cache hit).
        let result = resolve_google_sa_token_with(&cache, TEST_SA_JSON, secret_id, |_pk, _ce| {
            Box::pin(async { panic!("fetcher should not be called on cache hit") })
        })
        .await;
        assert_eq!(result.as_deref(), Some("ya29.cached-token"));
    }

    #[tokio::test]
    async fn resolve_google_sa_token_cache_miss_exchanges_and_caches() {
        let cache = crate::cache::InMemoryCacheStore::new();
        let secret_id = "s1";

        let result = resolve_google_sa_token_with(
            &cache,
            TEST_SA_JSON,
            secret_id,
            ok_fetcher("ya29.fresh-token", 3600),
        )
        .await;

        // Token returned
        assert_eq!(result.as_deref(), Some("ya29.fresh-token"));

        // Token was cached
        let value_hash = &sha256_hex(TEST_SA_JSON)[..16];
        let cache_key = format!("sa_token:{secret_id}:{value_hash}");
        let cached = cache.get_raw(&cache_key).await;
        assert_eq!(cached.as_deref(), Some("ya29.fresh-token"));
    }

    #[tokio::test]
    async fn resolve_google_sa_token_exchange_failure_not_cached() {
        let cache = crate::cache::InMemoryCacheStore::new();
        let secret_id = "s1";

        let result =
            resolve_google_sa_token_with(&cache, TEST_SA_JSON, secret_id, err_fetcher()).await;

        // Returns None on failure
        assert!(result.is_none());

        // Nothing cached
        let value_hash = &sha256_hex(TEST_SA_JSON)[..16];
        let cache_key = format!("sa_token:{secret_id}:{value_hash}");
        assert!(cache.get_raw(&cache_key).await.is_none());
    }

    #[tokio::test]
    async fn resolve_google_sa_token_nearly_expired_not_cached() {
        let cache = crate::cache::InMemoryCacheStore::new();
        let secret_id = "s1";

        // Token expires in 5 minutes — less than the 10-minute margin
        let result = resolve_google_sa_token_with(
            &cache,
            TEST_SA_JSON,
            secret_id,
            ok_fetcher("ya29.short-lived", 300),
        )
        .await;

        // Token still returned for this request
        assert_eq!(result.as_deref(), Some("ya29.short-lived"));

        // But NOT cached (lifetime too short)
        let value_hash = &sha256_hex(TEST_SA_JSON)[..16];
        let cache_key = format!("sa_token:{secret_id}:{value_hash}");
        assert!(cache.get_raw(&cache_key).await.is_none());
    }

    #[tokio::test]
    async fn resolve_google_sa_token_expired_entry_triggers_exchange() {
        let cache = crate::cache::InMemoryCacheStore::new();
        let secret_id = "s1";

        // Insert an already-expired cache entry (TTL=0)
        let value_hash = &sha256_hex(TEST_SA_JSON)[..16];
        let cache_key = format!("sa_token:{secret_id}:{value_hash}");
        cache.set_raw(&cache_key, "ya29.stale", 0).await;

        // Should trigger a fresh exchange (cache miss due to expiry)
        let result = resolve_google_sa_token_with(
            &cache,
            TEST_SA_JSON,
            secret_id,
            ok_fetcher("ya29.refreshed", 3600),
        )
        .await;

        assert_eq!(result.as_deref(), Some("ya29.refreshed"));
    }

    #[tokio::test]
    async fn resolve_google_sa_token_already_expired_fetch_result() {
        let cache = crate::cache::InMemoryCacheStore::new();
        let secret_id = "s1";

        // Exchange returns a token whose expires_at is already in the past
        let result = resolve_google_sa_token_with(
            &cache,
            TEST_SA_JSON,
            secret_id,
            ok_fetcher("ya29.already-expired", -60), // expired 60s ago
        )
        .await;

        // Must NOT return or cache the expired token
        assert!(result.is_none(), "expired token must not be returned");

        let value_hash = &sha256_hex(TEST_SA_JSON)[..16];
        let cache_key = format!("sa_token:{secret_id}:{value_hash}");
        assert!(
            cache.get_raw(&cache_key).await.is_none(),
            "expired token must not be cached"
        );
    }

    #[tokio::test]
    async fn resolve_google_sa_token_invalid_json() {
        let cache = crate::cache::InMemoryCacheStore::new();
        let result = resolve_google_sa_token_with(&cache, "not-json", "s1", |_pk, _ce| {
            Box::pin(async { panic!("should not reach fetcher") })
        })
        .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn resolve_google_sa_token_missing_fields() {
        let cache = crate::cache::InMemoryCacheStore::new();
        // Missing private_key
        let sa_json =
            r#"{"type":"service_account","client_email":"test@test.iam.gserviceaccount.com"}"#;
        let result = resolve_google_sa_token_with(&cache, sa_json, "s1", |_pk, _ce| {
            Box::pin(async { panic!("should not reach fetcher") })
        })
        .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn resolve_google_sa_token_cache_key_changes_on_rotation() {
        // Verify that different decrypted JSON produces a different cache key,
        // ensuring key rotation invalidates the cache for both inline and
        // 1Password-sourced secrets.
        let json_v1 = r#"{"type":"service_account","private_key":"pk_v1","client_email":"a@test.iam.gserviceaccount.com"}"#;
        let json_v2 = r#"{"type":"service_account","private_key":"pk_v2","client_email":"a@test.iam.gserviceaccount.com"}"#;
        let hash1 = &sha256_hex(json_v1)[..16];
        let hash2 = &sha256_hex(json_v2)[..16];
        assert_ne!(
            hash1, hash2,
            "different decrypted JSON must produce different cache keys"
        );
    }

    // ── sha256_hex ─────────────────────────────────────────────────────

    #[test]
    fn sha256_hex_deterministic() {
        let h1 = sha256_hex("hello");
        let h2 = sha256_hex("hello");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // 32 bytes = 64 hex chars
    }

    #[test]
    fn sha256_hex_different_inputs() {
        assert_ne!(sha256_hex("a"), sha256_hex("b"));
    }
}
