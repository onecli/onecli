//! Multi-instance operation (#7) — the Redis-backed store implementations.
//!
//! Running more than one gateway requires shared state: approvals decided on
//! one instance must release requests held on another, and the connect cache
//! must invalidate everywhere. That shared-state arm — the Redis approval
//! store (cross-instance storage, pub/sub notification, BLPOP decision
//! delivery) and the Redis cache store — is licensed multi-instance
//! operation and lives here. The traits, the in-memory single-instance
//! stores, and the manual-approval feature itself are free and stay in
//! `approval` / `cache`; the composition root's `wiring`
//! points call into this module only when `REDIS_HOST` is configured, which
//! [`check_ha_entitlement`] refuses at startup on an unlicensed deployment.

mod approval;
mod cache;

pub use approval::redis_approval_store;
pub use cache::redis_cache_store;

use anyhow::Result;

/// Multi-instance fail-fast (#7): Redis-backed cache/approval stores exist to
/// run more than one gateway, which is a licensed capability. An unlicensed
/// process configured with REDIS_HOST refuses to start — loudly, at startup,
/// like `check_cloud_startup_env` — rather than silently running enterprise
/// HA. Cloud is always entitled, so this never fires there. Env values come
/// in as parameters so tests never mutate process env.
pub fn check_ha_entitlement(redis_host: Option<&str>, entitled: bool) -> Result<()> {
    if entitled {
        return Ok(());
    }
    if redis_host.is_some_and(|v| !v.trim().is_empty()) {
        anyhow::bail!(
            "REDIS_HOST is set but multi-instance operation requires a OneCLI \
             Enterprise license; unset REDIS_HOST to run a single gateway on \
             the in-memory stores."
        );
    }
    Ok(())
}

/// Build the Redis connection URL from the `REDIS_*` env vars.
///
/// `REDIS_HOST` (default `localhost` — callers gate on its presence before
/// choosing a Redis backend, so the default never fires in practice),
/// `REDIS_PORT` (default `6379`), TLS on by default (`rediss://`, ElastiCache)
/// with `REDIS_TLS=false` opting out (local plain Docker Redis), and
/// `REDIS_PASSWORD` percent-encoded into the userinfo when set.
fn redis_url_from_env() -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

    let host = std::env::var("REDIS_HOST").unwrap_or_else(|_| "localhost".to_string());
    let port = std::env::var("REDIS_PORT").unwrap_or_else(|_| "6379".to_string());
    let use_tls = std::env::var("REDIS_TLS").as_deref() != Ok("false");
    let scheme = if use_tls { "rediss" } else { "redis" };

    match std::env::var("REDIS_PASSWORD") {
        Ok(password) => {
            let encoded = utf8_percent_encode(&password, NON_ALPHANUMERIC).to_string();
            format!("{scheme}://default:{encoded}@{host}:{port}")
        }
        Err(_) => format!("{scheme}://{host}:{port}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ha_entitlement_check_is_table_driven() {
        // (redis_host, entitled) → starts?
        let cases: &[(Option<&str>, bool, bool)] = &[
            (None, false, true),                    // no Redis, unlicensed → starts
            (Some(""), false, true),                // blank counts as unset
            (Some(" "), false, true),               // whitespace counts as unset
            (Some("redis.internal"), false, false), // HA unlicensed → refuses
            (Some("redis.internal"), true, true),   // HA licensed → starts
            (None, true, true),
        ];
        for (redis, entitled, starts) in cases {
            let result = check_ha_entitlement(*redis, *entitled);
            assert_eq!(
                result.is_ok(),
                *starts,
                "({redis:?}, entitled={entitled}) → {result:?}"
            );
            if !starts {
                let msg = format!("{:#}", result.unwrap_err());
                assert!(msg.contains("Enterprise license"), "message: {msg}");
            }
        }
    }
}
