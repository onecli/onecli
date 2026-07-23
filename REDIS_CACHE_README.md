# Redis Cache Backend for OneCLI Gateway

An independent implementation of the OneCLI gateway's `CacheStore` trait backed by Redis instead of in-memory `DashMap`.

## Problem

The OneCLI gateway caches connection resolutions, rate-limit counters, and app-injection rules. The existing `CacheStore` trait (5 methods) abstracts this nicely, but the only implementation is `InMemoryCacheStore` — a single-instance `DashMap` that doesn't survive restarts and can't coordinate across multiple gateway instances.

## What This Does

Implements the exact same `CacheStore` trait as `RedisCacheStore`:

| Trait Method    | Redis Implementation                                             |
| --------------- | ---------------------------------------------------------------- |
| `get_raw`       | `GET key`                                                        |
| `set_raw`       | `SET key value EX ttl`                                           |
| `del`           | `DEL key`                                                        |
| `del_by_prefix` | `KEYS prefix*` + `DEL`                                           |
| `incr`          | `EXISTS` check + `INCR` + `EXPIRE` (TTL on first increment only) |

All tests pass: **520 tests** (512 unit + 8 integration) with `--features redis-cache`, zero warnings.

## Architecture

```
┌─────────────────────────────────────────────┐
│              Gateway Instance                │
│  ┌──────────────────────────────────────┐   │
│  │  Connection Resolution               │   │
│  │  Rate-Limit Enforcement              │   │
│  │  App-Injection Rules                 │   │
│  └────────────┬─────────────────────────┘   │
│               │ CacheStore trait             │
│  ┌────────────▼─────────────────────────┐   │
│  │     RedisCacheStore                   │   │
│  │  redis::aio::ConnectionManager        │   │
│  └────────────┬─────────────────────────┘   │
└───────────────┼─────────────────────────────┘
                │ TCP
     ┌──────────▼──────────┐
     │       Redis         │
     │  (127.0.0.1:6379)   │
     └─────────────────────┘
```

## Key Design Decisions

1. **Extend, don't redesign.** The `CacheStore` trait is unchanged. The factory function uses `#[cfg]` to select the backend. Zero changes to call sites.
2. **Connection manager, not pool.** `redis::aio::ConnectionManager` handles automatic reconnection, which is simpler than `deadpool-redis` for this use case and matches the existing dependency.
3. **TTL via Redis expiry.** All TTLs are enforced by `SET EX` / `EXPIRE`, not lazy eviction. The `incr` method sets `EXPIRE` only on first increment (matches `InMemoryCacheStore` semantics).
4. **Prefix deletion via KEYS.** Uses `KEYS pattern*` + `DEL`. Acceptable for bounded key spaces (<10K keys). At scale, switch to `SCAN`-based iteration.

## What This Does NOT Do

This is an **independent implementation** — not a production-ready distributed cache deployment:

- No Redis Cluster or Sentinel support
- No connection encryption (TLS)
- No cache warming or preloading
- No cache stampede protection
- No Prometheus metrics instrumentation
- No multi-instance invalidation coordination (Redis pub/sub)

These are intentional scope cuts for an initial implementation.

## Usage

```bash
# Start Redis (Docker or local)
redis-server

# Build and test with redis-cache feature
cargo test --features redis-cache

# Run the gateway with Redis backend
REDIS_URL="redis://127.0.0.1:6379" cargo run --features redis-cache
```

The `create_store()` factory function selects the backend automatically:

- `#[cfg(all(not(test), feature = "redis-cache"))]` → `RedisCacheStore`
- Everything else → `InMemoryCacheStore`

## Testing

Integration tests conditionally skip if Redis is unavailable:

```
test cache::tests::test_redis_basic_roundtrip ... ok
test cache::tests::test_redis_ttl_expiry       ... ok
test cache::tests::test_redis_delete           ... ok
test cache::tests::test_redis_delete_by_prefix ... ok
test cache::tests::test_redis_increment        ... ok
test cache::tests::test_redis_missing_key      ... ok
```

## Cache-Key Scheme

Designed for tenant isolation and no raw secrets in keys. See `CACHE_KEY_DESIGN.md` for full details.

```
onecli:gateway:v1:connect:{org}:{proj}:{token_hash}:{hostname}
onecli:gateway:v1:app_injection:{org}:{proj}:{conn_id}:{hostname}
onecli:gateway:v1:rate:{org}:{proj}:{rule_id}:{token_hash}:{window_id}
```
