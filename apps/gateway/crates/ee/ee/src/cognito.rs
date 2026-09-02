//! Cognito session validation (Bearer JWT, RS256 via JWKS) — hosted-platform
//! plumbing, not an entitlement-gated feature.
//!
//! The shared auth module owns the SELECTOR (`use_cognito_sessions`: only the
//! cloud edition with a pool configured routes here — auth mode never switches
//! on env residue); this module owns the mechanics: the JWKS cache, the JWT
//! validation, and the `sub` → `User.externalAuthId` lookup. On self-host this
//! code is dead by the selector; `configured()` still answers the pool-id
//! presence probe (initializing the cache object) exactly as the shared
//! `jwks_state()` did before the move.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use hyper::HeaderMap;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use sqlx::PgPool;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use context::auth::{extract_bearer_token, AuthError};

/// Whether Cognito session auth is configured: `COGNITO_USER_POOL_ID` set and
/// non-blank. The pool-id presence half of the session-validator selector —
/// the edition half lives with the selector in `crate::auth`.
pub fn configured() -> bool {
    jwks_state().is_some()
}

/// The Cognito session validator, installed by the composition root when
/// [`context::auth::use_cognito_sessions`] selects cloud session auth.
pub struct CognitoSessionValidator;

#[async_trait::async_trait]
impl context::auth::SessionValidator for CognitoSessionValidator {
    async fn validate(&self, pool: &PgPool, headers: &HeaderMap) -> Result<String, AuthError> {
        validate(pool, headers).await
    }

    fn method(&self) -> &'static str {
        "cognito"
    }
}

/// Cognito ID token claims. The `sub` field is the Cognito user ID; it maps to
/// `User.externalAuthId` in the database — the same value Cognito returns as
/// `userId` from `getCurrentUser()`.
#[derive(Debug, Deserialize)]
struct CognitoClaims {
    sub: String,
}

/// How long to cache JWKS keys before allowing a refresh.
const JWKS_MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(300);

/// A single JWK (JSON Web Key) for RS256 verification.
#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    kty: String,
    n: String,
    e: String,
    #[serde(rename = "use")]
    use_: Option<String>,
}

/// JWKS response from Cognito.
#[derive(Debug, Deserialize)]
struct JwksResponse {
    keys: Vec<Jwk>,
}

/// Cached JWKS keys, keyed by `kid`.
struct JwksCache {
    keys: HashMap<String, DecodingKey>,
    last_fetched: Instant,
    jwks_url: String,
}

impl JwksCache {
    fn new(jwks_url: String) -> Self {
        Self {
            keys: HashMap::new(),
            last_fetched: Instant::now() - JWKS_MIN_REFRESH_INTERVAL,
            jwks_url,
        }
    }

    /// Get the decoding key for a `kid`, fetching from Cognito if needed.
    async fn get_key(&mut self, kid: &str) -> Result<&DecodingKey, AuthError> {
        if !self.keys.contains_key(kid) {
            // Rate-limit JWKS fetches to avoid hammering Cognito on invalid tokens
            if self.last_fetched.elapsed() < JWKS_MIN_REFRESH_INTERVAL {
                return Err(AuthError("unknown signing key".to_string()));
            }
            self.refresh().await?;
        }

        self.keys
            .get(kid)
            .ok_or_else(|| AuthError("unknown signing key".to_string()))
    }

    /// Fetch fresh keys from the Cognito JWKS endpoint.
    async fn refresh(&mut self) -> Result<(), AuthError> {
        let resp: JwksResponse = reqwest::get(&self.jwks_url)
            .await
            .map_err(|e| {
                warn!(error = %e, "cognito auth: failed to fetch JWKS");
                AuthError("failed to fetch signing keys".to_string())
            })?
            .json()
            .await
            .map_err(|e| {
                warn!(error = %e, "cognito auth: failed to parse JWKS");
                AuthError("failed to parse signing keys".to_string())
            })?;

        self.keys.clear();
        for jwk in resp.keys {
            // Only use RSA signing keys (skip encryption keys)
            if jwk.kty != "RSA" || jwk.use_.as_deref() == Some("enc") {
                continue;
            }
            match DecodingKey::from_rsa_components(&jwk.n, &jwk.e) {
                Ok(key) => {
                    self.keys.insert(jwk.kid, key);
                }
                Err(e) => {
                    warn!(error = %e, "cognito auth: failed to parse JWK");
                }
            }
        }

        self.last_fetched = Instant::now();
        Ok(())
    }
}

/// Global JWKS cache, initialized once from environment.
static JWKS: OnceLock<Option<Arc<RwLock<JwksCache>>>> = OnceLock::new();

fn jwks_state() -> &'static Option<Arc<RwLock<JwksCache>>> {
    JWKS.get_or_init(|| {
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        let user_pool_id = match std::env::var("COGNITO_USER_POOL_ID") {
            Ok(id) if !id.trim().is_empty() => id,
            _ => return None,
        };

        let jwks_url = format!(
            "https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json"
        );

        Some(Arc::new(RwLock::new(JwksCache::new(jwks_url))))
    })
}

fn jwks_cache() -> Result<&'static Arc<RwLock<JwksCache>>, AuthError> {
    jwks_state().as_ref().ok_or_else(|| {
        // Generic body — the config detail stays in the log, not the response.
        warn!("cognito auth: COGNITO_USER_POOL_ID env var not set");
        AuthError("unauthorized".to_string())
    })
}

/// Validate a Cognito JWT from the Authorization header and return the internal user ID.
pub async fn validate(pool: &PgPool, headers: &HeaderMap) -> Result<String, AuthError> {
    // 1. Extract bearer token from Authorization header
    let token = extract_bearer_token(headers)?;

    // 2. Decode JWT header to get the `kid` (key ID)
    let header = decode_header(token).map_err(|e| {
        // Tokens without dots aren't JWTs — normal fallthrough from non-JWT auth
        if token.matches('.').count() < 2 {
            debug!(error = %e, "cognito auth: non-JWT token, skipping");
        } else {
            warn!(error = %e, "cognito auth: failed to decode JWT header");
        }
        AuthError("invalid token".to_string())
    })?;

    let kid = header.kid.ok_or_else(|| {
        warn!("cognito auth: JWT header missing kid");
        AuthError("invalid token".to_string())
    })?;

    // 3. Get the decoding key from JWKS cache (fetches from Cognito if needed)
    let cache = jwks_cache()?;
    let key = {
        let mut cache_write = cache.write().await;
        // Clone the key to release the lock before decode
        cache_write.get_key(&kid).await?.clone()
    };

    // 4. Validate and decode the JWT (RS256)
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = true;
    // Cognito ID tokens don't always have an `aud` claim that matches
    // the client ID when using hosted UI. Disable audience validation
    // and rely on the issuer + signature instead.
    validation.validate_aud = false;

    let token_data = decode::<CognitoClaims>(token, &key, &validation).map_err(|e| {
        warn!(error = %e, "cognito auth: JWT validation failed");
        AuthError("invalid token".to_string())
    })?;

    let sub = &token_data.claims.sub;

    // 5. Look up user by Cognito user ID (externalAuthId in DB)
    let user = db::find_user_by_external_auth_id(pool, sub)
        .await
        .map_err(|e| {
            warn!(error = %e, "cognito auth: db error");
            AuthError("internal error".to_string())
        })?
        .ok_or_else(|| {
            warn!(sub = %sub, "cognito auth: user not found");
            AuthError("user not found".to_string())
        })?;

    Ok(user.id)
}
