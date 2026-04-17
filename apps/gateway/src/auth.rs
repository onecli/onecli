//! Gateway authentication for browser and API requests.
//!
//! Supports two modes controlled by the `AUTH_MODE` env var:
//! - `local`: bypasses JWT validation, looks up the "local-admin" user directly.
//! - `oauth` (default): accepts three auth methods (tried in order):
//!   1. API key: `Authorization: Bearer oc_...`
//!   2. OIDC access token: `Authorization: Bearer <jwt>` (validated via JWKS)
//!   3. NextAuth session cookie: `authjs.session-token` (HS256 via NEXTAUTH_SECRET)

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
use crate::jwks::JwksManager;

// ── AuthError ────────────────────────────────────────────────────────────

/// Authentication error — always returns 401 Unauthorized.
#[derive(Debug)]
pub(crate) struct AuthError(pub(crate) String);

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

// ── NextAuth cookie claims ──────────────────────────────────────────────

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

/// Authenticated user extracted from the request.
///
/// Authentication methods (tried in order):
/// 1. API key: `Authorization: Bearer oc_...` (OneCLI API key)
/// 2. OIDC access token: `Authorization: Bearer <jwt>` (validated via JWKS)
/// 3. NextAuth session cookie: `authjs.session-token` (HS256 via NEXTAUTH_SECRET)
/// 4. Local mode: bypasses auth, returns the "local-admin" user
///
/// Add as an Axum handler parameter to require authentication:
/// ```ignore
/// async fn list_secrets(auth: AuthUser) -> impl IntoResponse { ... }
/// ```
pub(crate) struct AuthUser {
    pub user_id: String,
    pub account_id: String,
}

impl FromRequestParts<GatewayState> for AuthUser {
    type Rejection = AuthError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &GatewayState,
    ) -> Result<Self, Self::Rejection> {
        let pool = &state.policy_engine.pool;

        // Try API key auth first (Authorization: Bearer oc_...)
        if let Some(api_key_user) = validate_api_key(pool, &parts.headers).await {
            return Ok(api_key_user);
        }

        // Fall back to session auth (OIDC JWT, NextAuth cookie, or local mode)
        let user_id = validate_request(pool, &parts.headers, state.jwks.as_ref()).await?;

        // Resolve account from membership
        let account_id = db::find_account_id_by_user(pool, &user_id)
            .await
            .map_err(|e| {
                warn!(error = %e, "auth: failed to resolve account");
                AuthError("internal error".to_string())
            })?
            .ok_or_else(|| {
                warn!(user_id = %user_id, "auth: no account found for user");
                AuthError("no account found".to_string())
            })?;

        Ok(Self {
            user_id,
            account_id,
        })
    }
}

// ── API key auth ─────────────────────────────────────────────────────────

/// Try to authenticate via `Authorization: Bearer oc_...` API key.
/// Returns `None` if no API key is present (falls through to session auth).
async fn validate_api_key(pool: &PgPool, headers: &HeaderMap) -> Option<AuthUser> {
    let auth_header = headers.get(hyper::header::AUTHORIZATION)?.to_str().ok()?;
    let token = auth_header
        .strip_prefix("Bearer ")
        .or_else(|| auth_header.strip_prefix("bearer "))?;

    if !token.starts_with("oc_") {
        return None;
    }

    let api_key = db::find_api_key(pool, token)
        .await
        .map_err(|e| warn!(error = %e, "api key auth: db error"))
        .ok()??;

    Some(AuthUser {
        user_id: api_key.user_id,
        account_id: api_key.account_id,
    })
}

// ── Session auth ─────────────────────────────────────────────────────────

/// Validate an incoming request and return the internal user ID.
async fn validate_request(
    pool: &PgPool,
    headers: &HeaderMap,
    jwks: Option<&JwksManager>,
) -> Result<String, AuthError> {
    match auth_mode() {
        "local" => validate_local(pool).await,
        _ => validate_oauth(pool, headers, jwks).await,
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

/// Authenticate via OIDC access token (Bearer header) or NextAuth session cookie.
///
/// Tries the Bearer token first (via JWKS validation), then falls back to
/// the NextAuth session cookie (HS256 with NEXTAUTH_SECRET).
async fn validate_oauth(
    pool: &PgPool,
    headers: &HeaderMap,
    jwks: Option<&JwksManager>,
) -> Result<String, AuthError> {
    // 1. Try OIDC access token from Authorization header
    if let Some(sub) = try_bearer_jwt(headers, jwks).await {
        return lookup_user(pool, &sub).await;
    }

    // 2. Fall back to NextAuth session cookie
    validate_nextauth_cookie(pool, headers).await
}

/// Try to validate a non-`oc_` Bearer token as an OIDC access token.
/// Returns the `sub` claim on success, `None` if no valid token found.
async fn try_bearer_jwt(headers: &HeaderMap, jwks: Option<&JwksManager>) -> Option<String> {
    let jwks = jwks?;

    let auth_header = headers.get(hyper::header::AUTHORIZATION)?.to_str().ok()?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .or_else(|| auth_header.strip_prefix("bearer "))?;

    // Skip oc_ tokens — those are API keys handled elsewhere
    if token.starts_with("oc_") {
        return None;
    }

    match jwks.validate(token).await {
        Ok(claims) => Some(claims.sub),
        Err(e) => {
            warn!(error = %e, "OIDC bearer auth: JWT validation failed");
            None
        }
    }
}

/// Validate a NextAuth session cookie (HS256 JWT signed with NEXTAUTH_SECRET).
async fn validate_nextauth_cookie(pool: &PgPool, headers: &HeaderMap) -> Result<String, AuthError> {
    let cookie_header = headers
        .get(hyper::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            warn!("oauth auth: no cookie header");
            AuthError("missing authentication".to_string())
        })?;

    let token = parse_cookie(cookie_header, "authjs.session-token").ok_or_else(|| {
        warn!("oauth auth: session token cookie not found");
        AuthError("missing session token".to_string())
    })?;

    let secret = nextauth_secret().ok_or_else(|| {
        warn!("oauth auth: NEXTAUTH_SECRET not set");
        AuthError("server misconfigured".to_string())
    })?;

    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;

    let token_data = decode::<SessionClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|e| {
        warn!(error = %e, "oauth auth: NextAuth JWT decode failed");
        AuthError("invalid session token".to_string())
    })?;

    lookup_user(pool, &token_data.claims.sub).await
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Look up an internal user ID from an external auth ID (OIDC `sub` or NextAuth subject).
async fn lookup_user(pool: &PgPool, external_auth_id: &str) -> Result<String, AuthError> {
    let user = db::find_user_by_external_auth_id(pool, external_auth_id)
        .await
        .map_err(|e| {
            warn!(error = %e, "oauth auth: db error");
            AuthError("internal error".to_string())
        })?
        .ok_or_else(|| {
            warn!(sub = %external_auth_id, "oauth auth: user not found");
            AuthError("user not found".to_string())
        })?;

    Ok(user.id)
}

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
