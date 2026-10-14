//! Recovery from an access token the provider ended before its expiry.
//!
//! The gateway refreshes an OAuth access token when its stored `expires_at`
//! passes. Some providers end tokens earlier than that: Salesforce ends one
//! with the org's session timeout, an admin revoking sessions, or a password
//! reset, and answers every request on it with a 401 (`INVALID_SESSION_ID`,
//! or `INVALID_AUTH_HEADER` / `INVALID_JWT_FORMAT` for a JWT-based token).
//! Until the stored expiry passed, every request was forwarded with the dead
//! token.
//!
//! A provider opts in through its `RefreshConfig::stale_token_error_codes`.
//! When a request the gateway injected a connection's token into is answered
//! with a 401 carrying one of those codes:
//!
//! 1. the refused token goes into the single-flight refresh
//!    ([`crate::refresh`]) as `rejected`, so it is replaced exactly once
//!    across instances however many requests were refused with it, and a
//!    refresh-token refusal still flags the connection for reconnect;
//! 2. the cached injection rules and connect responses that still hold the
//!    refused token are dropped, so the next request resolves the new one;
//! 3. a request without a body is sent once more with the new token. The
//!    provider refused the first attempt at authentication, so it performed
//!    nothing. A request with a body is never resent: its body was streamed
//!    into the first attempt. The agent gets the 401, and its own retry
//!    carries the new token.
//!
//! Some refusals carry the same codes but no refresh can fix them: a session
//! policy the token does not meet, or a provider bug that ends a JWT-based
//! token minted by the refresh flow at once (Salesforce known issue
//! W-18029118). Unguarded, every request would spend the refresh token and be
//! sent twice. So a refusal of the token a recovery just obtained is not
//! recovered again for ten minutes: the 401 goes back as is.

use tracing::{info, warn};

use cache::CacheStore;

use crate::connect::{connect_cache_prefix, connection_injection_cache_prefix, PolicyEngine};
use crate::mitm::ResolvedRules;
use crate::refresh::{refresh_oauth_token, OAuthRefresh, RefreshOutcome};

/// How much of a 401 body is read to classify it. Salesforce's error body is
/// well under 200 bytes; anything larger is not the shape this matches.
pub const BODY_LIMIT: usize = 4 * 1024;

/// How long a token obtained by a recovery is remembered. A refusal of it
/// within this window means a refresh did not help, so none is tried again.
/// Matches Salesforce's trusted token lifetime: past it, the expiry-driven
/// refresh has replaced the token anyway.
const RECOVERED_TOKEN_TTL_SECS: u64 = 10 * 60;

/// The connection whose token a request carries, for a provider that
/// recovers from refusals.
#[derive(Clone, Copy)]
pub struct Recoverable<'a> {
    pub connection_id: &'a str,
    pub provider: &'a str,
    pub config: &'static apps::RefreshConfig,
}

/// The connection whose token was injected into this request, when its
/// provider recovers from refusals. `None` for every other request, so nothing
/// is read or classified on the hot path.
#[must_use]
pub fn applies(rules: &ResolvedRules, injection_count: usize) -> Option<Recoverable<'_>> {
    if injection_count == 0 {
        return None;
    }
    let connection_id = rules.winning_connection_id.as_deref()?;
    let provider = rules.winning_provider.as_deref()?;
    let config = refresh_config(provider)?;
    (!config.stale_token_error_codes.is_empty()).then_some(Recoverable {
        connection_id,
        provider,
        config,
    })
}

/// The provider's refresh config. Tests point Salesforce's at a local token
/// endpoint (the real one is a fixed `'static` URL).
fn refresh_config(provider: &str) -> Option<&'static apps::RefreshConfig> {
    #[cfg(test)]
    if provider == "salesforce" {
        if let Some(config) = TEST_SALESFORCE_REFRESH.get() {
            return Some(config);
        }
    }
    apps::refresh_config(provider)
}

#[cfg(test)]
static TEST_SALESFORCE_REFRESH: std::sync::OnceLock<&'static apps::RefreshConfig> =
    std::sync::OnceLock::new();

/// Point Salesforce's refresh at a test token endpoint, once per test binary.
#[cfg(test)]
pub(crate) fn set_test_refresh_config(config: &'static apps::RefreshConfig) {
    let _ = TEST_SALESFORCE_REFRESH.set(config);
}

/// The bearer token the GATEWAY put on this request: the `authorization`
/// header after injection, when injection set it (it differs from what the
/// agent sent). A value the agent supplied itself is never treated as the
/// connection's token, so a refusal of it can neither spend the refresh token
/// nor get the connection's token attached to a path the provider's rules do
/// not inject on.
#[must_use]
pub fn injected_bearer<'a>(
    sent: &'a hyper::HeaderMap,
    received: &hyper::HeaderMap,
) -> Option<&'a str> {
    let value = sent.get(hyper::header::AUTHORIZATION)?;
    if received.get(hyper::header::AUTHORIZATION) == Some(value) {
        return None;
    }
    value.to_str().ok()?.strip_prefix("Bearer ")
}

/// Whether a 401's body is one of the provider's stale-token refusals. `head`
/// is the body as read off the wire (gzipped when the agent accepted gzip), so
/// it is decoded first. Only a body read whole is classified.
#[must_use]
pub fn is_stale(
    config: &apps::RefreshConfig,
    headers: &hyper::HeaderMap,
    head: &crate::body::Head,
) -> bool {
    head.complete
        && crate::body::decoded(headers, &head.bytes, BODY_LIMIT)
            .is_some_and(|body| config.is_stale_token_error(&body))
}

/// Handle a 401 that is one of the provider's stale-token refusals of
/// `rejected`: replace it (once, across instances), drop the cached rules
/// that still hold it, and return the new token when there is one.
pub async fn recover(
    engine: &PolicyEngine,
    cache: &dyn CacheStore,
    target: Recoverable<'_>,
    rejected: &str,
    organization_id: &str,
    workspace_id: &str,
) -> Option<String> {
    let Recoverable {
        connection_id,
        provider,
        config,
    } = target;
    if cache
        .get_raw(&recovered_key(connection_id, rejected))
        .await
        .is_some()
    {
        warn!(
            connection_id,
            provider,
            "provider refused the token a refresh just obtained; a refresh does not fix this refusal"
        );
        return None;
    }

    let outcome = refresh_oauth_token(
        engine,
        OAuthRefresh {
            connection_id,
            provider,
            workspace_id,
            config,
            rejected: Some(rejected),
        },
    )
    .await;

    // Whatever the outcome, the cached rules hold the refused token: drop
    // them so the next request re-resolves from the database. Two layers hold
    // it: the connection's built injection rules, and the workspace's connect
    // responses, whose connection rows carry the credential ciphertext the
    // rules are rebuilt from.
    cache
        .del_by_prefix(&connection_injection_cache_prefix(
            organization_id,
            workspace_id,
            connection_id,
        ))
        .await;
    cache
        .del_by_prefix(&connect_cache_prefix(organization_id, workspace_id))
        .await;

    match outcome {
        RefreshOutcome::Token { access_token, .. } if access_token != rejected => {
            info!(
                connection_id,
                provider, "provider refused the access token; refreshed it"
            );
            cache
                .set_raw(
                    &recovered_key(connection_id, &access_token),
                    "1",
                    RECOVERED_TOKEN_TTL_SECS,
                )
                .await;
            Some(access_token)
        }
        RefreshOutcome::NeedsReconnect => {
            warn!(
                connection_id,
                provider, "provider refused the access token and its refresh token"
            );
            None
        }
        _ => {
            warn!(
                connection_id,
                provider, "provider refused the access token; no new token was obtained"
            );
            None
        }
    }
}

/// The cache key marking `token` as obtained by a recovery of
/// `connection_id`. Keyed by a SHA-256 of the token, never the token itself:
/// cache keys are listed and logged where values are not.
fn recovered_key(connection_id: &str, token: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, token.as_bytes());
    format!(
        "stale_token_recovered:{connection_id}:{}",
        hex::encode(digest.as_ref())
    )
}

#[cfg(test)]
mod pg_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::Head;

    fn salesforce() -> &'static apps::RefreshConfig {
        apps::refresh_config("salesforce").expect("salesforce refreshes")
    }

    fn whole(bytes: &[u8]) -> Head {
        Head {
            bytes: bytes.to_vec(),
            complete: true,
        }
    }

    const JWT_REFUSAL: &[u8] =
        br#"[{"message":"INVALID_JWT_FORMAT","errorCode":"INVALID_AUTH_HEADER"}]"#;

    /// Python `requests`, Node `fetch` and curl `--compressed` all accept
    /// gzip, so a refusal can arrive gzipped: it still counts.
    #[test]
    fn a_gzipped_refusal_is_stale() {
        use std::io::Write as _;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(JWT_REFUSAL).expect("gzip");
        let mut headers = hyper::HeaderMap::new();
        headers.insert("content-encoding", "gzip".parse().expect("header"));
        assert!(is_stale(
            salesforce(),
            &headers,
            &whole(&gz.finish().expect("gzip"))
        ));
    }

    /// Only a body read whole is classified: a cut one is not the short
    /// error body this looks for.
    #[test]
    fn a_cut_body_is_never_stale() {
        let cut = Head {
            bytes: JWT_REFUSAL.to_vec(),
            complete: false,
        };
        assert!(!is_stale(salesforce(), &hyper::HeaderMap::new(), &cut));
        assert!(is_stale(
            salesforce(),
            &hyper::HeaderMap::new(),
            &whole(JWT_REFUSAL)
        ));
    }

    #[test]
    fn only_a_bearer_the_gateway_injected_is_read() {
        let mut received = hyper::HeaderMap::new();
        let mut sent = hyper::HeaderMap::new();
        sent.insert("authorization", "Bearer abc".parse().expect("header"));
        assert_eq!(injected_bearer(&sent, &received), Some("abc"));
        // The agent's own header, passed through untouched: not the
        // connection's token.
        received.insert("authorization", "Bearer abc".parse().expect("header"));
        assert_eq!(injected_bearer(&sent, &received), None);
        // Replaced by injection: the injected value counts.
        received.insert(
            "authorization",
            "Bearer placeholder".parse().expect("header"),
        );
        assert_eq!(injected_bearer(&sent, &received), Some("abc"));
        sent.insert("authorization", "Basic abc".parse().expect("header"));
        assert_eq!(injected_bearer(&sent, &received), None);
    }

    /// The marker never carries the token, and two connections never share
    /// one.
    #[test]
    fn the_recovered_marker_hides_the_token() {
        let key = recovered_key("c1", "secret-token");
        assert!(!key.contains("secret-token"));
        assert_ne!(key, recovered_key("c2", "secret-token"));
        assert_ne!(key, recovered_key("c1", "other-token"));
    }
}
