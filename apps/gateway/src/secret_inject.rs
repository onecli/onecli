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

        "aws" => {
            // Value is JSON: { accessKeyId, secretAccessKey, sessionToken? }.
            // injectionConfig carries { region, service? } (service defaults to
            // "s3"). We emit the internal x-onecli-aws-* headers the SigV4
            // finalizer consumes; the explicit service header lets it sign for
            // S3-compatible endpoints (Hetzner, R2, B2, MinIO) whose hostnames
            // can't be parsed like AWS's.
            let creds: serde_json::Value = match serde_json::from_str(decrypted_value) {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = %e, "aws secret: failed to parse value JSON");
                    return vec![];
                }
            };
            let access_key_id = creds
                .get("accessKeyId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let secret_access_key = creds
                .get("secretAccessKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if access_key_id.is_empty() || secret_access_key.is_empty() {
                warn!("aws secret: missing accessKeyId or secretAccessKey");
                return vec![];
            }

            let config = injection_config.and_then(|v| v.as_object());
            let region = config
                .and_then(|c| c.get("region"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if region.is_empty() {
                warn!("aws secret: missing region in injectionConfig");
                return vec![];
            }
            let service = config
                .and_then(|c| c.get("service"))
                .and_then(|v| v.as_str())
                .unwrap_or("s3");

            let mut injections = vec![
                Injection::SetHeader {
                    name: "x-onecli-aws-access-key-id".to_string(),
                    value: access_key_id.to_string(),
                },
                Injection::SetHeader {
                    name: "x-onecli-aws-secret-access-key".to_string(),
                    value: secret_access_key.to_string(),
                },
                Injection::SetHeader {
                    name: "x-onecli-aws-region".to_string(),
                    value: region.to_string(),
                },
                Injection::SetHeader {
                    name: "x-onecli-aws-service".to_string(),
                    value: service.to_string(),
                },
            ];
            if let Some(token) = creds.get("sessionToken").and_then(|v| v.as_str()) {
                if !token.is_empty() {
                    injections.push(Injection::SetHeader {
                        name: "x-onecli-aws-session-token".to_string(),
                        value: token.to_string(),
                    });
                }
            }
            injections
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

    // ── build_injections: aws ──────────────────────────────────────────

    #[test]
    fn build_injections_aws_s3_compatible() {
        let value = r#"{"accessKeyId":"AKIA...","secretAccessKey":"secret..."}"#;
        let config = serde_json::json!({ "region": "eu-central-1", "service": "s3" });
        let injections = build_injections("aws", value, Some(&config), None);
        assert_eq!(injections.len(), 4);
        assert_eq!(
            injections[0],
            Injection::SetHeader {
                name: "x-onecli-aws-access-key-id".to_string(),
                value: "AKIA...".to_string(),
            }
        );
        assert_eq!(
            injections[3],
            Injection::SetHeader {
                name: "x-onecli-aws-service".to_string(),
                value: "s3".to_string(),
            }
        );
    }

    #[test]
    fn build_injections_aws_defaults_service_and_includes_session_token() {
        let value = r#"{"accessKeyId":"A","secretAccessKey":"S","sessionToken":"T"}"#;
        let config = serde_json::json!({ "region": "us-east-1" });
        let injections = build_injections("aws", value, Some(&config), None);
        assert!(injections.contains(&Injection::SetHeader {
            name: "x-onecli-aws-service".to_string(),
            value: "s3".to_string(),
        }));
        assert!(injections.contains(&Injection::SetHeader {
            name: "x-onecli-aws-session-token".to_string(),
            value: "T".to_string(),
        }));
    }

    #[test]
    fn build_injections_aws_missing_region_is_rejected() {
        let value = r#"{"accessKeyId":"A","secretAccessKey":"S"}"#;
        assert!(build_injections("aws", value, None, None).is_empty());
    }

    #[test]
    fn build_injections_aws_missing_keys_is_rejected() {
        let config = serde_json::json!({ "region": "us-east-1" });
        assert!(build_injections("aws", "{}", Some(&config), None).is_empty());
        assert!(build_injections("aws", "not json", Some(&config), None).is_empty());
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
}
