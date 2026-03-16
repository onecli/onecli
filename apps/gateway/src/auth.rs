//! Gateway authentication for browser requests.
//!
//! Supports two modes controlled by the `AUTH_MODE` env var:
//! - `local`: bypasses JWT validation, looks up the "local-admin" user directly.
//! - `oauth` (default): validates a NextAuth session cookie JWT (HS256).

use std::sync::OnceLock;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use hyper::HeaderMap;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use sqlx::PgPool;
use tracing::warn;

use crate::db;
use crate::gateway::GatewayState;

// ── AuthError ────────────────────────────────────────────────────────────

/// Authentication error — always returns 401 Unauthorized.
#[derive(Debug)]
pub(crate) struct AuthError(String);

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "auth error: {}", self.0)
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::UNAUTHORIZED, self.0).into_response()
    }
}

// ── JWT claims ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SessionClaims {
    sub: String,
}

// ── Cached env reads ─────────────────────────────────────────────────────

fn auth_mode() -> &'static str {
    static AUTH_MODE: OnceLock<String> = OnceLock::new();
    AUTH_MODE.get_or_init(|| std::env::var("AUTH_MODE").unwrap_or_else(|_| "oauth".to_string()))
}

fn nextauth_secret() -> Option<&'static str> {
    static SECRET: OnceLock<Option<String>> = OnceLock::new();
    SECRET
        .get_or_init(|| std::env::var("NEXTAUTH_SECRET").ok())
        .as_deref()
}

// ── Extractor ────────────────────────────────────────────────────────────

/// Authenticated user extracted from browser session cookies.
///
/// Add as an Axum handler parameter to require authentication:
/// ```ignore
/// async fn list_secrets(auth: AuthUser) -> impl IntoResponse { ... }
/// ```
pub(crate) struct AuthUser {
    pub user_id: String,
}

impl FromRequestParts<GatewayState> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &GatewayState,
    ) -> Result<Self, Self::Rejection> {
        let user_id = validate_request(&state.policy_engine.pool, &parts.headers).await?;
        Ok(Self { user_id })
    }
}

// ── Validation ───────────────────────────────────────────────────────────

/// Validate an incoming browser request and return the internal user ID.
async fn validate_request(pool: &PgPool, headers: &HeaderMap) -> Result<String, AuthError> {
    match auth_mode() {
        "local" => validate_local(pool).await,
        _ => validate_oauth(pool, headers).await,
    }
}

// ── Local mode ───────────────────────────────────────────────────────────

async fn validate_local(pool: &PgPool) -> Result<String, AuthError> {
    let user = db::find_user_by_external_auth_id(pool, "local-admin")
        .await
        .map_err(|e| {
            warn!(error = %e, "local auth: db error");
            AuthError("internal error".to_string())
        })?
        .ok_or_else(|| {
            warn!("local auth: local-admin user not found");
            AuthError("user not found".to_string())
        })?;

    Ok(user.id)
}

// ── OAuth mode ───────────────────────────────────────────────────────────

async fn validate_oauth(pool: &PgPool, headers: &HeaderMap) -> Result<String, AuthError> {
    // 1. Extract session token from cookies
    let cookie_header = headers
        .get(hyper::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            warn!("oauth auth: no cookie header");
            AuthError("missing cookie".to_string())
        })?;

    let token = parse_cookie(cookie_header, "authjs.session-token").ok_or_else(|| {
        warn!("oauth auth: session token cookie not found");
        AuthError("missing session token".to_string())
    })?;

    // 2. Read NEXTAUTH_SECRET
    let secret = nextauth_secret().ok_or_else(|| {
        warn!("oauth auth: NEXTAUTH_SECRET not set");
        AuthError("server misconfigured".to_string())
    })?;

    // 3. Decode JWT (HS256)
    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;

    let token_data = decode::<SessionClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|e| {
        warn!(error = %e, "oauth auth: JWT decode failed");
        AuthError("invalid session token".to_string())
    })?;

    let sub = &token_data.claims.sub;

    // 4. Look up user by external auth ID
    let user = db::find_user_by_external_auth_id(pool, sub)
        .await
        .map_err(|e| {
            warn!(error = %e, "oauth auth: db error");
            AuthError("internal error".to_string())
        })?
        .ok_or_else(|| {
            warn!(sub = %sub, "oauth auth: user not found");
            AuthError("user not found".to_string())
        })?;

    Ok(user.id)
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Parse a specific cookie value from a Cookie header string.
fn parse_cookie<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').find_map(|pair| {
        let pair = pair.trim();
        let (key, value) = pair.split_once('=')?;
        if key.trim() == name {
            Some(value.trim())
        } else {
            None
        }
    })
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cookie_finds_value() {
        let header = "other=abc; authjs.session-token=eyJhbGciOiJIUzI1NiJ9.test; path=/";
        assert_eq!(
            parse_cookie(header, "authjs.session-token"),
            Some("eyJhbGciOiJIUzI1NiJ9.test")
        );
    }

    #[test]
    fn parse_cookie_missing() {
        let header = "other=abc; foo=bar";
        assert_eq!(parse_cookie(header, "authjs.session-token"), None);
    }

    #[test]
    fn parse_cookie_empty() {
        assert_eq!(parse_cookie("", "authjs.session-token"), None);
    }
}
