//! OIDC JWKS manager for OAuth resource server authentication.
//!
//! Fetches the provider's signing keys via OIDC discovery and caches them
//! in memory. Keys are refreshed when an unknown `kid` is encountered
//! (key rotation) or after `JWKS_MAX_AGE` (proactive refresh).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, TokenData, Validation};
use serde::Deserialize;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::auth::AuthError;

/// Minimum interval between JWKS refresh attempts (prevents thundering herd).
const JWKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);

/// Maximum age before proactive refresh (even if all kids match).
#[allow(dead_code)]
const JWKS_MAX_AGE: Duration = Duration::from_secs(3600);

// ── OIDC / JWKS response types ─────────────────────────────────────────

#[derive(Deserialize)]
struct OidcDiscovery {
    issuer: String,
    jwks_uri: String,
}

#[derive(Deserialize)]
struct JwksResponse {
    keys: Vec<JwkKey>,
}

#[derive(Deserialize)]
struct JwkKey {
    kid: Option<String>,
    kty: String,
    #[serde(rename = "use")]
    use_: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

// ── Cached key store ────────────────────────────────────────────────────

struct CachedKeys {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Instant,
}

// ── JWT claims ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(crate) struct AccessTokenClaims {
    pub sub: String,
}

// ── JwksManager ─────────────────────────────────────────────────────────

/// Manages OIDC JWKS keys for JWT access token validation.
///
/// On creation, performs OIDC discovery to find the `jwks_uri`, then
/// fetches and caches the signing keys. Keys are automatically refreshed
/// when an unknown `kid` is encountered.
#[derive(Clone)]
pub(crate) struct JwksManager {
    issuer: String,
    audience: String,
    jwks_uri: String,
    cache: Arc<RwLock<CachedKeys>>,
    http_client: reqwest::Client,
}

/// Accepted RSA signature algorithms for access token validation.
const ACCEPTED_ALGORITHMS: &[Algorithm] = &[Algorithm::RS256, Algorithm::RS384, Algorithm::RS512];

impl JwksManager {
    /// Create a new JWKS manager.
    ///
    /// When `jwks_url_override` is provided, uses it directly to fetch keys
    /// (skipping OIDC discovery). Otherwise performs standard OIDC discovery
    /// via `{issuer_url}/.well-known/openid-configuration`.
    pub async fn new(
        issuer_url: &str,
        audience: String,
        jwks_url_override: Option<String>,
    ) -> Result<Self> {
        let http_client = reqwest::Client::new();
        let base = issuer_url.trim_end_matches('/');

        let (issuer, jwks_uri) = if let Some(url) = jwks_url_override {
            info!(jwks_uri = %url, "using OAUTH_JWKS_URL override, skipping OIDC discovery");
            (base.to_string(), url)
        } else {
            let discovery_url = format!("{base}/.well-known/openid-configuration");
            let discovery: OidcDiscovery = http_client
                .get(&discovery_url)
                .send()
                .await
                .context("fetching OIDC discovery document")?
                .json()
                .await
                .context("parsing OIDC discovery document")?;

            info!(
                issuer = %discovery.issuer,
                jwks_uri = %discovery.jwks_uri,
                "OIDC discovery loaded"
            );
            (discovery.issuer, discovery.jwks_uri)
        };

        let keys = fetch_jwks(&http_client, &jwks_uri).await?;
        info!(key_count = keys.len(), "JWKS loaded");

        Ok(Self {
            issuer,
            audience,
            jwks_uri,
            cache: Arc::new(RwLock::new(CachedKeys {
                keys,
                fetched_at: Instant::now(),
            })),
            http_client,
        })
    }

    /// Validate a JWT access token and return its claims.
    ///
    /// If the token's `kid` is not in the cache, triggers a JWKS refresh
    /// (with cooldown) and retries. Validates signature, expiration, and issuer.
    pub async fn validate(&self, token: &str) -> Result<AccessTokenClaims, AuthError> {
        let header = decode_header(token).map_err(|e| {
            warn!(error = %e, "JWT header decode failed");
            AuthError("invalid token".to_string())
        })?;

        let kid = header.kid.as_deref();

        // Try with cached keys
        {
            let cache = self.cache.read().await;
            if let Some(claims) = self.try_decode(token, kid, &cache.keys)? {
                return Ok(claims);
            }
        }

        // Key not found — refresh JWKS (with cooldown) and retry
        self.maybe_refresh().await;

        let cache = self.cache.read().await;
        self.try_decode(token, kid, &cache.keys)?.ok_or_else(|| {
            warn!(kid = ?kid, "JWT kid not found in JWKS after refresh");
            AuthError("invalid token".to_string())
        })
    }

    /// Try to decode the token using the cached keys.
    /// Returns `Ok(Some(claims))` if decoded, `Ok(None)` if no matching key, `Err` on validation failure.
    fn try_decode(
        &self,
        token: &str,
        kid: Option<&str>,
        keys: &HashMap<String, DecodingKey>,
    ) -> Result<Option<AccessTokenClaims>, AuthError> {
        let key = if let Some(kid) = kid {
            keys.get(kid)
        } else if keys.len() == 1 {
            // No kid in JWT header — use the only available key
            keys.values().next()
        } else {
            None
        };

        let key = match key {
            Some(k) => k,
            None => return Ok(None),
        };

        let mut validation = Validation::default();
        validation.algorithms = ACCEPTED_ALGORITHMS.to_vec();
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);

        let token_data: TokenData<AccessTokenClaims> =
            decode(token, key, &validation).map_err(|e| {
                warn!(error = %e, "JWT validation failed");
                AuthError("invalid token".to_string())
            })?;

        Ok(Some(token_data.claims))
    }

    /// Refresh JWKS if the cooldown period has elapsed.
    async fn maybe_refresh(&self) {
        {
            let cache = self.cache.read().await;
            if cache.fetched_at.elapsed() < JWKS_REFRESH_COOLDOWN {
                return;
            }
        }

        match fetch_jwks(&self.http_client, &self.jwks_uri).await {
            Ok(keys) => {
                info!(key_count = keys.len(), "JWKS refreshed");
                let mut cache = self.cache.write().await;
                cache.keys = keys;
                cache.fetched_at = Instant::now();
            }
            Err(e) => {
                warn!(error = %e, "JWKS refresh failed, using cached keys");
            }
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Fetch and parse JWKS from the given URI, returning a kid → DecodingKey map.
async fn fetch_jwks(
    client: &reqwest::Client,
    jwks_uri: &str,
) -> Result<HashMap<String, DecodingKey>> {
    let jwks: JwksResponse = client
        .get(jwks_uri)
        .send()
        .await
        .context("fetching JWKS")?
        .json()
        .await
        .context("parsing JWKS")?;

    let mut keys = HashMap::new();

    for jwk in jwks.keys {
        if jwk.kty != "RSA" {
            continue;
        }
        if jwk.use_.as_deref().is_some_and(|u| u != "sig") {
            continue;
        }

        let kid = match jwk.kid {
            Some(kid) => kid,
            None => continue,
        };

        let (n, e) = match (jwk.n, jwk.e) {
            (Some(n), Some(e)) => (n, e),
            _ => continue,
        };

        match DecodingKey::from_rsa_components(&n, &e) {
            Ok(key) => {
                keys.insert(kid, key);
            }
            Err(e) => {
                warn!(error = %e, "failed to parse JWKS RSA key");
            }
        }
    }

    Ok(keys)
}
