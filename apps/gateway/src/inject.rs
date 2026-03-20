//! Header injection and agent authentication.
//!
//! This module handles:
//! - Extracting agent tokens from `Proxy-Authorization` headers
//! - Applying injection rules (set_header, remove_header) to forwarded requests
//! - Path pattern matching for injection rules

use base64::Engine;
use hyper::header::{HeaderName, HeaderValue};
use hyper::Request;
use serde::Deserialize;
use tracing::warn;

use crate::vault::VaultCredential;

// ── Data types ──────────────────────────────────────────────────────────

/// A single injection instruction returned by the API.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // all variants operate on headers — the suffix is intentional
pub(crate) enum Injection {
    SetHeader {
        name: String,
        value: String,
    },
    /// Replace a header only if it already exists in the request.
    /// Used for OAuth: replace Authorization when the SDK sends the exchange
    /// request, but leave x-api-key untouched on subsequent requests.
    ReplaceHeader {
        name: String,
        value: String,
    },
    RemoveHeader {
        name: String,
    },
}

/// A rule matching a path pattern with header injection instructions.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub(crate) struct InjectionRule {
    pub path_pattern: String,
    pub injections: Vec<Injection>,
}

// ── Agent token extraction ──────────────────────────────────────────────

/// Extract the agent access token from the `Proxy-Authorization: Basic base64({token}:)` header.
/// Returns `None` if the header is missing or malformed.
pub(crate) fn extract_agent_token<T>(req: &Request<T>) -> Option<String> {
    let value = req.headers().get("proxy-authorization")?.to_str().ok()?;
    let encoded = value.strip_prefix("Basic ")?.trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded_str = String::from_utf8(decoded).ok()?;
    // Format is "{username}:{token}" — extract the token from the password field.
    // Follows the convention of GitHub/GitLab/Bitbucket: dummy username, token as password.
    // Also handles legacy "{token}:" format (token as username, empty password).
    let token = match decoded_str.split_once(':') {
        Some((_, pass)) if !pass.is_empty() => pass,
        Some((user, _)) => user, // empty password → token is the username
        None => &decoded_str,
    };
    Some(token.to_string())
}

// ── Injection application ───────────────────────────────────────────────

/// Apply injection rules to the request headers.
/// Returns the number of injection actions applied.
pub(crate) fn apply_injections(
    headers: &mut hyper::HeaderMap,
    request_path: &str,
    rules: &[InjectionRule],
) -> usize {
    let mut count = 0;

    for rule in rules {
        if !path_matches(request_path, &rule.path_pattern) {
            continue;
        }

        for injection in &rule.injections {
            match injection {
                Injection::SetHeader { name, value } => {
                    if let (Ok(header_name), Ok(header_value)) = (
                        HeaderName::from_bytes(name.as_bytes()),
                        HeaderValue::from_str(value),
                    ) {
                        headers.insert(header_name, header_value);
                        count += 1;
                    } else {
                        warn!(
                            header = %name,
                            "injection skipped: invalid header name or value"
                        );
                    }
                }
                Injection::ReplaceHeader { name, value } => {
                    if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
                        if headers.contains_key(&header_name) {
                            if let Ok(header_value) = HeaderValue::from_str(value) {
                                headers.insert(header_name, header_value);
                                count += 1;
                            }
                        }
                    }
                }
                Injection::RemoveHeader { name } => {
                    if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
                        if headers.remove(&header_name).is_some() {
                            count += 1;
                        }
                    }
                }
            }
        }
    }

    count
}

/// Check if a request path matches a rule's path pattern.
/// Supports: `"*"` (matches everything), `"/prefix/*"` (prefix match), exact match.
pub(crate) fn path_matches(request_path: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix("/*") {
        // "/v1/*" matches "/v1/messages", "/v1/", but not "/v2/foo"
        return request_path == prefix
            || (request_path.starts_with(prefix)
                && request_path.as_bytes().get(prefix.len()) == Some(&b'/'));
    }
    // Exact match
    request_path == pattern
}

// ── Vault credential → injection rules ──────────────────────────────

/// Convert a vault credential to injection rules for a given hostname.
/// Anthropic uses `x-api-key`, everything else defaults to `Authorization: Bearer`.
pub(crate) fn vault_credential_to_rules(
    hostname: &str,
    cred: &VaultCredential,
) -> Vec<InjectionRule> {
    let password = match cred.password.as_deref() {
        Some(p) if !p.is_empty() => p,
        _ => return vec![],
    };

    let injections = match hostname {
        "api.anthropic.com" => vec![
            Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: password.to_string(),
            },
            Injection::RemoveHeader {
                name: "authorization".to_string(),
            },
        ],
        _ => vec![Injection::SetHeader {
            name: "authorization".to_string(),
            value: format!("Bearer {password}"),
        }],
    };

    vec![InjectionRule {
        path_pattern: "*".to_string(),
        injections,
    }]
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use hyper::Method;

    use super::*;

    // ── Agent token extraction ──────────────────────────────────────────

    /// Helper: build a minimal request with an optional Proxy-Authorization header.
    fn request_with_proxy_auth(auth: Option<&str>) -> Request<()> {
        let mut builder = Request::builder()
            .method(Method::CONNECT)
            .uri("example.com:443");
        if let Some(value) = auth {
            builder = builder.header("proxy-authorization", value);
        }
        builder.body(()).expect("build request")
    }

    fn encode_basic_auth(token: &str) -> String {
        // Convention: dummy username "x", token as password (like GitHub/GitLab)
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("x:{token}"));
        format!("Basic {encoded}")
    }

    #[test]
    fn extract_token_valid() {
        // Standard format: x:token (token in password field)
        let req = request_with_proxy_auth(Some(&encode_basic_auth("aoc_test123")));
        assert_eq!(extract_agent_token(&req).as_deref(), Some("aoc_test123"));
    }

    #[test]
    fn extract_token_legacy_username_format() {
        // Legacy format: token: (token in username field, empty password)
        let encoded = base64::engine::general_purpose::STANDARD.encode("aoc_legacy:");
        let req = request_with_proxy_auth(Some(&format!("Basic {encoded}")));
        assert_eq!(extract_agent_token(&req).as_deref(), Some("aoc_legacy"));
    }

    #[test]
    fn extract_token_without_colon() {
        // Some clients might send just the token without ":"
        let encoded = base64::engine::general_purpose::STANDARD.encode("aoc_nocolon");
        let req = request_with_proxy_auth(Some(&format!("Basic {encoded}")));
        assert_eq!(extract_agent_token(&req).as_deref(), Some("aoc_nocolon"));
    }

    #[test]
    fn extract_token_missing_header() {
        let req = request_with_proxy_auth(None);
        assert_eq!(extract_agent_token(&req), None);
    }

    #[test]
    fn extract_token_wrong_scheme() {
        let req = request_with_proxy_auth(Some("Bearer some_token"));
        assert_eq!(extract_agent_token(&req), None);
    }

    #[test]
    fn extract_token_invalid_base64() {
        let req = request_with_proxy_auth(Some("Basic !!!not-base64!!!"));
        assert_eq!(extract_agent_token(&req), None);
    }

    #[test]
    fn extract_token_empty_value() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(":");
        let req = request_with_proxy_auth(Some(&format!("Basic {encoded}")));
        // Empty token (just ":") → returns Some("") which the caller rejects
        assert_eq!(extract_agent_token(&req).as_deref(), Some(""));
    }

    // ── path_matches ────────────────────────────────────────────────────

    #[test]
    fn path_wildcard_matches_everything() {
        assert!(path_matches("/v1/messages", "*"));
        assert!(path_matches("/", "*"));
        assert!(path_matches("/any/path/here", "*"));
    }

    #[test]
    fn path_prefix_wildcard() {
        assert!(path_matches("/v1/messages", "/v1/*"));
        assert!(path_matches("/v1/", "/v1/*"));
        assert!(path_matches("/v1/completions/stream", "/v1/*"));
        // The prefix itself without trailing slash
        assert!(path_matches("/v1", "/v1/*"));
    }

    #[test]
    fn path_prefix_wildcard_rejects_non_matching() {
        assert!(!path_matches("/v2/messages", "/v1/*"));
        assert!(!path_matches("/", "/v1/*"));
        assert!(!path_matches("/v1beta/foo", "/v1/*"));
    }

    #[test]
    fn path_exact() {
        assert!(path_matches("/v1/messages", "/v1/messages"));
        assert!(!path_matches("/v1/messages/", "/v1/messages"));
        assert!(!path_matches("/v1/other", "/v1/messages"));
    }

    // ── apply_injections ────────────────────────────────────────────────

    fn make_rule(path_pattern: &str, injections: Vec<Injection>) -> InjectionRule {
        InjectionRule {
            path_pattern: path_pattern.to_string(),
            injections,
        }
    }

    fn set_header(name: &str, value: &str) -> Injection {
        Injection::SetHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    fn remove_header(name: &str) -> Injection {
        Injection::RemoveHeader {
            name: name.to_string(),
        }
    }

    #[test]
    fn inject_set_header() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("application/json"));

        let rules = vec![make_rule("*", vec![set_header("x-api-key", "sk-ant-123")])];

        let count = apply_injections(&mut headers, "/v1/messages", &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("x-api-key").unwrap(), "sk-ant-123");
        // Original header preserved
        assert_eq!(headers.get("accept").unwrap(), "application/json");
    }

    #[test]
    fn inject_set_header_overwrites_existing() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer old-token"),
        );

        let rules = vec![make_rule(
            "*",
            vec![set_header("authorization", "Bearer new-token")],
        )];

        let count = apply_injections(&mut headers, "/", &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("authorization").unwrap(), "Bearer new-token");
    }

    #[test]
    fn inject_replace_header_when_present() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer placeholder"),
        );

        let rules = vec![make_rule(
            "*",
            vec![Injection::ReplaceHeader {
                name: "authorization".to_string(),
                value: "Bearer real-token".to_string(),
            }],
        )];

        let count = apply_injections(&mut headers, "/", &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("authorization").unwrap(), "Bearer real-token");
    }

    #[test]
    fn inject_replace_header_skips_when_absent() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("x-api-key", HeaderValue::from_static("temp-key"));

        let rules = vec![make_rule(
            "*",
            vec![Injection::ReplaceHeader {
                name: "authorization".to_string(),
                value: "Bearer real-token".to_string(),
            }],
        )];

        let count = apply_injections(&mut headers, "/", &rules);
        assert_eq!(count, 0);
        assert!(headers.get("authorization").is_none());
        // x-api-key untouched
        assert_eq!(headers.get("x-api-key").unwrap(), "temp-key");
    }

    #[test]
    fn inject_remove_header() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer token"));
        headers.insert("accept", HeaderValue::from_static("application/json"));

        let rules = vec![make_rule("*", vec![remove_header("authorization")])];

        let count = apply_injections(&mut headers, "/", &rules);
        assert_eq!(count, 1);
        assert!(headers.get("authorization").is_none());
        // Other headers preserved
        assert_eq!(headers.get("accept").unwrap(), "application/json");
    }

    #[test]
    fn inject_remove_nonexistent_counts_zero() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("application/json"));

        let rules = vec![make_rule("*", vec![remove_header("x-not-present")])];

        let count = apply_injections(&mut headers, "/", &rules);
        assert_eq!(count, 0);
    }

    #[test]
    fn inject_combined_set_and_remove() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer old"));

        let rules = vec![make_rule(
            "*",
            vec![
                set_header("x-api-key", "sk-ant-123"),
                remove_header("authorization"),
            ],
        )];

        let count = apply_injections(&mut headers, "/v1/messages", &rules);
        assert_eq!(count, 2);
        assert_eq!(headers.get("x-api-key").unwrap(), "sk-ant-123");
        assert!(headers.get("authorization").is_none());
    }

    #[test]
    fn inject_path_mismatch_skips_rule() {
        let mut headers = hyper::HeaderMap::new();

        let rules = vec![make_rule(
            "/v1/*",
            vec![set_header("x-api-key", "sk-ant-123")],
        )];

        let count = apply_injections(&mut headers, "/v2/messages", &rules);
        assert_eq!(count, 0);
        assert!(headers.get("x-api-key").is_none());
    }

    #[test]
    fn inject_multiple_rules_different_paths() {
        let mut headers = hyper::HeaderMap::new();

        let rules = vec![
            make_rule("/v1/*", vec![set_header("x-api-key", "key-v1")]),
            make_rule("/v2/*", vec![set_header("x-api-key", "key-v2")]),
        ];

        // Only the /v1 rule should match
        let count = apply_injections(&mut headers, "/v1/messages", &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("x-api-key").unwrap(), "key-v1");
    }

    #[test]
    fn inject_no_rules_returns_zero() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("*/*"));

        let count = apply_injections(&mut headers, "/anything", &[]);
        assert_eq!(count, 0);
    }

    // ── vault_credential_to_rules ──────────────────────────────────────

    fn cred(password: Option<&str>) -> VaultCredential {
        VaultCredential {
            username: None,
            password: password.map(|s| s.to_string()),
        }
    }

    #[test]
    fn vault_cred_anthropic_uses_x_api_key() {
        let rules = vault_credential_to_rules("api.anthropic.com", &cred(Some("sk-ant-123")));
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].injections.len(), 2);
        assert_eq!(
            rules[0].injections[0],
            Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: "sk-ant-123".to_string(),
            }
        );
        assert_eq!(
            rules[0].injections[1],
            Injection::RemoveHeader {
                name: "authorization".to_string(),
            }
        );
    }

    #[test]
    fn vault_cred_default_uses_bearer() {
        let rules = vault_credential_to_rules("api.openai.com", &cred(Some("sk-proj-abc")));
        assert_eq!(rules.len(), 1);
        assert_eq!(
            rules[0].injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer sk-proj-abc".to_string(),
            }
        );
    }

    #[test]
    fn vault_cred_no_password_returns_empty() {
        assert!(vault_credential_to_rules("api.openai.com", &cred(None)).is_empty());
    }

    #[test]
    fn vault_cred_empty_password_returns_empty() {
        assert!(vault_credential_to_rules("api.openai.com", &cred(Some(""))).is_empty());
    }
}
