//! Shared utility functions.

use base64::Engine;

/// Parse the `exp` claim from a JWT token without full validation.
pub(crate) fn parse_jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    json.get("exp")?.as_i64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_jwt_exp_extracts_expiry() {
        // JWT with payload {"exp": 1700000000}
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.signature";
        assert_eq!(parse_jwt_exp(token), Some(1700000000));
    }

    #[test]
    fn parse_jwt_exp_returns_none_for_invalid_token() {
        assert_eq!(parse_jwt_exp("not-a-jwt"), None);
        assert_eq!(parse_jwt_exp(""), None);
        assert_eq!(parse_jwt_exp("a.!!!.c"), None);
    }
}
