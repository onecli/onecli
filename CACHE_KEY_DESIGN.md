# Cache-Key Namespace Design

## Current State

There are **3 namespaces** with **9 total call sites**:

| Prefix           | Format                                                   | Purpose             | Methods  |
| ---------------- | -------------------------------------------------------- | ------------------- | -------- |
| `app_injection:` | `app_injection:{org}:{proj}:{conn_id}:{host}[:{policy}]` | App-injection rules | get, set |
| `connect:`       | `connect:{org}:{proj}:{agent_token}:{host}`              | CONNECT resolution  | get, set |
| `rate:`          | `rate:{org}:{proj}:{rule_id}:{agent_token}:{window_id}`  | Rate-limit counter  | incr     |

Invalidation uses prefix deletion:

- `app_injection:{org}:{proj}:` — kills all injection entries for a project
- `connect:{org}:{proj}:` — kills all connect entries for a project

## Concerns

1. **No global namespace** — if another service shares the same Redis instance, key collisions are possible.
2. **Raw agent tokens in keys** — `agent_token` appears verbatim in `connect:` and `rate:` keys. Redis `KEYS`, `MONITOR`, `SLOWLOG`, and `DEBUG OBJECT` can leak these.
3. **KEYS in del_by_prefix** — `RedisCacheStore` uses `KEYS prefix*` which blocks Redis O(N) on the key space. Acceptable for small/tiny key spaces (<10K keys); dangerous at scale.

## Proposed Scheme

### Global prefix

Add a versioned global prefix so the same Redis instance can serve multiple environments or services:

```
onecli:gateway:v1:<namespace>:...
```

- `onecli` — application identifier
- `gateway` — component identifier
- `v1` — scheme version (enables future migration)

### Per-namespace structure

```
onecli:gateway:v1:app_injection:{org}:{proj}:{conn_id}:{host}[:{policy}]
onecli:gateway:v1:connect:{org}:{proj}:{token_hash}:{host}
onecli:gateway:v1:rate:{org}:{proj}:{rule_id}:{token_hash}:{window_id}
```

Key changes:

- `agent_token` → `token_hash` — first 16 hex chars of SHA-256(agent_token). Reduces leak surface while remaining collision-resistant (2^64 space).
- Invalidation prefix becomes `onecli:gateway:v1:connect:{org}:{proj}:` — same semantics, just longer.

### Token hashing utility

Add a small helper (no new deps — `sha2` is already in the tree or use the `hash` module):

```rust
fn cache_key_token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..8]) // first 16 hex chars
}
```

This is called only at key-construction time (3 call sites), so the perf cost is negligible.

## Prefix Deletion Strategy

| Scenario                               | Method                     | Risk                           |
| -------------------------------------- | -------------------------- | ------------------------------ |
| Current (small deployments, <10K keys) | `KEYS pattern*` then `DEL` | Acceptable; O(N) but N is tiny |
| At scale (>50K keys, many tenants)     | `SCAN pattern*` then `DEL` | Non-blocking; prefer `SCAN`    |

**Recommendation**: Expose a `SCAN`-based variant behind a `del_by_prefix_scanned()` method on the store, or switch `del_by_prefix` in `RedisCacheStore` to use `SCAN` unconditionally (the overhead difference is negligible for small key sets).

## TTL Strategy

| Namespace        | TTL Source                                      | Current Value   |
| ---------------- | ----------------------------------------------- | --------------- |
| `app_injection:` | `min(CACHE_TTL_SECS, token_remaining_lifetime)` | 60s or less     |
| `connect:`       | `CACHE_TTL_SECS` constant                       | 60s             |
| `rate:`          | `window_secs` (bucket duration)                 | Varies per rule |

All TTLs are set via Redis `SET EX`/`EXPIRE` — no lazy eviction needed. No change required.

## Key Size Estimates

| Namespace                      | Approx byte length | Example                                                                                   |
| ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------- |
| `app_injection:` (no policy)   | ~70-90             | `onecli:gateway:v1:app_injection:org_abc:proj_xyz:conn_42:api.example.com`                |
| `app_injection:` (with policy) | ~90-120            | `onecli:gateway:v1:app_injection:org_abc:proj_xyz:conn_42:api.example.com:session_policy` |
| `connect:`                     | ~80-110            | `onecli:gateway:v1:connect:org_abc:proj_xyz:a1b2c3d4e5f6g7h8:api.example.com`             |
| `rate:`                        | ~100-130           | `onecli:gateway:v1:rate:org_abc:proj_xyz:rule_42:a1b2c3d4e5f6g7h8:1712345678`             |

All well within Redis's 512MB key-size limit. Memory overhead is negligible.

## Migration

The `RedisCacheStore` is behind `#[cfg(feature = "redis-cache")]` and gated by the feature flag. There is no mixed-state migration needed because:

1. The feature is opt-in at build time.
2. When `redis-cache` is enabled, the previous `InMemoryCacheStore` was never persisted anyway.
3. Old keys (without the global prefix) simply expire via their existing TTL.

If a future deploy needs zero-downtime namespace migration, the `v1` in the prefix enables dual-read: check `v1` key first, fall back to unprefixed key, then stop writing unprefixed keys after a cooldown period.

## Implementation

Changes are additive to the 3 call-site files:

1. **`apps/gateway/src/connect.rs`** (lines 740-743, 1294-1297, 1331) — add global prefix to format strings, hash agent_token
2. **`apps/gateway/src/policy.rs`** (line 103) — add global prefix to format string, hash agent_token
3. **`apps/gateway/src/gateway.rs`** (lines 360, 364) — update prefix patterns for invalidation

The `CacheStore` trait and `RedisCacheStore` impl remain unchanged.

## Open Questions

1. **Token hash length**: 16 hex chars (64 bits) is sufficient for collision resistance at this scale. Should it be configurable?
2. **Case sensitivity**: Redis keys are binary-safe. Should we lowercase hostnames in keys to prevent cache duplication from casing differences? (Currently not done for InMemory either.)
3. **Prometheus metrics**: Should the `CacheStore` trait grow optional latency instrumentation, or should it be wrapped at the call sites?
