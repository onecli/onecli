//! Manual approval store for the gateway.
//!
//! When a request matches a `manual_approval` policy rule, the gateway holds
//! the request and stores a [`PendingApproval`] here. The SDK long-polls for
//! pending approvals and submits decisions via the gateway API.
//!
//! OSS uses an in-memory `DashMap` backend with `tokio::sync` channels.
//! Cloud swaps this module via `#[cfg(feature = "cloud")]` to use Redis.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch};
use tracing::debug;

// ── Constants ──────────────────────────────────────────────────────────

/// How long a pending approval lives before auto-deny (seconds).
pub(crate) const APPROVAL_TIMEOUT_SECS: u64 = 300;

/// How often the background task cleans up expired approvals (seconds).
const CLEANUP_INTERVAL_SECS: u64 = 30;

/// Buffer size for broadcast channels used for long-poll notifications.
const BROADCAST_CAPACITY: usize = 16;

// ── Data types ─────────────────────────────────────────────────────────

/// A request awaiting manual approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct PendingApproval {
    pub id: String,
    pub account_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub agent_identifier: Option<String>,
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body_preview: Option<String>,
    pub created_at: u64,
    pub expires_at: u64,
}

/// The decision made by the SDK consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalDecision {
    Approve,
    Deny,
}

// ── DecisionReceiver ───────────────────────────────────────────────────

/// Opaque receiver returned by [`ApprovalStore::prepare_wait`].
///
/// Must be created **before** calling `store()` to avoid a race where the
/// SDK submits a decision before the gateway starts listening.
pub(crate) struct DecisionReceiver {
    rx: watch::Receiver<Option<ApprovalDecision>>,
}

impl DecisionReceiver {
    /// Wait for a decision with timeout. Returns `None` on timeout (= auto-deny).
    pub async fn wait(mut self, timeout: Duration) -> Option<ApprovalDecision> {
        // Check if decision was already made (e.g., very fast SDK response).
        if let Some(decision) = *self.rx.borrow() {
            return Some(decision);
        }

        // Wait for the value to change, with timeout.
        tokio::time::timeout(timeout, async {
            loop {
                // `changed()` returns Err if the sender is dropped (cleanup).
                if self.rx.changed().await.is_err() {
                    return None;
                }
                if let Some(decision) = *self.rx.borrow() {
                    return Some(decision);
                }
            }
        })
        .await
        .unwrap_or_default()
    }
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
pub(crate) struct ApprovalGuard {
    approval_id: Option<String>,
    store: Arc<dyn ApprovalStore>,
}

impl ApprovalGuard {
    pub fn new(id: String, store: Arc<dyn ApprovalStore>) -> Self {
        Self {
            approval_id: Some(id),
            store,
        }
    }

    /// Prevent cleanup on drop. Call when the decision is handled normally.
    pub fn defuse(&mut self) {
        self.approval_id = None;
    }
}

impl Drop for ApprovalGuard {
    fn drop(&mut self) {
        if let Some(id) = self.approval_id.take() {
            let store = Arc::clone(&self.store);
            tokio::spawn(async move {
                store.remove(&id).await;
                debug!(approval_id = %id, "cleaned up cancelled approval");
            });
        }
    }
}

// ── Trait ───────────────────────────────────────────────────────────────

#[async_trait]
pub(crate) trait ApprovalStore: Send + Sync {
    /// Prepare a decision receiver for the given approval ID.
    ///
    /// **Must be called before `store()`** to prevent a race condition where
    /// the SDK submits a decision before the gateway starts listening.
    async fn prepare_wait(&self, id: &str) -> DecisionReceiver;

    /// Store a pending approval and notify long-polling waiters.
    ///
    /// Returns `Err` if the store is unavailable. The caller should fail the
    /// request immediately (502) rather than letting it hang for 5 minutes.
    async fn store(&self, approval: &PendingApproval) -> anyhow::Result<()>;

    /// Get a single pending approval by ID. O(1) lookup.
    async fn get_pending(&self, id: &str) -> Option<PendingApproval>;

    /// List all non-expired pending approvals for an account.
    async fn list_pending(&self, account_id: &str) -> Vec<PendingApproval>;

    /// Remove a pending approval (after decision or expiry).
    async fn remove(&self, id: &str);

    /// Block until a new approval arrives for this account, or timeout.
    /// Returns `true` if notified, `false` on timeout.
    async fn wait_for_new(&self, account_id: &str, timeout: Duration) -> bool;

    /// Submit a decision for a pending approval. Wakes the held request.
    /// Returns `true` if the approval was found and decision delivered.
    async fn submit_decision(&self, id: &str, decision: ApprovalDecision) -> bool;
}

// ── In-memory implementation ───────────────────────────────────────────

struct InMemoryApprovalStore {
    /// Pending approvals: approval_id → PendingApproval.
    pending: DashMap<String, PendingApproval>,

    /// Long-polling wake-up: account_id → broadcast::Sender<()>.
    new_notify: DashMap<String, broadcast::Sender<()>>,

    /// Decision delivery: approval_id → watch::Sender<Option<ApprovalDecision>>.
    decisions: DashMap<String, watch::Sender<Option<ApprovalDecision>>>,
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
    async fn prepare_wait(&self, id: &str) -> DecisionReceiver {
        let (tx, rx) = watch::channel(None);
        self.decisions.insert(id.to_string(), tx);
        DecisionReceiver { rx }
    }

    async fn store(&self, approval: &PendingApproval) -> anyhow::Result<()> {
        self.pending.insert(approval.id.clone(), approval.clone());

        // Notify any long-pollers for this account.
        if let Some(sender) = self.new_notify.get(&approval.account_id) {
            let _ = sender.send(()); // ok if no receivers
        }

        Ok(())
    }

    async fn get_pending(&self, id: &str) -> Option<PendingApproval> {
        let entry = self.pending.get(id)?;
        if entry.expires_at > unix_now() {
            Some(entry.value().clone())
        } else {
            drop(entry); // release guard before mutation
            self.pending.remove(id);
            None
        }
    }

    async fn list_pending(&self, account_id: &str) -> Vec<PendingApproval> {
        let now = unix_now();
        self.pending
            .iter()
            .filter(|e| e.account_id == account_id && e.expires_at > now)
            .map(|e| e.value().clone())
            .collect()
    }

    async fn remove(&self, id: &str) {
        self.pending.remove(id);
        self.decisions.remove(id);
    }

    async fn wait_for_new(&self, account_id: &str, timeout: Duration) -> bool {
        // Get or create broadcast sender, subscribe, then drop the guard
        // before awaiting (critical: never hold DashMap guard across .await).
        let mut rx = {
            let sender = self
                .new_notify
                .entry(account_id.to_string())
                .or_insert_with(|| broadcast::channel(BROADCAST_CAPACITY).0);
            sender.subscribe()
        }; // guard dropped here — safe to await

        tokio::time::timeout(timeout, rx.recv()).await.is_ok()
    }

    async fn submit_decision(&self, id: &str, decision: ApprovalDecision) -> bool {
        if let Some((_, tx)) = self.decisions.remove(id) {
            let _ = tx.send(Some(decision));
            self.pending.remove(id);
            true
        } else {
            false
        }
    }
}

/// Current unix timestamp in seconds.
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Background task that cleans up expired approvals every 30 seconds.
/// Sends `Deny` through decision channels to unblock held requests.
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
                    let _ = tx.send(Some(ApprovalDecision::Deny));
                }
                store.pending.remove(id);
            }

            if !expired.is_empty() {
                debug!(count = expired.len(), "cleaned up expired approvals");
            }

            // Prune notification channels for accounts with no pending approvals.
            // Prevents unbounded growth of the new_notify map over time.
            store
                .new_notify
                .retain(|account_id, _| store.pending.iter().any(|e| e.account_id == *account_id));
        }
    });
}

/// Create the in-memory approval store and start the cleanup task.
pub(crate) async fn create_store() -> anyhow::Result<Arc<dyn ApprovalStore>> {
    let store = Arc::new(InMemoryApprovalStore::new());
    start_cleanup_task(Arc::clone(&store));
    Ok(store)
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    async fn new_store() -> Arc<dyn ApprovalStore> {
        Arc::new(InMemoryApprovalStore::new())
    }

    fn make_approval(id: &str, account_id: &str) -> PendingApproval {
        let now = unix_now();
        PendingApproval {
            id: id.to_string(),
            account_id: account_id.to_string(),
            agent_id: "agent-1".to_string(),
            agent_name: "Test Agent".to_string(),
            agent_identifier: Some("test-agent".to_string()),
            method: "POST".to_string(),
            scheme: "https".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1/send".to_string(),
            headers: HashMap::new(),
            body_preview: None,
            created_at: now,
            expires_at: now + APPROVAL_TIMEOUT_SECS,
        }
    }

    fn make_expired_approval(id: &str, account_id: &str) -> PendingApproval {
        PendingApproval {
            id: id.to_string(),
            account_id: account_id.to_string(),
            agent_id: "agent-1".to_string(),
            agent_name: "Test Agent".to_string(),
            agent_identifier: Some("test-agent".to_string()),
            method: "POST".to_string(),
            scheme: "https".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1/send".to_string(),
            headers: HashMap::new(),
            body_preview: None,
            created_at: 0,
            expires_at: 1, // expired long ago
        }
    }

    #[tokio::test]
    async fn store_and_list_pending() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait("a1").await;
        store.store(&approval).await.unwrap();

        let pending = store.list_pending("acc-1").await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "a1");
    }

    #[tokio::test]
    async fn list_pending_filters_expired() {
        let store = new_store().await;
        let valid = make_approval("a1", "acc-1");
        let expired = make_expired_approval("a2", "acc-1");

        let _ = store.prepare_wait("a1").await;
        store.store(&valid).await.unwrap();
        let _ = store.prepare_wait("a2").await;
        store.store(&expired).await.unwrap();

        let pending = store.list_pending("acc-1").await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "a1");
    }

    #[tokio::test]
    async fn get_pending_returns_single() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait("a1").await;
        store.store(&approval).await.unwrap();

        assert!(store.get_pending("a1").await.is_some());
        assert!(store.get_pending("nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn get_pending_filters_expired() {
        let store = new_store().await;
        let expired = make_expired_approval("a1", "acc-1");

        let _ = store.prepare_wait("a1").await;
        store.store(&expired).await.unwrap();

        assert!(store.get_pending("a1").await.is_none());
    }

    #[tokio::test]
    async fn submit_decision_wakes_waiter() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let rx = store.prepare_wait("a1").await;
        store.store(&approval).await.unwrap();

        // Submit decision from another task
        let store2 = Arc::clone(&store);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            store2
                .submit_decision("a1", ApprovalDecision::Approve)
                .await;
        });

        let decision = rx.wait(Duration::from_secs(5)).await;
        assert_eq!(decision, Some(ApprovalDecision::Approve));
    }

    #[tokio::test]
    async fn submit_deny_wakes_waiter() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let rx = store.prepare_wait("a1").await;
        store.store(&approval).await.unwrap();

        let store2 = Arc::clone(&store);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            store2.submit_decision("a1", ApprovalDecision::Deny).await;
        });

        let decision = rx.wait(Duration::from_secs(5)).await;
        assert_eq!(decision, Some(ApprovalDecision::Deny));
    }

    #[tokio::test]
    async fn timeout_returns_none() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let rx = store.prepare_wait("a1").await;
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

        let _ = store.prepare_wait("a1").await;
        store.store(&a1).await.unwrap();
        let _ = store.prepare_wait("a2").await;
        store.store(&a2).await.unwrap();

        let pending_1 = store.list_pending("acc-1").await;
        assert_eq!(pending_1.len(), 1);
        assert_eq!(pending_1[0].id, "a1");

        let pending_2 = store.list_pending("acc-2").await;
        assert_eq!(pending_2.len(), 1);
        assert_eq!(pending_2[0].id, "a2");
    }

    #[tokio::test]
    async fn remove_cleans_up() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait("a1").await;
        store.store(&approval).await.unwrap();

        store.remove("a1").await;

        assert!(store.get_pending("a1").await.is_none());
        assert!(store.list_pending("acc-1").await.is_empty());
    }

    #[tokio::test]
    async fn submit_decision_removes_pending() {
        let store = new_store().await;
        let approval = make_approval("a1", "acc-1");

        let _ = store.prepare_wait("a1").await;
        store.store(&approval).await.unwrap();

        store.submit_decision("a1", ApprovalDecision::Approve).await;

        assert!(store.get_pending("a1").await.is_none());
    }

    #[tokio::test]
    async fn submit_decision_nonexistent_returns_false() {
        let store = new_store().await;
        let result = store
            .submit_decision("nonexistent", ApprovalDecision::Approve)
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
            let _ = store2.prepare_wait("a1").await;
            store2.store(&approval).await.unwrap();
        });

        let got_new = store.wait_for_new("acc-1", Duration::from_secs(5)).await;
        assert!(got_new);
    }

    #[tokio::test]
    async fn wait_for_new_timeout() {
        let store = new_store().await;
        let got_new = store
            .wait_for_new("acc-1", Duration::from_millis(100))
            .await;
        assert!(!got_new);
    }
}
