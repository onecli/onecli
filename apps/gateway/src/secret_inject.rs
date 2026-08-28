//! Secret-to-injection mapping and OpenAI OAuth token refresh.
//!
//! Converts decrypted secret values into injection instructions based on the
//! secret type (anthropic, openai, generic). OpenAI supports both API keys
//! (plain string) and OAuth credentials (JSON with tokens). Also handles
//! OpenAI OAuth token refresh and credential persistence.

use tracing::{debug, warn};

use crate::crypto::CryptoService;
use crate::db;
use crate::inject::Injection;
use crate::util;

/// Whether a secret's metadata marks it as an OAuth (ChatGPT session)
/// credential. Missing/other metadata means api-key — the historical default
/// and how every pre-authMode row behaves.
#[must_use]
pub(crate) fn is_oauth_mode(metadata: Option<&serde_json::Value>) -> bool {
    metadata
        .and_then(|m| m.get("authMode"))
        .and_then(|v| v.as_str())
        == Some("oauth")
}

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
            if is_oauth_mode(metadata) {
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

/// The host-match patterns a secret of `secret_type` injects its credential on,
/// given its stored `host_pattern` and `metadata`. Single source of truth shared
/// by the connect-time injection filter (`secret_injects_on_host`) AND policy
/// enforcement (`db::find_secret_hosts` → v2 `Target::Secret`), so injection
/// coverage ⊆ enforcement coverage BY CONSTRUCTION — the secret analog of the
/// provider-registry host fix. Every secret covers its own stored `host_pattern`;
/// only an OAuth-mode `openai` secret (`metadata.authMode == "oauth"`) adds the
/// extra hosts one ChatGPT credential is valid across (`api.openai.com`, ChatGPT,
/// and their subdomains) regardless of which host it was stored under. An
/// API-key-mode secret — or one with no metadata at all, which is the same thing
/// (`build_injections` treats missing metadata as api-key, and the pre-authMode
/// legacy rows are all API keys) — stays on its stored host: an OpenAI API key is
/// not a ChatGPT credential, and expanding it both leaked the key beyond its
/// configured host and broke Codex's OAuth login (#490). Returned as
/// `host_matches` patterns, so `*.openai.com` covers every `.openai.com`
/// subdomain.
#[must_use]
pub(crate) fn secret_host_patterns(
    secret_type: &str,
    host_pattern: &str,
    metadata: Option<&serde_json::Value>,
) -> Vec<String> {
    let mut patterns = vec![host_pattern.to_string()];
    if secret_type == "openai" && is_oauth_mode(metadata) {
        for extra in [
            "api.openai.com",
            "chatgpt.com",
            "*.chatgpt.com",
            "*.openai.com",
        ] {
            if !patterns.iter().any(|p| p == extra) {
                patterns.push(extra.to_string());
            }
        }
    }
    patterns
}

/// OpenAI's OAuth token service. A real Codex authorization-code (or refresh)
/// exchange there authenticates with its own OAuth parameters — an injected
/// `Authorization` header makes it fail with 401 `invalid_client` (#490) — and
/// the default-interception contract promises non-synthetic login requests are
/// forwarded untouched (`default_interceptions::codex_oauth_refresh`). So
/// `openai` secrets NEVER inject here, even though the OAuth-mode pattern set
/// reaches it via `*.openai.com`. Injection-only: enforcement keeps the full
/// pattern set (a rule on the secret still covers this host — wider is
/// fail-safe).
const OPENAI_AUTH_HOST: &str = "auth.openai.com";

/// Whether a secret's credential is injected on `hostname` — the metadata-aware
/// pattern match minus the `auth.openai.com` carve-out. The connect-time
/// injection filter (`connect::resolve_secret_injections`) and the availability
/// probe (`connect::has_available_credentials`) both go through here, so "would
/// inject" and "counts as an available credential" can never disagree.
#[must_use]
pub(crate) fn secret_injects_on_host(
    secret_type: &str,
    host_pattern: &str,
    metadata: Option<&serde_json::Value>,
    hostname: &str,
) -> bool {
    if secret_type == "openai" && hostname.eq_ignore_ascii_case(OPENAI_AUTH_HOST) {
        return false;
    }
    secret_host_patterns(secret_type, host_pattern, metadata)
        .iter()
        .any(|p| crate::connect::host_matches(hostname, p))
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

const OPENAI_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";

/// Public OAuth client id of the Codex CLI — the app that issued the vaulted
/// ChatGPT session we are refreshing.
///
/// `auth.openai.com` rejects a `refresh_token` grant that omits it with
/// 400 `Missing 'client_id'`, so without this the refresh can never succeed and
/// the session hard-expires with the access token (~10 days).
///
/// A constant rather than configuration: it identifies OpenAI's own first-party
/// CLI, is hardcoded in the open-source Codex client, and the vaulted
/// `auth.json` has no `client_id` field to read it from. That is unlike the
/// OAuth providers in `apps.rs`, which take a `client_id_env` because an
/// operator supplies their own app there.
const OPENAI_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Form body for the refresh_token grant. Split out from the request so the
/// field set can be asserted — sending it needs the network.
fn refresh_token_form(refresh_token: &str) -> [(&'static str, &str); 3] {
    [
        ("client_id", OPENAI_CODEX_CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ]
}

/// Refresh an OpenAI OAuth access_token using the refresh_token.
async fn refresh_openai_oauth_token(
    refresh_token: &str,
) -> anyhow::Result<(String, Option<String>)> {
    let resp = reqwest::Client::new()
        .post(OPENAI_TOKEN_URL)
        .timeout(std::time::Duration::from_secs(10))
        .form(&refresh_token_form(refresh_token))
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

    // ── openai oauth refresh ───────────────────────────────────────────

    // The regression guard for a refresh that never once succeeded: without
    // `client_id`, auth.openai.com answers 400 "Missing 'client_id'", the
    // gateway falls through to the expired token, and every chatgpt.com request
    // 401s until the user re-authenticates by hand.
    #[test]
    fn refresh_token_form_sends_client_id_and_the_grant() {
        let form = refresh_token_form("rt-abc123");

        assert_eq!(
            form,
            [
                ("client_id", OPENAI_CODEX_CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", "rt-abc123"),
            ]
        );
    }

    // Pinned as a literal: a typo here is not a compile error and not a test
    // failure elsewhere — it surfaces as `invalid_client` from OpenAI, inside a
    // warning, roughly ten days after anyone touched this.
    #[test]
    fn client_id_is_the_codex_cli_app() {
        assert_eq!(OPENAI_CODEX_CLIENT_ID, "app_EMoamEEZ73f0CkXaXp7hrann");
    }

    // Same reasoning: the endpoint is only exercised against the network, so a
    // wrong URL fails at runtime rather than here.
    #[test]
    fn token_url_is_the_openai_oauth_endpoint() {
        assert_eq!(OPENAI_TOKEN_URL, "https://auth.openai.com/oauth/token");
    }

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

    // ── build_injections: unknown ──────────────────────────────────────

    #[test]
    fn build_injections_unknown_type() {
        let injections = build_injections("unknown", "value", None, None);
        assert!(injections.is_empty());
    }

    // ── secret_host_patterns (injection ⊆ enforcement, the OpenAI bypass) ────

    #[test]
    fn secret_host_patterns_openai_covers_all_its_hosts() {
        // One ChatGPT (OAuth-mode) credential is valid across api.openai.com,
        // ChatGPT, and the subdomains — enforcement must cover the whole set.
        let oauth = serde_json::json!({ "authMode": "oauth" });
        assert_eq!(
            secret_host_patterns("openai", "api.openai.com", Some(&oauth)),
            vec![
                "api.openai.com".to_string(),
                "chatgpt.com".to_string(),
                "*.chatgpt.com".to_string(),
                "*.openai.com".to_string(),
            ]
        );
    }

    #[test]
    fn secret_host_patterns_openai_api_key_stays_on_its_host() {
        // THE #490 REGRESSION GUARD: an API-key secret stored for
        // api.openai.com must NOT expand to *.openai.com — the expansion
        // injected `Authorization: Bearer sk-...` into auth.openai.com token
        // exchanges (401 invalid_client, breaking `codex login`) and sent the
        // key beyond its configured host.
        let api_key = serde_json::json!({ "authMode": "api-key" });
        assert_eq!(
            secret_host_patterns("openai", "api.openai.com", Some(&api_key)),
            vec!["api.openai.com".to_string()]
        );
        // No metadata ≡ api-key: `build_injections` injects such a secret as a
        // bearer API key, and the pre-authMode legacy rows are all API keys —
        // expanding them would recreate the same broken injection.
        assert_eq!(
            secret_host_patterns("openai", "api.openai.com", None),
            vec!["api.openai.com".to_string()]
        );
    }

    #[test]
    fn secret_host_patterns_openai_dedups_the_stored_host() {
        // Stored under chatgpt.com (Codex/OAuth mode): same set, no duplicate.
        let oauth = serde_json::json!({ "authMode": "oauth" });
        assert_eq!(
            secret_host_patterns("openai", "chatgpt.com", Some(&oauth)),
            vec![
                "chatgpt.com".to_string(),
                "api.openai.com".to_string(),
                "*.chatgpt.com".to_string(),
                "*.openai.com".to_string(),
            ]
        );
    }

    #[test]
    fn secret_host_patterns_other_types_are_just_their_host() {
        // No expansion for symmetric types — enforcement already == injection.
        assert_eq!(
            secret_host_patterns("anthropic", "api.anthropic.com", None),
            vec!["api.anthropic.com".to_string()]
        );
        assert_eq!(
            secret_host_patterns("generic", "internal.example.com", None),
            vec!["internal.example.com".to_string()]
        );
    }

    // ── secret_injects_on_host (the auth.openai.com carve-out) ──────────────

    #[test]
    fn openai_secrets_never_inject_on_the_oauth_token_service() {
        // Real Codex logins must reach auth.openai.com untouched — for BOTH
        // modes. OAuth-mode reaches it via *.openai.com and an injected Bearer
        // access token fails the exchange exactly like an API key does.
        let oauth = serde_json::json!({ "authMode": "oauth" });
        assert!(!secret_injects_on_host(
            "openai",
            "chatgpt.com",
            Some(&oauth),
            "auth.openai.com"
        ));
        let api_key = serde_json::json!({ "authMode": "api-key" });
        assert!(!secret_injects_on_host(
            "openai",
            "api.openai.com",
            Some(&api_key),
            "auth.openai.com"
        ));
        // Even a secret explicitly stored FOR auth.openai.com is refused: no
        // OpenAI credential shape authenticates there via headers.
        assert!(!secret_injects_on_host(
            "openai",
            "auth.openai.com",
            None,
            "auth.openai.com"
        ));
        // Case-insensitive like every host comparison on this path.
        assert!(!secret_injects_on_host(
            "openai",
            "chatgpt.com",
            Some(&oauth),
            "Auth.OpenAI.com"
        ));
    }

    #[test]
    fn secret_injects_on_host_matches_the_pattern_set_elsewhere() {
        let oauth = serde_json::json!({ "authMode": "oauth" });
        // OAuth-mode: the expanded set injects on the sibling hosts...
        assert!(secret_injects_on_host(
            "openai",
            "chatgpt.com",
            Some(&oauth),
            "api.openai.com"
        ));
        assert!(secret_injects_on_host(
            "openai",
            "chatgpt.com",
            Some(&oauth),
            "chatgpt.com"
        ));
        // ...api-key mode only on its stored host...
        let api_key = serde_json::json!({ "authMode": "api-key" });
        assert!(secret_injects_on_host(
            "openai",
            "api.openai.com",
            Some(&api_key),
            "api.openai.com"
        ));
        assert!(!secret_injects_on_host(
            "openai",
            "api.openai.com",
            Some(&api_key),
            "chatgpt.com"
        ));
        // ...and the carve-out is OpenAI-scoped: a generic secret a user
        // deliberately points at auth.openai.com still injects.
        assert!(secret_injects_on_host(
            "generic",
            "auth.openai.com",
            None,
            "auth.openai.com"
        ));
    }
}
