//! Conversion from remote-access credentials to proxy injection rules.
//!
//! Maps `CredentialData` from the Bitwarden vault into `ConnectRule` instructions
//! that the gateway can apply during MITM interception.

use bw_rat_client::CredentialData;

use crate::inject::{ConnectRule, Injection};

/// Convert a credential fetched from a Bitwarden vault into injection rules
/// appropriate for the given hostname.
///
/// Uses a known-service registry for API-specific header conventions, with a
/// default fallback of `Authorization: Bearer {password}`.
pub(crate) fn credential_to_rules(hostname: &str, cred: &CredentialData) -> Vec<ConnectRule> {
    let Some(ref password) = cred.password else {
        return vec![];
    };

    if password.is_empty() {
        return vec![];
    }

    let injections = match hostname {
        // Anthropic uses x-api-key header
        "api.anthropic.com" => vec![
            Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: password.clone(),
            },
            Injection::RemoveHeader {
                name: "authorization".to_string(),
            },
        ],

        // Default: Bearer auth (covers OpenAI, OpenRouter, Groq, Mistral, etc.)
        _ => vec![Injection::SetHeader {
            name: "authorization".to_string(),
            value: format!("Bearer {password}"),
        }],
    };

    vec![ConnectRule {
        path_pattern: "*".to_string(),
        injections,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cred_with_password(password: &str) -> CredentialData {
        CredentialData {
            username: None,
            password: Some(password.to_string()),
            totp: None,
            uri: None,
            notes: None,
        }
    }

    #[test]
    fn anthropic_uses_x_api_key() {
        let rules = credential_to_rules("api.anthropic.com", &cred_with_password("sk-ant-123"));
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].path_pattern, "*");
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
    fn openai_uses_bearer() {
        let rules = credential_to_rules("api.openai.com", &cred_with_password("sk-proj-abc"));
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
    fn unknown_host_uses_bearer_default() {
        let rules = credential_to_rules("custom.api.com", &cred_with_password("my-key"));
        assert_eq!(rules.len(), 1);
        assert_eq!(
            rules[0].injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer my-key".to_string(),
            }
        );
    }

    #[test]
    fn no_password_returns_empty() {
        let cred = CredentialData {
            username: Some("user".to_string()),
            password: None,
            totp: None,
            uri: None,
            notes: None,
        };
        let rules = credential_to_rules("api.openai.com", &cred);
        assert!(rules.is_empty());
    }

    #[test]
    fn empty_password_returns_empty() {
        let rules = credential_to_rules("api.openai.com", &cred_with_password(""));
        assert!(rules.is_empty());
    }
}
