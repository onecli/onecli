//! Admission for OAuth token refreshes.
//!
//! A refresh spends a provider's refresh token, and providers that rotate it
//! (GitLab, Atlassian, Notion, …) accept each one exactly once. When two
//! refreshes of the same connection race (two requests on one instance, or one
//! request on each of two instances), they spend it twice and the provider
//! revokes the grant.
//!
//! The cross-instance guarantee is a Postgres advisory lock taken inside a
//! transaction (`db::lock_app_connection_refresh`), so every gateway sharing the
//! database queues on the same key. This module owns the two things around it
//! that keep that lock from hurting the request path:
//!
//! - **A dedicated, lazily-opened pool.** A refresh holds a connection while it
//!   waits for the lock and for the provider. On the shared pool a burst of
//!   expiries would park every connection behind one slow provider and stall
//!   unrelated resolution; here it can only exhaust its own few.
//! - **In-process stripes.** Callers on one instance queue on an async mutex
//!   first, so N concurrent requests for the same connection hold one database
//!   connection between them, not N.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use sqlx::postgres::{PgPool, PgPoolOptions};
use tokio::sync::{Mutex, MutexGuard};

/// Connections the refresh pool may open. Each is held for one refresh (the
/// lock wait plus one provider round trip), so a handful covers distinct
/// connections expiring together without crowding the database.
const REFRESH_POOL_MAX_CONNECTIONS: u32 = 4;

/// Ceiling on waiting for the cross-instance lock. It must cover a holder's
/// whole refresh (the provider call is capped at 15s by
/// `apps::refresh_access_token`) or a waiter would give up on a refresh that
/// was about to succeed and fall back to the expired token it came in with.
/// The same ceiling bounds the wait for a refresh-pool connection: falling
/// back early means injecting a token already known to be expired, so a
/// short wait buys nothing.
pub const REFRESH_LOCK_WAIT: Duration = Duration::from_secs(20);

/// In-process stripes. A fixed array rather than a map keyed by connection id:
/// it can never grow, and two connections sharing a stripe only means they
/// refresh one after the other on this instance.
const STRIPES: usize = 64;

/// The refresh admission state shared by every request on one gateway.
pub struct RefreshGate {
    pool: PgPool,
    stripes: Box<[Mutex<()>]>,
    lock_wait: Duration,
}

impl RefreshGate {
    /// A gate whose pool connects to the same database as `shared`, opening
    /// connections only when a refresh actually needs one.
    pub fn new(shared: &PgPool) -> Self {
        let pool = PgPoolOptions::new()
            .max_connections(REFRESH_POOL_MAX_CONNECTIONS)
            .min_connections(0)
            .acquire_timeout(REFRESH_LOCK_WAIT)
            .connect_lazy_with((*shared.connect_options()).clone());
        Self::with_pool(pool, REFRESH_LOCK_WAIT)
    }

    /// A gate over an explicit pool and lock wait, for tests that need two
    /// independent "instances" or a short wait to observe the timeout.
    #[doc(hidden)]
    pub fn with_pool(pool: PgPool, lock_wait: Duration) -> Self {
        Self {
            pool,
            stripes: (0..STRIPES).map(|_| Mutex::new(())).collect(),
            lock_wait,
        }
    }

    /// The pool refresh transactions run on.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// The bounded wait for the cross-instance lock.
    pub fn lock_wait(&self) -> Duration {
        self.lock_wait
    }

    /// The bounded wait for the cross-instance lock, in milliseconds.
    pub fn lock_wait_ms(&self) -> u64 {
        u64::try_from(self.lock_wait.as_millis()).unwrap_or(u64::MAX)
    }

    /// Queue behind any refresh of the same connection already running on this
    /// instance.
    pub async fn local(&self, connection_id: &str) -> MutexGuard<'_, ()> {
        let mut hasher = DefaultHasher::new();
        connection_id.hash(&mut hasher);
        // The modulo keeps the value below STRIPES, so the narrowing is exact.
        let idx = (hasher.finish() % STRIPES as u64) as usize;
        self.stripes[idx].lock().await
    }

    /// Close the refresh pool. Part of the shutdown sequence, after the
    /// connection drain, beside the shared pool's close.
    pub async fn close(&self) {
        self.pool.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> RefreshGate {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:9/unused")
            .expect("lazy pool");
        RefreshGate::with_pool(pool, Duration::from_millis(1500))
    }

    #[tokio::test]
    async fn the_same_connection_queues_on_one_stripe() {
        let gate = gate();
        let held = gate.local("conn-a").await;
        let second = tokio::time::timeout(Duration::from_millis(50), gate.local("conn-a")).await;
        assert!(
            second.is_err(),
            "a second refresh of the same connection must wait"
        );
        drop(held);
        let after = tokio::time::timeout(Duration::from_millis(50), gate.local("conn-a")).await;
        assert!(after.is_ok(), "the stripe is free once the holder drops it");
    }

    // Async because building even a lazy pool spawns its maintenance task,
    // which needs a runtime.
    #[tokio::test]
    async fn the_lock_wait_is_reported_in_milliseconds() {
        assert_eq!(gate().lock_wait_ms(), 1500);
    }
}
