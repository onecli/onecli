//! Manual approval store for the gateway.
//!
//! When a request matches a `manual_approval` policy rule, the gateway holds
//! the request and stores a [`PendingApproval`] here. The SDK long-polls for
//! pending approvals and submits decisions via the gateway API.
//!
//! Two backends behind one trait, selected at startup by the composition
//! root's `wiring`:
//! Redis when `REDIS_HOST` is set (multi-instance deployments), else an
//! in-memory `DashMap` with `tokio::sync` channels.
//!
//! **Redis decision delivery uses `BLPOP`** (not pub/sub) to avoid the
//! subscribe-before-publish race condition that would lose decisions
//! submitted between `store()` and `SUBSCRIBE`. New-approval notifications
//! use pub/sub — the race there is benign (the SDK just polls again in 30s
//! if a notification is missed).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch};
use tracing::{debug, warn};

// ── Constants ──────────────────────────────────────────────────────────

/// How long a pending approval lives before auto-deny (seconds).
pub const APPROVAL_TIMEOUT_SECS: u64 = 180;

/// How often the background task cleans up expired approvals (seconds).
const CLEANUP_INTERVAL_SECS: u64 = 30;

/// Buffer size for broadcast channels used for long-poll notifications.
const BROADCAST_CAPACITY: usize = 16;

// ── Data types ─────────────────────────────────────────────────────────

/// A request awaiting manual approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingApproval {
    pub id: String,
    pub organization_id: String,
    /// Deserialize-only rename compat (temporary — deletion recipe in
    /// `compat.rs`): a post-rename binary reads PRE-rename Redis payloads
    /// (`project_id`), so approvals created before a deploy that crosses the
    /// rename survive onto new pods. The REVERSE is deliberately uncovered —
    /// rows a new pod writes are invisible to not-yet-replaced old pods for
    /// the rolling window, bounded by the 190s Redis TTL (and moot under the
    /// planned scale-to-zero cutover).
    #[serde(alias = "project_id")]
    pub workspace_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub agent_identifier: Option<String>,
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body_preview: Option<String>,
    /// Structured, human-readable summary of the request for approval cards.
    /// `None` for older records; consumers fall back to `body_preview`.
    #[serde(default)]
    pub summary: Option<summary::ApprovalSummary>,
    pub created_at: u64,
    pub expires_at: u64,
}

/// The decision made by the SDK consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

/// A submitted decision plus the identity that made it.
///
/// `approved_by` carries the deciding user (from the gateway `AuthUser`), or
/// `None` for a system auto-deny on timeout/cleanup. It is delivered to the
/// held request so it can be stamped onto the request log (for Redis it is
/// serialized as the decision payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionOutcome {
    pub decision: ApprovalDecision,
    #[serde(default)]
    pub approved_by: Option<String>,
}

// ── DecisionReceiver ───────────────────────────────────────────────────

/// One waiter behind [`ApprovalStore::prepare_wait`].
///
/// Must be created **before** calling `store()` to avoid a race where the
/// SDK submits a decision before the gateway starts listening. A trait object
/// rather than an enum so this shared module does not have to name every
/// backend — each store constructs its own waiter, and the Redis waiter lives
/// with its store in `ee::ha`.
#[async_trait]
pub trait DecisionWait: Send {
    /// Wait for a decision with timeout. Returns `None` on timeout (= auto-deny).
    async fn wait(self: Box<Self>, timeout: Duration) -> Option<DecisionOutcome>;
}

/// Opaque receiver returned by [`ApprovalStore::prepare_wait`].
pub type DecisionReceiver = Box<dyn DecisionWait>;

/// In-memory waiter: a watch channel completed by `submit_decision`.
struct InMemoryDecisionWait {
    rx: watch::Receiver<Option<DecisionOutcome>>,
}

#[async_trait]
impl DecisionWait for InMemoryDecisionWait {
    async fn wait(self: Box<Self>, timeout: Duration) -> Option<DecisionOutcome> {
        wait_in_memory(self.rx, timeout).await
    }
}

/// Watch-channel wait: resolves as soon as `submit_decision` stores an outcome.
async fn wait_in_memory(
    mut rx: watch::Receiver<Option<DecisionOutcome>>,
    timeout: Duration,
) -> Option<DecisionOutcome> {
    // Check if decision was already made (e.g., very fast SDK response).
    if let Some(outcome) = rx.borrow().clone() {
        return Some(outcome);
    }

    // Wait for the value to change, with timeout.
    tokio::time::timeout(timeout, async {
        loop {
            // `changed()` returns Err if the sender is dropped (cleanup).
            if rx.changed().await.is_err() {
                return None;
            }
            if let Some(outcome) = rx.borrow().clone() {
                return Some(outcome);
            }
        }
    })
    .await
    .unwrap_or_default()
}

// ── ApprovalGuard ──────────────────────────────────────────────────────

/// RAII guard that cleans up a pending approval if the request is cancelled.
///
/// When an agent disconnects while waiting for approval, tokio drops the
/// `forward_request` future. The guard's `Drop` impl spawns a cleanup task
/// to remove the orphaned approval from the store immediately, instead of
/// waiting for the 5-minute expiry.
///
/// Call [`defuse`](Self::defuse) when the decision is handled normally
/// (approve, deny, or timeout) to prevent double-cleanup.
pub struct ApprovalGuard {
    approval_id: Option<String>,
    org_id: String,
    workspace_id: String,
    store: Arc<dyn ApprovalStore>,
    log_id: Option<String>,
    pool: Option<sqlx::PgPool>,
}

impl ApprovalGuard {
    pub fn new(
        id: String,
        org_id: String,
        workspace_id: String,
        store: Arc<dyn ApprovalStore>,
    ) -> Self {
        Self {
            approval_id: Some(id),
            org_id,
            workspace_id,
            store,
            log_id: None,
            pool: None,
        }
    }

    pub fn set_log_context(&mut self, log_id: String, pool: sqlx::PgPool) {
        self.log_id = Some(log_id);
        self.pool = Some(pool);
    }

    /// Prevent cleanup on drop. Call when the decision is handled normally.
    pub fn defuse(&mut self) {
        self.approval_id = None;
        self.log_id = None;
        self.pool = None;
    }
}

impl Drop for ApprovalGuard {
    fn drop(&mut self) {
        if let Some(id) = self.approval_id.take() {
            let store = Arc::clone(&self.store);
            let org_id = self.org_id.clone();
            let workspace_id = self.workspace_id.clone();
            let log_id = self.log_id.take();
            let pool = self.pool.take();
            tokio::spawn(async move {
                store.remove(&org_id, &workspace_id, &id).await;
                if let (Some(log_id), Some(pool)) = (log_id, pool) {
                    if let Err(e) = sqlx::query(
                        "UPDATE request_logs \
                         SET extra_data = jsonb_set(\
                             COALESCE(extra_data, '{}'), \
                             '{decision}', '\"approval_cancelled\"'\
                         ) WHERE id = $1",
                    )
                    .bind(&log_id)
                    .execute(&pool)
                    .await
                    {
                        warn!(log_id = %log_id, error = %e, "failed to mark cancelled approval log");
                    }
                }
                debug!(approval_id = %id, "cleaned up cancelled approval");
            });
        }
    }
}

// ── Trait ───────────────────────────────────────────────────────────────

#[async_trait]
pub trait ApprovalStore: Send + Sync {
    /// Prepare a decision receiver for the given approval ID.
    ///
    /// **Must be called before `store()`** to prevent a race condition where
    /// the SDK submits a decision before the gateway starts listening.
    async fn prepare_wait(&self, org_id: &str, workspace_id: &str, id: &str) -> DecisionReceiver;

    /// Store a pending approval and notify long-polling waiters.
    ///
    /// Returns `Err` if the store is unavailable. The caller should fail the
    /// request immediately (502) rather than letting it hang for 5 minutes.
    async fn store(&self, approval: &PendingApproval) -> anyhow::Result<()>;

    /// Get a single pending approval by ID. O(1) lookup.
    async fn get_pending(
        &self,
        org_id: &str,
        workspace_id: &str,
        id: &str,
    ) -> Option<PendingApproval>;

    /// List all non-expired pending approvals for a workspace.
    async fn list_pending(&self, org_id: &str, workspace_id: &str) -> Vec<PendingApproval>;

    /// List all non-expired pending approvals across every workspace in an org.
    /// Backs the org poll (`GET /v1/org/approvals/pending`, `ee/org_routes`).
    async fn list_pending_for_org(&self, org_id: &str) -> Vec<PendingApproval>;

    /// Remove a pending approval (after decision or expiry).
    async fn remove(&self, org_id: &str, workspace_id: &str, id: &str);

    /// Block until a new approval arrives for this workspace, or timeout.
    /// Returns `true` if notified, `false` on timeout.
    async fn wait_for_new(&self, org_id: &str, workspace_id: &str, timeout: Duration) -> bool;

    /// Block until a new approval arrives in any of the org's workspaces, or
    /// timeout. Org-scoped counterpart of [`ApprovalStore::wait_for_new`];
    /// backs the org long-poll (`ee`'s `org_routes`).
    async fn wait_for_new_for_org(&self, org_id: &str, timeout: Duration) -> bool;

    /// Submit a decision for a pending approval. Wakes the held request.
    /// `approved_by` is the deciding user, or `None` for a system auto-deny.
    /// Returns `true` if the approval was found and decision delivered.
    async fn submit_decision(
        &self,
        org_id: &str,
        workspace_id: &str,
        id: &str,
        decision: ApprovalDecision,
        approved_by: Option<String>,
    ) -> bool;
}

// ── In-memory implementation ───────────────────────────────────────────

struct InMemoryApprovalStore {
    /// Pending approvals: approval_id → PendingApproval.
    pending: DashMap<String, PendingApproval>,

    /// Long-polling wake-up: workspace_id → broadcast::Sender<()>.
    new_notify: DashMap<String, broadcast::Sender<()>>,

    /// Decision delivery: approval_id → watch::Sender<Option<DecisionOutcome>>.
    decisions: DashMap<String, watch::Sender<Option<DecisionOutcome>>>,
}

impl InMemoryApprovalStore {
    fn new() -> Self {
        Self {
            pending: DashMap::new(),
            new_notify: DashMap::new(),
            decisions: DashMap::new(),
        }
    }
}

#[async_trait]
impl ApprovalStore for InMemoryApprovalStore {
    async fn prepare_wait(&self, _org_id: &str, _workspace_id: &str, id: &str) -> DecisionReceiver {
        let (tx, rx) = watch::channel(None);
        self.decisions.insert(id.to_string(), tx);
        Box::new(InMemoryDecisionWait { rx })
    }

    async fn store(&self, approval: &PendingApproval) -> anyhow::Result<()> {
        self.pending.insert(approval.id.clone(), approval.clone());

        // Notify any long-pollers for this workspace.
        let notify_key = format!("{}:{}", approval.organization_id, approval.workspace_id);
        if let Some(sender) = self.new_notify.get(&notify_key) {
            let _ = sender.send(()); // ok if no receivers
        }

        // Wake a cross-workspace org poll too (keyed by org only — distinct from
        // the "{org}:{workspace}" per-workspace key, so the two never collide).
        if let Some(sender) = self.new_notify.get(&approval.organization_id) {
            let _ = sender.send(());
        }

        Ok(())
    }

    async fn get_pending(
        &self,
        _org_id: &str,
        _workspace_id: &str,
        id: &str,
    ) -> Option<PendingApproval> {
        let entry = self.pending.get(id)?;
        if entry.expires_at > unix_now() {
            Some(entry.value().clone())
        } else {
            drop(entry); // release guard before mutation
            self.pending.remove(id);
            None
        }
    }

    async fn list_pending(&self, _org_id: &str, workspace_id: &str) -> Vec<PendingApproval> {
        let now = unix_now();
        self.pending
            .iter()
            .filter(|e| e.workspace_id == workspace_id && e.expires_at > now)
            .map(|e| e.value().clone())
            .collect()
    }

    async fn list_pending_for_org(&self, org_id: &str) -> Vec<PendingApproval> {
        let now = unix_now();
        self.pending
            .iter()
            .filter(|e| e.organization_id == org_id && e.expires_at > now)
            .map(|e| e.value().clone())
            .collect()
    }

    async fn remove(&self, _org_id: &str, _workspace_id: &str, id: &str) {
        self.pending.remove(id);
        self.decisions.remove(id);
    }

    async fn wait_for_new(&self, org_id: &str, workspace_id: &str, timeout: Duration) -> bool {
        let notify_key = format!("{org_id}:{workspace_id}");
        // Get or create broadcast sender, subscribe, then drop the guard
        // before awaiting (critical: never hold DashMap guard across .await).
        let mut rx = {
            let sender = self
                .new_notify
                .entry(notify_key)
                .or_insert_with(|| broadcast::channel(BROADCAST_CAPACITY).0);
            sender.subscribe()
        }; // guard dropped here — safe to await

        tokio::time::timeout(timeout, rx.recv()).await.is_ok()
    }

    async fn wait_for_new_for_org(&self, org_id: &str, timeout: Duration) -> bool {
        // Org-scoped notify keyed by the bare org id (see `store`). Never held
        // across an await: subscribe under the guard, drop it, then wait.
        let mut rx = {
            let sender = self
                .new_notify
                .entry(org_id.to_string())
                .or_insert_with(|| broadcast::channel(BROADCAST_CAPACITY).0);
            sender.subscribe()
        };

        tokio::time::timeout(timeout, rx.recv()).await.is_ok()
    }

    async fn submit_decision(
        &self,
        _org_id: &str,
        _workspace_id: &str,
        id: &str,
        decision: ApprovalDecision,
        approved_by: Option<String>,
    ) -> bool {
        if let Some((_, tx)) = self.decisions.remove(id) {
            let _ = tx.send(Some(DecisionOutcome {
                decision,
                approved_by,
            }));
            self.pending.remove(id);
            true
        } else {
            false
        }
    }
}

/// Current unix timestamp in seconds.
pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Background task that cleans up expired approvals every 30 seconds.
/// Sends `Deny` through decision channels to unblock held requests.
/// In-memory only — the Redis backend expires keys via their TTLs.
fn start_cleanup_task(store: Arc<InMemoryApprovalStore>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(CLEANUP_INTERVAL_SECS));
        loop {
            interval.tick().await;
            let now = unix_now();

            let expired: Vec<String> = store
                .pending
                .iter()
                .filter(|e| e.expires_at <= now)
                .map(|e| e.id.clone())
                .collect();

            for id in &expired {
                if let Some((_, tx)) = store.decisions.remove(id) {
                    let _ = tx.send(Some(DecisionOutcome {
                        decision: ApprovalDecision::Deny,
                        approved_by: None,
                    }));
                }
                store.pending.remove(id);
            }

            if !expired.is_empty() {
                debug!(count = expired.len(), "cleaned up expired approvals");
            }

            // Prune notification channels for workspaces with no pending approvals.
            // Prevents unbounded growth of the new_notify map over time.
            store.new_notify.retain(|workspace_id, _| {
                store
                    .pending
                    .iter()
                    .any(|e| e.workspace_id == *workspace_id)
            });
        }
    });
}

/// The in-memory approval store with its cleanup task (single-instance
/// deployments, unit tests).
///
/// Backend selection lives in the composition root (`wiring`): Redis (+BLPOP
/// delivery) when `REDIS_HOST` is set (the licensed multi-instance backend in
/// `ee::ha`), else this store. This module never reaches into the licensed
/// code.
pub fn in_memory() -> Arc<dyn ApprovalStore> {
    let store = Arc::new(InMemoryApprovalStore::new());
    start_cleanup_task(Arc::clone(&store));
    store
}

// ── Poll wire shapes ────────────────────────────────────────────────────

/// Query parameters for the pending approvals endpoint.
/// `pub(crate)` so the org route in `org_routes` can reuse the same shape.
#[derive(serde::Deserialize)]
pub struct PendingParams {
    /// Comma-separated approval IDs to exclude (already being processed by the SDK).
    /// Allows the server to enter long-poll when all pending approvals are in-flight.
    #[serde(default)]
    pub exclude: String,
}

/// Format a unix timestamp (seconds) as an ISO 8601 UTC string.
/// Falls back to epoch if the timestamp is invalid.
/// `pub(crate)` so the org route in `org_routes` can render timestamps identically.
pub fn format_unix_ts(secs: u64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let dt = UNIX_EPOCH + Duration::from_secs(secs);
    // time crate is already a dependency (for certificate validity)
    let odt = time::OffsetDateTime::from(dt);
    odt.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Render a pending approval as its poll-row wire shape. Shared with the org
/// poll (`org_routes`), which must stay byte-identical to this one.
pub fn pending_approval_row(a: &PendingApproval) -> serde_json::Value {
    let mut row = serde_json::json!({
        "id": a.id,
        "workspaceId": a.workspace_id,
        "method": a.method,
        "url": format!("{}://{}{}", a.scheme, a.host, a.path),
        "host": a.host,
        "path": a.path,
        "headers": a.headers,
        "bodyPreview": a.body_preview,
        "summary": a.summary,
        "agent": { "id": a.agent_id, "name": a.agent_name, "externalId": a.agent_identifier },
        "createdAt": format_unix_ts(a.created_at),
        "expiresAt": format_unix_ts(a.expires_at),
    });
    // Rename compat (temporary): dual-emit the legacy `projectId` field old
    // SDKs read and echo back as the decision's scope header.
    common::compat::dual_emit_legacy_workspace(&mut row, &a.workspace_id);
    row
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    /// Old-format Redis payloads (`project_id`) written by a pre-rename
    /// binary must deserialize on the new one, or every in-flight approval
    /// silently vanishes (auto-deny at timeout) during a rolling deploy.
    #[test]
    fn pending_approval_reads_the_pre_rename_redis_field() {
        let old_format = r#"{
            "id": "ap-1", "organization_id": "org-1", "project_id": "ws-1",
            "agent_id": "ag-1", "agent_name": "agent", "agent_identifier": null,
            "method": "GET", "scheme": "https", "host": "api.example.com",
            "path": "/v", "headers": {}, "body_preview": null,
            "created_at": 1, "expires_at": 2
        }"#;
        let parsed: PendingApproval =
            serde_json::from_str(old_format).expect("old-format payload must deserialize");
        assert_eq!(parsed.workspace_id, "ws-1");

        let new_format = old_format.replace("project_id", "workspace_id");
        let parsed: PendingApproval =
            serde_json::from_str(&new_format).expect("new-format payload must deserialize");
        assert_eq!(parsed.workspace_id, "ws-1");
    }
    use super::*;

    async fn new_store() -> Arc<dyn ApprovalStore> {
        Arc::new(InMemoryApprovalStore::new())
    }

    const TEST_ORG: &str = "org-1";

    fn make_approval(id: &str, workspace_id: &str) -> PendingApproval {
        let now = unix_now();
        PendingApproval {
            id: id.to_string(),
            organization_id: TEST_ORG.to_string(),
            workspace_id: workspace_id.to_string(),
            agent_id: "agent-1".to_string(),
            agent_name: "Test Agent".to_string(),
            agent_identifier: Some("test-agent".to_string()),
            method: "POST".to_string(),
            scheme: "https".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1/send".to_string(),
            headers: HashMap::new(),
            body_preview: None,
            summary: None,
            created_at: now,
            expires_at: now + APPROVAL_TIMEOUT_SECS,
        }
    }

    fn make_expired_approval(id: &str, workspace_id: &str) -> PendingApproval {
        PendingApproval {
            id: id.to_string(),
            organization_id: TEST_ORG.to_string(),
            workspace_id: workspace_id.to_string(),
            agent_id: "agent-1".to_string(),
            agent_name: "Test Agent".to_string(),
            agent_identifier: Some("test-agent".to_string()),
            method: "POST".to_string(),
            scheme: "https".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1/send".to_string(),
            headers: HashMap::new(),
            body_preview: None,
            summary: None,
            created_at: 0,
            expires_at: 1, // expired long ago
        }
    }

    #[tokio::test]
    async fn store_and_list_pending() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();

        let pending = store.list_pending(TEST_ORG, "acc-1").await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "a1");
    }

    #[tokio::test]
    async fn list_pending_filters_expired() {
        let store = new_store().await;
        let valid = make_approval("a1", "acc-1");
        let expired = make_expired_approval("a2", "acc-1");

        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&valid).await.unwrap();
        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a2").await;
        store.store(&expired).await.unwrap();

        let pending = store.list_pending(TEST_ORG, "acc-1").await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "a1");
    }

    #[tokio::test]
    async fn get_pending_returns_single() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();

        assert!(store.get_pending(TEST_ORG, "acc-1", "a1").await.is_some());
        assert!(store
            .get_pending(TEST_ORG, "acc-1", "nonexistent")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn get_pending_filters_expired() {
        let store = new_store().await;
        let expired = make_expired_approval("a1", "acc-1");

        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&expired).await.unwrap();

        assert!(store.get_pending(TEST_ORG, "acc-1", "a1").await.is_none());
    }

    #[tokio::test]
    async fn submit_decision_wakes_waiter() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let rx = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();

        // Submit decision from another task
        let store2 = Arc::clone(&store);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            store2
                .submit_decision(TEST_ORG, "acc-1", "a1", ApprovalDecision::Approve, None)
                .await;
        });

        let decision = rx.wait(Duration::from_secs(5)).await;
        assert_eq!(
            decision.map(|o| o.decision),
            Some(ApprovalDecision::Approve)
        );
    }

    #[tokio::test]
    async fn submit_decision_delivers_approver() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let rx = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();
        store
            .submit_decision(
                TEST_ORG,
                "acc-1",
                "a1",
                ApprovalDecision::Approve,
                Some("user-7".to_string()),
            )
            .await;

        let outcome = rx.wait(Duration::from_secs(5)).await;
        assert_eq!(
            outcome,
            Some(DecisionOutcome {
                decision: ApprovalDecision::Approve,
                approved_by: Some("user-7".to_string()),
            })
        );
    }

    #[tokio::test]
    async fn submit_deny_wakes_waiter() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let rx = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();

        let store2 = Arc::clone(&store);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            store2
                .submit_decision(TEST_ORG, "acc-1", "a1", ApprovalDecision::Deny, None)
                .await;
        });

        let decision = rx.wait(Duration::from_secs(5)).await;
        assert_eq!(decision.map(|o| o.decision), Some(ApprovalDecision::Deny));
    }

    #[tokio::test]
    async fn timeout_returns_none() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let rx = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();

        // No decision submitted — should timeout
        let decision = rx.wait(Duration::from_millis(100)).await;
        assert_eq!(decision, None);
    }

    #[tokio::test]
    async fn different_accounts_isolated() {
        let store = new_store().await;
        let a1 = make_approval("a1", "acc-1");
        let a2 = make_approval("a2", "acc-2");

        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&a1).await.unwrap();
        let _ = store.prepare_wait(TEST_ORG, "acc-2", "a2").await;
        store.store(&a2).await.unwrap();

        let pending_1 = store.list_pending(TEST_ORG, "acc-1").await;
        assert_eq!(pending_1.len(), 1);
        assert_eq!(pending_1[0].id, "a1");

        let pending_2 = store.list_pending(TEST_ORG, "acc-2").await;
        assert_eq!(pending_2.len(), 1);
        assert_eq!(pending_2[0].id, "a2");
    }

    #[tokio::test]
    async fn remove_cleans_up() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();

        store.remove(TEST_ORG, "acc-1", "a1").await;

        assert!(store.get_pending(TEST_ORG, "acc-1", "a1").await.is_none());
        assert!(store.list_pending(TEST_ORG, "acc-1").await.is_empty());
    }

    #[tokio::test]
    async fn submit_decision_removes_pending() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait(TEST_ORG, "acc-1", "a1").await;
        store.store(&approval).await.unwrap();

        store
            .submit_decision(TEST_ORG, "acc-1", "a1", ApprovalDecision::Approve, None)
            .await;

        assert!(store.get_pending(TEST_ORG, "acc-1", "a1").await.is_none());
    }

    #[tokio::test]
    async fn submit_decision_nonexistent_returns_false() {
        let store = new_store().await;
        let result = store
            .submit_decision(
                TEST_ORG,
                "acc-1",
                "nonexistent",
                ApprovalDecision::Approve,
                None,
            )
            .await;
        assert!(!result);
    }

    #[tokio::test]
    async fn wait_for_new_notified_on_store() {
        let store = new_store().await;

        let store2 = Arc::clone(&store);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let approval = make_approval("a1", "acc-1");
            let _ = store2.prepare_wait(TEST_ORG, "acc-1", "a1").await;
            store2.store(&approval).await.unwrap();
        });

        let got_new = store
            .wait_for_new(TEST_ORG, "acc-1", Duration::from_secs(5))
            .await;
        assert!(got_new);
    }

    #[tokio::test]
    async fn wait_for_new_timeout() {
        let store = new_store().await;
        let got_new = store
            .wait_for_new(TEST_ORG, "acc-1", Duration::from_millis(100))
            .await;
        assert!(!got_new);
    }

    // ── Org-scoped listing / long-poll ──────────────────────────────────────

    fn make_approval_in_org(id: &str, org_id: &str, workspace_id: &str) -> PendingApproval {
        PendingApproval {
            organization_id: org_id.to_string(),
            ..make_approval(id, workspace_id)
        }
    }

    #[tokio::test]
    async fn list_pending_for_org_unions_workspaces() {
        let store = new_store().await;
        let a1 = make_approval("a1", "ws-1");
        let a2 = make_approval("a2", "ws-2");

        let _ = store.prepare_wait(TEST_ORG, "ws-1", "a1").await;
        store.store(&a1).await.unwrap();
        let _ = store.prepare_wait(TEST_ORG, "ws-2", "a2").await;
        store.store(&a2).await.unwrap();

        let mut pending = store.list_pending_for_org(TEST_ORG).await;
        pending.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(pending.len(), 2);
        assert_eq!((&*pending[0].id, &*pending[0].workspace_id), ("a1", "ws-1"));
        assert_eq!((&*pending[1].id, &*pending[1].workspace_id), ("a2", "ws-2"));
    }

    #[tokio::test]
    async fn list_pending_for_org_isolates_orgs() {
        let store = new_store().await;
        let mine = make_approval_in_org("a1", "org-1", "ws-1");
        let other = make_approval_in_org("a2", "org-2", "ws-9");

        let _ = store.prepare_wait("org-1", "ws-1", "a1").await;
        store.store(&mine).await.unwrap();
        let _ = store.prepare_wait("org-2", "ws-9", "a2").await;
        store.store(&other).await.unwrap();

        let pending = store.list_pending_for_org("org-1").await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "a1");
    }

    #[tokio::test]
    async fn list_pending_for_org_filters_expired() {
        let store = new_store().await;
        let valid = make_approval("a1", "ws-1");
        let expired = make_expired_approval("a2", "ws-2");

        let _ = store.prepare_wait(TEST_ORG, "ws-1", "a1").await;
        store.store(&valid).await.unwrap();
        let _ = store.prepare_wait(TEST_ORG, "ws-2", "a2").await;
        store.store(&expired).await.unwrap();

        let pending = store.list_pending_for_org(TEST_ORG).await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "a1");
    }

    #[tokio::test]
    async fn wait_for_new_for_org_notified_on_store_in_any_workspace() {
        let store = new_store().await;

        let store2 = Arc::clone(&store);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let approval = make_approval("a1", "ws-7");
            let _ = store2.prepare_wait(TEST_ORG, "ws-7", "a1").await;
            store2.store(&approval).await.unwrap();
        });

        let got_new = store
            .wait_for_new_for_org(TEST_ORG, Duration::from_secs(5))
            .await;
        assert!(got_new);
    }
}
