//! The OAuth refresh-token spend, serialized per connection.
//!
//! `refresh_token` grants are single-use at the providers that rotate them: a
//! second exchange of the same token is either refused (GitLab invalidates it
//! the moment it is spent) or read as reuse and the whole grant is revoked.
//! Every gateway instance sees the same expiry at the same moment, and so does
//! a burst of requests on one instance. Without serialization the first
//! request after an expiry spends the token and every concurrent one spends
//! it again.
//!
//! `refresh_oauth_token` is the one place a refresh token is spent, in this
//! order:
//!
//! 1. queue on this instance's stripe for the connection (one database
//!    connection per connection being refreshed, however many requests wait),
//!    bounded by the same wait as the lock below;
//! 2. open a transaction on the refresh pool and take the connection's
//!    advisory lock, bounded so a stuck holder costs a waiter a fallback, not
//!    a hang;
//! 3. **re-read** the stored credentials. The caller's copy can be a cached
//!    row up to a minute old, and if another instance (or a reconnect) has
//!    moved the row on, there is nothing to spend. A row already flagged as
//!    refused (`reauth_required_at`) is not sent to the provider again;
//! 4. otherwise exchange the stored refresh token and persist the result with
//!    a compare-and-set against what was read, then commit (which releases
//!    the lock). A provider that refuses the token itself (`invalid_grant`)
//!    flags the row instead, under the same compare-and-set, so only the user
//!    reconnecting revives it.
//!
//! Step 4 runs as its own task: a request that is cancelled mid-refresh (the
//! client hangs up) must not drop a refresh whose new token the provider has
//! already issued but the database has not yet stored.

use std::sync::Arc;

use serde_json::Value;
use tracing::{debug, warn};

use crate::connect::{PolicyEngine, PolicyEngineExt as _};

/// The pieces of an OAuth refresh the caller has already resolved.
pub(crate) struct OAuthRefresh<'a> {
    pub connection_id: &'a str,
    pub provider: &'a str,
    pub workspace_id: &'a str,
    pub config: &'static apps::RefreshConfig,
}

/// What a refresh attempt produced, as far as the request is concerned.
#[derive(Debug, PartialEq)]
pub(crate) enum RefreshOutcome {
    /// A usable access token: freshly minted here, or already refreshed by
    /// another holder of the lock.
    Token {
        access_token: String,
        expires_at: Option<i64>,
    },
    /// The connection is gone or disconnected, so nothing from the caller's
    /// stale copy may be injected.
    Revoked,
    /// The provider refused this credential's refresh token (now, or on an
    /// earlier attempt that flagged the row). Only the user reconnecting can
    /// fix it, so the request is answered with `connection_needs_reconnect`.
    NeedsReconnect,
    /// The refresh could not run or did not succeed. The caller keeps the
    /// token it came in with, exactly as before serialization existed.
    Unavailable,
}

/// Seconds since the Unix epoch.
pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The stored access token, when it is present and not expired. A token with
/// no `expires_at` is usable: the request path never refreshes one, and a
/// reconnect may legitimately store such a token.
fn usable_token(creds: &Value, now: i64) -> Option<(String, Option<i64>)> {
    let token = creds.get("access_token")?.as_str()?;
    let expires_at = creds.get("expires_at").and_then(Value::as_i64);
    // Same boundary as the caller's expiry check (`exp < now` refreshes).
    let expired = expires_at.is_some_and(|exp| exp < now);
    (!expired).then(|| (token.to_string(), expires_at))
}

/// Spend the connection's refresh token at most once across every instance,
/// returning the token to inject.
pub(crate) async fn refresh_oauth_token(
    engine: &PolicyEngine,
    refresh: OAuthRefresh<'_>,
) -> RefreshOutcome {
    let gate = Arc::clone(&engine.refresh_gate);
    // Bounded like the cross-instance lock: a holder stuck behind a slow
    // provider costs the requests queued here a fallback, never a hang.
    let Ok(_local) =
        tokio::time::timeout(gate.lock_wait(), gate.local(refresh.connection_id)).await
    else {
        warn!(connection_id = %refresh.connection_id, "token refresh: queue wait expired; using the stored token");
        return RefreshOutcome::Unavailable;
    };

    let mut tx = match gate.pool().begin().await {
        Ok(tx) => tx,
        Err(e) => {
            warn!(connection_id = %refresh.connection_id, error = %e, "token refresh: no database connection; using the stored token");
            return RefreshOutcome::Unavailable;
        }
    };

    match db::lock_app_connection_refresh(&mut tx, refresh.connection_id, gate.lock_wait_ms()).await
    {
        Ok(true) => {}
        Ok(false) => {
            warn!(connection_id = %refresh.connection_id, "token refresh: lock wait expired; using the stored token");
            return RefreshOutcome::Unavailable;
        }
        Err(e) => {
            warn!(connection_id = %refresh.connection_id, error = %e, "token refresh: lock failed; using the stored token");
            return RefreshOutcome::Unavailable;
        }
    }

    let stored = match db::find_connected_app_credentials(&mut *tx, refresh.connection_id).await {
        Ok(Some(stored)) => stored,
        Ok(None) => {
            debug!(connection_id = %refresh.connection_id, "token refresh: connection gone or disconnected");
            return RefreshOutcome::Revoked;
        }
        Err(e) => {
            warn!(connection_id = %refresh.connection_id, error = %e, "token refresh: re-read failed; using the stored token");
            return RefreshOutcome::Unavailable;
        }
    };

    let current: Value = match engine
        .crypto
        .decrypt(&stored.credentials)
        .await
        .map_err(|e| e.to_string())
        .and_then(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => {
            warn!(connection_id = %refresh.connection_id, error = %e, "token refresh: stored credentials unreadable");
            return RefreshOutcome::Unavailable;
        }
    };

    // Someone else holding this lock before us already refreshed: use theirs.
    if let Some((access_token, expires_at)) = usable_token(&current, now_secs()) {
        debug!(connection_id = %refresh.connection_id, "token refresh: already refreshed elsewhere");
        return RefreshOutcome::Token {
            access_token,
            expires_at,
        };
    }

    // The provider already refused exactly this credential: asking again
    // cannot succeed. A reconnect stores a new credential and clears the flag.
    if stored.reauth_required {
        return RefreshOutcome::NeedsReconnect;
    }

    let Some(refresh_token) = current
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        // The row moved on to a credential with nothing to refresh with; the
        // caller falls back to what it had, as it always did.
        return RefreshOutcome::Unavailable;
    };

    // Only the request that actually spends looks up the OAuth client; the
    // ones that found a fresh token above never needed it.
    let byoc = engine
        .resolve_byoc_credentials(
            refresh.workspace_id,
            refresh.provider,
            refresh.connection_id,
        )
        .await;

    // Detached from the request: once the provider is asked, the answer must
    // reach the database even if the request that asked is gone. The task owns
    // the transaction, so the lock is held until the result is stored, and a
    // shutdown guard, so the drain waits for it rather than exiting between
    // the provider minting a pair and the database storing it.
    let crypto = Arc::clone(&engine.crypto);
    let connection_id = refresh.connection_id.to_string();
    let provider = refresh.provider.to_string();
    let config = refresh.config;
    let stored = stored.credentials;
    let drain_guard = shutdown::task_guard();
    let spend = tokio::spawn(async move {
        let _drain_guard = drain_guard;
        let (byoc_id, byoc_secret) = match &byoc {
            Some((id, secret)) => (Some(id.as_str()), Some(secret.as_str())),
            None => (None, None),
        };
        let token_url = current.get("token_endpoint").and_then(Value::as_str);
        let (access_token, expires_at, rotated) = match apps::refresh_access_token(
            config,
            &refresh_token,
            byoc_id,
            byoc_secret,
            token_url,
        )
        .await
        {
            Ok(minted) => minted,
            Err(e) if e.is::<apps::RefreshRevoked>() => {
                return flag_refused(tx, &connection_id, &provider, &stored).await;
            }
            Err(e) => {
                debug!(provider = %provider, error = ?e, "token refresh failed");
                return RefreshOutcome::Unavailable;
            }
        };

        let mut next = current;
        next["access_token"] = Value::String(access_token.clone());
        next["expires_at"] = serde_json::json!(expires_at);
        if let Some(rotated) = rotated {
            next["refresh_token"] = Value::String(rotated);
        }
        persist(&crypto, &mut *tx, &connection_id, &provider, &stored, &next).await;
        if let Err(e) = tx.commit().await {
            warn!(provider = %provider, error = %e, "token refresh: commit failed; the new token is not stored");
        }
        // The token is valid whether or not it was stored: the provider minted
        // it. Serving it costs nothing even when the row moved on.
        RefreshOutcome::Token {
            access_token,
            expires_at: Some(expires_at),
        }
    });

    spend.await.unwrap_or_else(|e| {
        warn!(error = %e, "token refresh task failed");
        RefreshOutcome::Unavailable
    })
}

/// Record, inside the refresh's own transaction, that the provider refused
/// the refresh token of `expected`. Conditional on that credential still being
/// stored: a reconnect that landed while the provider answered is never
/// flagged, and this request then simply falls back like any failed refresh.
/// If the flag cannot be written the refusal is still true for this request.
async fn flag_refused(
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    connection_id: &str,
    provider: &str,
    expected: &str,
) -> RefreshOutcome {
    match db::mark_app_connection_reauth_required(&mut *tx, connection_id, expected).await {
        Ok(true) => {
            if let Err(e) = tx.commit().await {
                warn!(connection_id, provider, error = %e, "token refresh: recording needs-reconnect failed to commit");
            }
            warn!(
                connection_id,
                provider, "refresh token refused (invalid_grant); connection needs reconnect"
            );
            RefreshOutcome::NeedsReconnect
        }
        Ok(false) => {
            debug!(
                connection_id,
                provider,
                "refresh token refused, but the credential changed meanwhile; not flagging"
            );
            RefreshOutcome::Unavailable
        }
        Err(e) => {
            warn!(connection_id, provider, error = %e, "token refresh: recording needs-reconnect failed");
            RefreshOutcome::NeedsReconnect
        }
    }
}

/// Encrypt and store refreshed credentials, only over the ciphertext they were
/// computed from. Failures are logged and never fail the request: the token is
/// already in hand.
pub(crate) async fn persist<'c, E>(
    crypto: &crypto::CryptoService,
    executor: E,
    connection_id: &str,
    provider: &str,
    expected: &str,
    creds: &Value,
) where
    E: sqlx::PgExecutor<'c>,
{
    let Ok(json) = serde_json::to_string(creds) else {
        debug!(provider = %provider, "failed to serialize refreshed credentials");
        return;
    };
    let encrypted = match crypto.encrypt(&json).await {
        Ok(encrypted) => encrypted,
        Err(e) => {
            debug!(provider = %provider, error = ?e, "failed to encrypt refreshed credentials");
            return;
        }
    };
    match db::replace_app_connection_credentials(executor, connection_id, expected, &encrypted)
        .await
    {
        Ok(true) => debug!(provider = %provider, "persisted refreshed credentials"),
        Ok(false) => debug!(
            provider = %provider,
            connection_id = %connection_id,
            "connection changed during refresh; keeping the newer stored credentials"
        ),
        Err(e) => {
            warn!(provider = %provider, error = ?e, "failed to persist refreshed credentials")
        }
    }
}

#[cfg(test)]
mod pg_tests;

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{now_secs, refresh_oauth_token, usable_token, OAuthRefresh, RefreshOutcome};
    use crate::connect::PolicyEngine;
    use serde_json::json;

    /// A refresh already running on this instance (holding the connection's
    /// stripe) must cost a waiter its bounded wait, not an open-ended one.
    #[tokio::test]
    async fn the_in_process_queue_wait_is_bounded() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:9/unused")
            .expect("lazy pool");
        let engine = PolicyEngine::test_with_pool(pool, Duration::from_millis(200));
        let held = engine.refresh_gate.local("conn-held").await;

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            refresh_oauth_token(
                &engine,
                OAuthRefresh {
                    connection_id: "conn-held",
                    provider: "gitlab",
                    workspace_id: "ws",
                    config: apps::refresh_config("gitlab").expect("gitlab refreshes"),
                },
            ),
        )
        .await
        .expect("the queue wait must be bounded");
        assert_eq!(outcome, RefreshOutcome::Unavailable);
        drop(held);
    }

    #[test]
    fn a_token_is_usable_only_before_it_expires() {
        let now = now_secs();
        assert_eq!(
            usable_token(&json!({ "access_token": "t", "expires_at": now + 60 }), now),
            Some(("t".to_string(), Some(now + 60)))
        );
        assert_eq!(
            usable_token(&json!({ "access_token": "t", "expires_at": now - 1 }), now),
            None
        );
        assert_eq!(usable_token(&json!({ "expires_at": now + 60 }), now), None);
    }

    #[test]
    fn a_token_without_an_expiry_never_needs_a_refresh() {
        assert_eq!(
            usable_token(&json!({ "access_token": "t" }), now_secs()),
            Some(("t".to_string(), None))
        );
    }
}
