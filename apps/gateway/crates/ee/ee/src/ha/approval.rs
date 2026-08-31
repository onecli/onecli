//! Redis-backed approval store — cross-instance approval storage, pub/sub
//! new-approval notification, and BLPOP decision delivery. The mechanics
//! (key formats, TTLs, the JSON-then-legacy decode, the dedicated BLPOP
//! connection) are rolling-deploy contracts — see the item docs.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use futures_util::StreamExt;
use tracing::{debug, info, warn};

use approval::{
    unix_now, ApprovalDecision, ApprovalStore, DecisionOutcome, DecisionReceiver, DecisionWait,
    PendingApproval,
};

/// TTL for Redis keys — approval timeout + buffer.
const REDIS_TTL_SECS: u64 = 190;

/// BLPOP waiter on a **dedicated connection**, not the shared
/// `ConnectionManager` — BLPOP blocks the Redis connection for up to the
/// wait duration, and blocking the shared connection would deadlock all
/// other Redis operations (store, list, submit).
struct RedisDecisionWait {
    client: redis::Client,
    key: String,
}

#[async_trait]
impl DecisionWait for RedisDecisionWait {
    async fn wait(self: Box<Self>, timeout: Duration) -> Option<DecisionOutcome> {
        wait_redis(self.client, self.key, timeout).await
    }
}

/// BLPOP wait on a dedicated connection.
/// Returns `None` on timeout or connection failure.
async fn wait_redis(
    client: redis::Client,
    key: String,
    timeout: Duration,
) -> Option<DecisionOutcome> {
    // Create a dedicated connection with response_timeout matching the
    // BLPOP wait. The default MultiplexedConnection times out after 500ms,
    // but BLPOP blocks for up to `timeout` seconds. We add 10s buffer so
    // BLPOP's server-side timeout fires first. Without this, the connection
    // kills the BLPOP almost instantly.
    let config = redis::AsyncConnectionConfig::new()
        .set_response_timeout(Some(timeout + Duration::from_secs(10)))
        .set_connection_timeout(Some(Duration::from_secs(5)));

    let mut conn = match client
        .get_multiplexed_async_connection_with_config(&config)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, key = %key, "failed to connect for BLPOP");
            return None;
        }
    };

    let timeout_secs = timeout.as_secs().max(1);

    let result: Result<Option<(String, String)>, _> = redis::cmd("BLPOP")
        .arg(&key)
        .arg(timeout_secs)
        .query_async(&mut conn)
        .await;

    match result {
        Ok(Some((_key, value))) => {
            // New payload is a JSON DecisionOutcome; fall back to the legacy
            // bare "approve"/"deny" string for rolling-deploy compatibility.
            if let Ok(outcome) = serde_json::from_str::<DecisionOutcome>(&value) {
                info!(key = %key, "BLPOP received decision");
                Some(outcome)
            } else {
                match value.as_str() {
                    "approve" => {
                        info!(key = %key, decision = "approve", "BLPOP received legacy decision");
                        Some(DecisionOutcome {
                            decision: ApprovalDecision::Approve,
                            approved_by: None,
                        })
                    }
                    "deny" => {
                        info!(key = %key, decision = "deny", "BLPOP received legacy decision");
                        Some(DecisionOutcome {
                            decision: ApprovalDecision::Deny,
                            approved_by: None,
                        })
                    }
                    _ => {
                        warn!(value = %value, "unexpected approval decision value");
                        None
                    }
                }
            }
        }
        Ok(None) => {
            info!(key = %key, "BLPOP timed out — no decision received");
            None
        }
        Err(e) => {
            warn!(error = %e, key = %key, "BLPOP failed");
            None
        }
    }
}

// ── Redis implementation ───────────────────────────────────────────────

struct RedisApprovalStore {
    /// Shared connection for regular (non-blocking) Redis operations.
    conn: redis::aio::ConnectionManager,
    /// Client used to create dedicated connections for BLPOP.
    client: redis::Client,
}

impl RedisApprovalStore {
    async fn new(redis_url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = redis::aio::ConnectionManager::new(client.clone()).await?;
        Ok(Self { conn, client })
    }
}

#[async_trait]
impl ApprovalStore for RedisApprovalStore {
    async fn prepare_wait(&self, org_id: &str, workspace_id: &str, id: &str) -> DecisionReceiver {
        // Pass the Client (not ConnectionManager) so the waiter can create a
        // dedicated connection for BLPOP without blocking shared ops.
        Box::new(RedisDecisionWait {
            client: self.client.clone(),
            key: format!("approval:decision:{org_id}:{workspace_id}:{id}"),
        })
    }

    async fn store(&self, approval: &PendingApproval) -> anyhow::Result<()> {
        let mut conn = self.conn.clone();
        let json = serde_json::to_string(approval)?;
        let org_id = &approval.organization_id;
        let workspace_id = &approval.workspace_id;

        if let Err(e) = redis::cmd("SETEX")
            .arg(format!("approval:{org_id}:{workspace_id}:{}", approval.id))
            .arg(REDIS_TTL_SECS)
            .arg(&json)
            .query_async::<()>(&mut conn)
            .await
        {
            return Err(anyhow::anyhow!("redis SETEX failed: {e}"));
        }

        let set_key = format!("approvals:{org_id}:{workspace_id}");
        let _ = redis::cmd("SADD")
            .arg(&set_key)
            .arg(&approval.id)
            .query_async::<()>(&mut conn)
            .await;
        let _ = redis::cmd("EXPIRE")
            .arg(&set_key)
            .arg(REDIS_TTL_SECS)
            .query_async::<()>(&mut conn)
            .await;

        // Notify long-pollers via pub/sub
        let _ = redis::cmd("PUBLISH")
            .arg(format!("approval:new:{org_id}:{workspace_id}"))
            .arg("1")
            .query_async::<()>(&mut conn)
            .await;

        // Org-wide index + notify: the same set/channel keyed by org only, so a
        // cross-workspace org poll (GET /v1/org/approvals/pending) can
        // SMEMBERS/SUBSCRIBE a single key. The member carries the workspace so the
        // data key `approval:{org}:{workspace}:{id}` is reconstructable on read.
        let org_set_key = format!("approvals:{org_id}");
        let _ = redis::cmd("SADD")
            .arg(&org_set_key)
            .arg(format!("{workspace_id}:{}", approval.id))
            .query_async::<()>(&mut conn)
            .await;
        let _ = redis::cmd("EXPIRE")
            .arg(&org_set_key)
            .arg(REDIS_TTL_SECS)
            .query_async::<()>(&mut conn)
            .await;
        let _ = redis::cmd("PUBLISH")
            .arg(format!("approval:new:{org_id}"))
            .arg("1")
            .query_async::<()>(&mut conn)
            .await;

        info!(approval_id = %approval.id, org_id = %org_id, workspace_id = %workspace_id, "approval stored in Redis");
        Ok(())
    }

    async fn get_pending(
        &self,
        org_id: &str,
        workspace_id: &str,
        id: &str,
    ) -> Option<PendingApproval> {
        let mut conn = self.conn.clone();
        let json: Option<String> = redis::cmd("GET")
            .arg(format!("approval:{org_id}:{workspace_id}:{id}"))
            .query_async(&mut conn)
            .await
            .ok()?;

        let approval: PendingApproval = serde_json::from_str(&json?).ok()?;

        if approval.expires_at > unix_now() {
            Some(approval)
        } else {
            None
        }
    }

    async fn list_pending(&self, org_id: &str, workspace_id: &str) -> Vec<PendingApproval> {
        let mut conn = self.conn.clone();
        let set_key = format!("approvals:{org_id}:{workspace_id}");

        let ids: Vec<String> = match redis::cmd("SMEMBERS")
            .arg(&set_key)
            .query_async(&mut conn)
            .await
        {
            Ok(ids) => ids,
            Err(e) => {
                warn!(error = %e, "redis SMEMBERS failed");
                return vec![];
            }
        };

        if ids.is_empty() {
            return vec![];
        }

        let keys: Vec<String> = ids
            .iter()
            .map(|id| format!("approval:{org_id}:{workspace_id}:{id}"))
            .collect();
        let values: Vec<Option<String>> =
            match redis::cmd("MGET").arg(&keys).query_async(&mut conn).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = %e, "redis MGET failed");
                    return vec![];
                }
            };

        let now = unix_now();

        let result: Vec<PendingApproval> = values
            .into_iter()
            .flatten()
            .filter_map(|json| serde_json::from_str::<PendingApproval>(&json).ok())
            .filter(|a| a.expires_at > now)
            .collect();
        debug!(workspace_id = %workspace_id, total_in_set = ids.len(), valid = result.len(), "listed pending approvals");
        result
    }

    async fn list_pending_for_org(&self, org_id: &str) -> Vec<PendingApproval> {
        let mut conn = self.conn.clone();
        let set_key = format!("approvals:{org_id}");

        let members: Vec<String> = match redis::cmd("SMEMBERS")
            .arg(&set_key)
            .query_async(&mut conn)
            .await
        {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, "redis SMEMBERS (org) failed");
                return vec![];
            }
        };

        // Members are "{workspace_id}:{approval_id}"; rebuild the data key.
        let keys: Vec<String> = members
            .iter()
            .filter_map(|m| m.split_once(':'))
            .map(|(workspace_id, id)| format!("approval:{org_id}:{workspace_id}:{id}"))
            .collect();
        if keys.is_empty() {
            return vec![];
        }

        let values: Vec<Option<String>> =
            match redis::cmd("MGET").arg(&keys).query_async(&mut conn).await {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = %e, "redis MGET (org) failed");
                    return vec![];
                }
            };

        let now = unix_now();

        let result: Vec<PendingApproval> = values
            .into_iter()
            .flatten()
            .filter_map(|json| serde_json::from_str::<PendingApproval>(&json).ok())
            .filter(|a| a.expires_at > now)
            .collect();
        debug!(org_id = %org_id, total_in_set = members.len(), valid = result.len(), "listed pending approvals for org");
        result
    }

    async fn remove(&self, org_id: &str, workspace_id: &str, id: &str) {
        let mut conn = self.conn.clone();

        let _ = redis::cmd("SREM")
            .arg(format!("approvals:{org_id}:{workspace_id}"))
            .arg(id)
            .query_async::<()>(&mut conn)
            .await;

        // Remove from the org-wide index set (member is "{workspace}:{id}").
        let _ = redis::cmd("SREM")
            .arg(format!("approvals:{org_id}"))
            .arg(format!("{workspace_id}:{id}"))
            .query_async::<()>(&mut conn)
            .await;

        let _ = redis::cmd("DEL")
            .arg(format!("approval:{org_id}:{workspace_id}:{id}"))
            .query_async::<()>(&mut conn)
            .await;

        // Also clean up the decision key
        let _ = redis::cmd("DEL")
            .arg(format!("approval:decision:{org_id}:{workspace_id}:{id}"))
            .query_async::<()>(&mut conn)
            .await;

        debug!(approval_id = %id, "approval removed from Redis");
    }

    async fn wait_for_new(&self, org_id: &str, workspace_id: &str, timeout: Duration) -> bool {
        // Use a separate connection for SUBSCRIBE (it blocks the connection).
        let client = match redis::Client::open(super::redis_url_from_env().as_str()) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let mut pubsub = match client.get_async_pubsub().await {
            Ok(ps) => ps,
            Err(_) => return false,
        };

        let channel = format!("approval:new:{org_id}:{workspace_id}");
        if pubsub.subscribe(&channel).await.is_err() {
            return false;
        }

        let notified = matches!(
            tokio::time::timeout(timeout, pubsub.into_on_message().next()).await,
            Ok(Some(_))
        );
        debug!(org_id = %org_id, workspace_id = %workspace_id, notified, "approval long-poll completed");
        notified
    }

    async fn wait_for_new_for_org(&self, org_id: &str, timeout: Duration) -> bool {
        // Use a separate connection for SUBSCRIBE (it blocks the connection).
        let client = match redis::Client::open(super::redis_url_from_env().as_str()) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let mut pubsub = match client.get_async_pubsub().await {
            Ok(ps) => ps,
            Err(_) => return false,
        };

        let channel = format!("approval:new:{org_id}");
        if pubsub.subscribe(&channel).await.is_err() {
            return false;
        }

        let notified = matches!(
            tokio::time::timeout(timeout, pubsub.into_on_message().next()).await,
            Ok(Some(_))
        );
        debug!(org_id = %org_id, notified, "org approval long-poll completed");
        notified
    }

    async fn submit_decision(
        &self,
        org_id: &str,
        workspace_id: &str,
        id: &str,
        decision: ApprovalDecision,
        approved_by: Option<String>,
    ) -> bool {
        let mut conn = self.conn.clone();
        let outcome = DecisionOutcome {
            decision,
            approved_by,
        };
        let value = match serde_json::to_string(&outcome) {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, approval_id = %id, "failed to serialize approval decision");
                return false;
            }
        };

        // LPUSH the JSON decision — BLPOP on the other end receives it.
        let result: Result<(), _> = redis::cmd("LPUSH")
            .arg(format!("approval:decision:{org_id}:{workspace_id}:{id}"))
            .arg(&value)
            .query_async(&mut conn)
            .await;

        if let Err(e) = result {
            warn!(error = %e, approval_id = %id, "redis LPUSH for decision failed");
            return false;
        }

        info!(approval_id = %id, decision = ?decision, "approval decision delivered via Redis");

        // Set TTL on the decision key (cleanup if BLPOP never reads it)
        let _ = redis::cmd("EXPIRE")
            .arg(format!("approval:decision:{org_id}:{workspace_id}:{id}"))
            .arg(REDIS_TTL_SECS)
            .query_async::<()>(&mut conn)
            .await;

        self.remove(org_id, workspace_id, id).await;
        true
    }
}

/// Build the Redis-backed approval store from the `REDIS_*` env vars.
pub async fn redis_approval_store() -> anyhow::Result<Arc<dyn ApprovalStore>> {
    let store = RedisApprovalStore::new(&super::redis_url_from_env())
        .await
        .context("connecting the Redis approval store")?;
    Ok(Arc::new(store))
}
