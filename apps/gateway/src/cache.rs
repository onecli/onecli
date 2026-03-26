//! Generic key-value cache with TTL.
//!
//! OSS uses an in-memory `DashMap` backend. Cloud swaps this module
//! via `#[cfg(feature = "cloud")]` to use Redis.
//!
//! All values are serialized to JSON — the `CacheStore` trait is
//! type-agnostic. Consumers use namespaced keys to avoid collisions
//! (e.g., `connect:{token}:{host}`, `cred:{user}:{host}`).

use std::time::{Duration, Instant};

use async_trait::async_trait;
use dashmap::DashMap;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tracing::warn;

/// Generic key-value cache with TTL.
///
/// Implementations must be `Send + Sync` for use in async contexts.
/// Values are serialized to JSON internally — callers work with
/// concrete types via serde.
///
/// Uses `async_trait` for dyn-compatibility (`Arc<dyn CacheStore>`).
#[async_trait]
pub(crate) trait CacheStore: Send + Sync {
    /// Get a value by key. Returns `None` on miss or expiry.
    async fn get_raw(&self, key: &str) -> Option<String>;

    /// Set a raw string value with a TTL in seconds.
    async fn set_raw(&self, key: &str, value: &str, ttl_secs: u64);

    /// Delete a key.
    #[allow(dead_code)]
    async fn del(&self, key: &str);

    /// Delete all keys matching a prefix.
    async fn del_by_prefix(&self, prefix: &str);

    /// Atomically increment a counter at `key`.
    /// Sets TTL only on first increment (new key / expired key).
    /// Returns the new count, or `None` on error (graceful fallback).
    async fn incr(&self, key: &str, ttl_secs: u64) -> Option<u64>;
}

/// Extension methods for typed get/set on any `CacheStore`.
impl dyn CacheStore + '_ {
    /// Get a typed value by key.
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let raw = self.get_raw(key).await?;
        match serde_json::from_str(&raw) {
            Ok(val) => Some(val),
            Err(e) => {
                warn!(key, error = %e, "cache deserialization failed, treating as miss");
                None
            }
        }
    }

    /// Set a typed value with TTL.
    pub async fn set<T: Serialize>(&self, key: &str, value: &T, ttl_secs: u64) {
        match serde_json::to_string(value) {
            Ok(raw) => self.set_raw(key, &raw, ttl_secs).await,
            Err(e) => warn!(key, error = %e, "cache serialization failed, value not cached"),
        }
    }
}

/// Create the cache store for this build.
/// OSS: in-memory DashMap. Cloud: Redis (swapped via `#[cfg]`).
pub(crate) async fn create_store() -> anyhow::Result<std::sync::Arc<dyn CacheStore>> {
    Ok(std::sync::Arc::new(InMemoryCacheStore::new()))
}

// ── In-memory implementation ─────────────────────────────────────────────

struct CachedEntry {
    data: String,
    expires_at: Instant,
}

/// In-memory cache backed by `DashMap`. Used in OSS (single-instance).
///
/// Expired entries are evicted lazily on read — no background reaper.
/// Acceptable for the gateway's bounded key space (one entry per
/// agent×host pair), but not suitable for unbounded key sets.
struct InMemoryCacheStore {
    map: DashMap<String, CachedEntry>,
}

impl InMemoryCacheStore {
    pub fn new() -> Self {
        Self {
            map: DashMap::new(),
        }
    }
}

#[async_trait]
impl CacheStore for InMemoryCacheStore {
    async fn get_raw(&self, key: &str) -> Option<String> {
        let entry = self.map.get(key)?;
        if entry.expires_at > Instant::now() {
            Some(entry.data.clone())
        } else {
            drop(entry);
            self.map.remove(key);
            None
        }
    }

    async fn set_raw(&self, key: &str, value: &str, ttl_secs: u64) {
        let now = Instant::now();
        let expires_at = now
            .checked_add(Duration::from_secs(ttl_secs))
            .unwrap_or(now + Duration::from_secs(86_400 * 365));

        self.map.insert(
            key.to_string(),
            CachedEntry {
                data: value.to_string(),
                expires_at,
            },
        );
    }

    async fn del(&self, key: &str) {
        self.map.remove(key);
    }

    async fn del_by_prefix(&self, prefix: &str) {
        self.map.retain(|key, _| !key.starts_with(prefix));
    }

    async fn incr(&self, key: &str, ttl_secs: u64) -> Option<u64> {
        let now = Instant::now();
        let ttl = Duration::from_secs(ttl_secs);

        let mut entry = self.map.entry(key.to_string()).or_insert(CachedEntry {
            data: "0".to_string(),
            expires_at: now + ttl,
        });

        // Reset if expired
        if entry.expires_at <= now {
            entry.data = "0".to_string();
            entry.expires_at = now + ttl;
        }

        let count: u64 = entry.data.parse().unwrap_or(0) + 1;
        entry.data = count.to_string();
        Some(count)
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Helper: create a store as `Arc<dyn CacheStore>` to test the dyn path.
    fn new_store() -> Arc<dyn CacheStore> {
        Arc::new(InMemoryCacheStore::new())
    }

    #[tokio::test]
    async fn get_returns_none_on_miss() {
        let store = new_store();
        let result: Option<String> = store.get("missing").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn set_and_get_round_trip() {
        let store = new_store();
        store.set("key1", &"hello", 60).await;
        let result: Option<String> = store.get("key1").await;
        assert_eq!(result.as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn get_returns_none_after_expiry() {
        let store = new_store();
        store.set("key1", &42u64, 0).await;
        // TTL=0 means already expired
        let result: Option<u64> = store.get("key1").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn del_removes_entry() {
        let store = new_store();
        store.set("key1", &"value", 60).await;
        store.del("key1").await;
        let result: Option<String> = store.get("key1").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn del_by_prefix_removes_matching_entries() {
        let store = new_store();
        store.set("connect:acc1:tok1:host1", &"v1", 60).await;
        store.set("connect:acc1:tok2:host2", &"v2", 60).await;
        store.set("connect:acc2:tok3:host3", &"v3", 60).await;
        store.set("rate:rule1:tok1:123", &"1", 60).await;

        store.del_by_prefix("connect:acc1:").await;

        assert!(store
            .get::<String>("connect:acc1:tok1:host1")
            .await
            .is_none());
        assert!(store
            .get::<String>("connect:acc1:tok2:host2")
            .await
            .is_none());
        assert_eq!(
            store
                .get::<String>("connect:acc2:tok3:host3")
                .await
                .as_deref(),
            Some("v3")
        );
        assert_eq!(
            store.get::<String>("rate:rule1:tok1:123").await.as_deref(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn typed_round_trip() {
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
        struct MyData {
            name: String,
            count: u32,
        }

        let store = new_store();
        let data = MyData {
            name: "test".to_string(),
            count: 42,
        };
        store.set("typed", &data, 60).await;
        let result: Option<MyData> = store.get("typed").await;
        assert_eq!(result, Some(data));
    }
}
