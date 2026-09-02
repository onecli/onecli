//! Redis-backed gateway cache — `ConnectionManager` reconnection, JSON
//! values, SCAN-based prefix invalidation, and the atomic counter script.

use anyhow::Context as _;
use async_trait::async_trait;
use tracing::warn;

use cache::CacheStore;

/// Redis-backed cache using `ConnectionManager` for automatic reconnection.
struct RedisCacheStore {
    conn: redis::aio::ConnectionManager,
}

impl RedisCacheStore {
    async fn new(redis_url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = redis::aio::ConnectionManager::new(client).await?;
        Ok(Self { conn })
    }
}

#[async_trait]
impl CacheStore for RedisCacheStore {
    async fn get_raw(&self, key: &str) -> Option<String> {
        let mut conn = self.conn.clone();
        match redis::cmd("GET").arg(key).query_async(&mut conn).await {
            Ok(val) => val,
            Err(e) => {
                warn!(key, error = %e, "redis GET failed, treating as cache miss");
                None
            }
        }
    }

    async fn set_raw(&self, key: &str, value: &str, ttl_secs: u64) {
        let mut conn = self.conn.clone();
        if let Err(e) = redis::cmd("SETEX")
            .arg(key)
            .arg(ttl_secs)
            .arg(value)
            .query_async::<()>(&mut conn)
            .await
        {
            warn!(key, error = %e, "redis SETEX failed, value not cached");
        }
    }

    async fn del(&self, key: &str) {
        let mut conn = self.conn.clone();
        if let Err(e) = redis::cmd("DEL")
            .arg(key)
            .query_async::<()>(&mut conn)
            .await
        {
            warn!(key, error = %e, "redis DEL failed");
        }
    }

    async fn del_by_prefix(&self, prefix: &str) {
        let mut conn = self.conn.clone();
        let pattern = format!("{prefix}*");
        let mut cursor: u64 = 0;
        loop {
            let result: Result<(u64, Vec<String>), _> = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(100)
                .query_async(&mut conn)
                .await;
            match result {
                Ok((next_cursor, keys)) => {
                    if !keys.is_empty() {
                        let _ = redis::cmd("DEL")
                            .arg(&keys)
                            .query_async::<()>(&mut conn)
                            .await;
                    }
                    cursor = next_cursor;
                    if cursor == 0 {
                        break;
                    }
                }
                Err(e) => {
                    warn!(prefix, error = %e, "redis SCAN failed during prefix deletion");
                    break;
                }
            }
        }
    }

    async fn incr(&self, key: &str, ttl_secs: u64) -> Option<u64> {
        self.incrby(key, 1, ttl_secs).await
    }

    async fn incrby(&self, key: &str, amount: u64, ttl_secs: u64) -> Option<u64> {
        let mut conn = self.conn.clone();
        let script = redis::Script::new(
            r"local exists = redis.call('EXISTS', KEYS[1])
              local count = redis.call('INCRBY', KEYS[1], ARGV[2])
              if exists == 0 then
                redis.call('EXPIRE', KEYS[1], ARGV[1])
              end
              return count",
        );
        match script
            .key(key)
            .arg(ttl_secs)
            .arg(amount)
            .invoke_async(&mut conn)
            .await
        {
            Ok(count) => Some(count),
            Err(e) => {
                warn!(key, error = %e, "redis INCRBY failed");
                None
            }
        }
    }
}

/// Build the Redis-backed cache store from the `REDIS_*` env vars.
pub async fn redis_cache_store() -> anyhow::Result<std::sync::Arc<dyn CacheStore>> {
    let store = RedisCacheStore::new(&super::redis_url_from_env())
        .await
        .context("connecting the Redis cache store")?;
    Ok(std::sync::Arc::new(store))
}
