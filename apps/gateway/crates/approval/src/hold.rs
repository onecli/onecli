//! Holding one request for a human decision, the same way on every lane.
//!
//! A held request goes through four steps that must happen in this order, or
//! a decision or a cleanup is lost:
//!
//! 1. open the decision waiter BEFORE the approval is visible, so a reviewer
//!    who answers within milliseconds still reaches it;
//! 2. arm a cleanup guard BEFORE storing, so an agent that disconnects while
//!    held never leaves a card approvable into nothing;
//! 3. store the approval, which is what makes it visible;
//! 4. wait for the decision, its expiry, or the gateway's own shutdown.
//!
//! [`hold`] owns those steps. What a lane does around them (the telemetry row
//! for each step, the answer it gives the agent) stays with the lane: the
//! HTTP forward path answers in JSON, a database session answers in its own
//! wire protocol.

use std::sync::Arc;
use std::time::Duration;

use tracing::warn;

use crate::{
    ApprovalDecision, ApprovalGuard, ApprovalStore, DecisionWaitError, DenyReason, PendingApproval,
    APPROVAL_TIMEOUT_SECS,
};

/// How a held request ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldOutcome {
    /// A reviewer approved; `approved_by` is who, when the decision carried it.
    Approved { approved_by: Option<String> },
    /// The request must not run.
    Rejected {
        rejection: Rejection,
        /// The reviewer who declined, when one did and was attributed.
        decided_by: Option<String>,
    },
    /// The approval could not be stored: nothing was held, nobody saw it.
    StoreUnavailable,
    /// The decision could not be read back (a store transport failure). The
    /// request was not run, and must not be: nobody approved it.
    WaitFailed(DecisionWaitError),
    /// The gateway began shutting down with nobody having decided. The
    /// approval was withdrawn, so the agent may retry on another instance.
    ShuttingDown,
}

/// Why a held request may not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// A reviewer declined.
    Declined,
    /// Nobody decided within [`APPROVAL_TIMEOUT_SECS`].
    Expired,
    /// The person sent a message that changes this request while it was
    /// held: the agent reads it and sends a revised request.
    Superseded,
}

impl Rejection {
    /// The reason recorded on the request's telemetry row.
    #[must_use]
    pub fn telemetry_reason(self) -> &'static str {
        match self {
            Self::Declined => "denied",
            Self::Expired => "timed out",
            Self::Superseded => "superseded",
        }
    }
}

/// The request log row a held request's steps update, so a cancelled hold
/// (the agent disconnected) can mark that row instead of leaving it pending.
pub struct HoldLog {
    pub log_id: String,
    pub pool: sqlx::PgPool,
}

/// Hold `approval` until a human decides, it expires, or the gateway shuts
/// down. `on_stored` runs once the approval is visible and before waiting:
/// the caller records its "pending" row there.
///
/// Every outcome removes the approval from the store. If the future is
/// dropped (the agent went away), the guard removes it in the background and
/// marks `log` cancelled.
pub async fn hold(
    store: &Arc<dyn ApprovalStore>,
    approval: &PendingApproval,
    log: Option<HoldLog>,
    on_stored: impl FnOnce(),
) -> HoldOutcome {
    let org_id = approval.organization_id.as_str();
    let workspace_id = approval.workspace_id.as_str();
    let id = approval.id.as_str();

    let decision_rx = store.prepare_wait(org_id, workspace_id, id).await;
    let mut guard = ApprovalGuard::new(
        id.to_string(),
        org_id.to_string(),
        workspace_id.to_string(),
        Arc::clone(store),
    );
    if let Some(log) = log {
        guard.set_log_context(log.log_id, log.pool);
    }

    if let Err(error) = store.store(approval).await {
        warn!(approval_id = %id, error = ?error, "failed to store pending approval");
        guard.defuse();
        store.remove(org_id, workspace_id, id).await;
        return HoldOutcome::StoreUnavailable;
    }
    on_stored();

    let mut shutdown_signal = shutdown::subscribe();
    let waited = tokio::select! {
        outcome = decision_rx.wait(Duration::from_secs(APPROVAL_TIMEOUT_SECS)) => Some(outcome),
        // Left alone, a request held across a shutdown would be cut without an
        // answer while its card lingered, approvable into a process that no
        // longer exists. Release it explicitly instead.
        () = shutdown_signal.wait() => None,
    };
    // Every arm below cleans up itself; the guard's Drop would race it.
    guard.defuse();
    store.remove(org_id, workspace_id, id).await;

    match waited {
        None => HoldOutcome::ShuttingDown,
        Some(Err(error)) => HoldOutcome::WaitFailed(error),
        Some(Ok(outcome)) => match outcome {
            Some(o) if o.decision == ApprovalDecision::Approve => HoldOutcome::Approved {
                approved_by: o.approved_by,
            },
            Some(o) => HoldOutcome::Rejected {
                rejection: match o.reason {
                    Some(DenyReason::Superseded) => Rejection::Superseded,
                    None => Rejection::Declined,
                },
                decided_by: o.approved_by,
            },
            None => HoldOutcome::Rejected {
                rejection: Rejection::Expired,
                decided_by: None,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DecisionOutcome;

    fn pending(id: &str) -> PendingApproval {
        PendingApproval {
            id: id.to_string(),
            organization_id: "org".to_string(),
            workspace_id: "ws".to_string(),
            agent_id: "agent".to_string(),
            agent_name: "Agent".to_string(),
            agent_identifier: None,
            method: "POST".to_string(),
            scheme: "https".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1/things".to_string(),
            headers: std::collections::HashMap::new(),
            body_preview: None,
            summary: None,
            raw_body: None,
            app: None,
            batch: None,
            created_at: 0,
            expires_at: u64::MAX,
        }
    }

    /// Decide `id` as soon as it is visible, the way a reviewer would.
    fn decide_when_stored(store: &Arc<dyn ApprovalStore>, id: &str, outcome: DecisionOutcome) {
        let store = Arc::clone(store);
        let id = id.to_string();
        tokio::spawn(async move {
            while store.get_pending("org", "ws", &id).await.is_none() {
                tokio::task::yield_now().await;
            }
            assert!(store.submit_outcome("org", "ws", &id, outcome).await);
        });
    }

    #[tokio::test]
    async fn an_approval_runs_once_and_leaves_nothing_pending() {
        let store = crate::in_memory();
        decide_when_stored(
            &store,
            "a1",
            DecisionOutcome {
                decision: ApprovalDecision::Approve,
                approved_by: Some("u1".into()),
                reason: None,
            },
        );
        let mut stored = false;
        let outcome = hold(&store, &pending("a1"), None, || stored = true).await;
        assert!(stored, "the pending row is recorded before waiting");
        assert_eq!(
            outcome,
            HoldOutcome::Approved {
                approved_by: Some("u1".into())
            }
        );
        assert!(store.get_pending("org", "ws", "a1").await.is_none());
    }

    #[tokio::test]
    async fn a_deny_and_a_supersede_are_told_apart() {
        let store = crate::in_memory();
        decide_when_stored(
            &store,
            "d1",
            DecisionOutcome {
                decision: ApprovalDecision::Deny,
                approved_by: Some("u2".into()),
                reason: None,
            },
        );
        assert_eq!(
            hold(&store, &pending("d1"), None, || {}).await,
            HoldOutcome::Rejected {
                rejection: Rejection::Declined,
                decided_by: Some("u2".into())
            }
        );

        decide_when_stored(
            &store,
            "s1",
            DecisionOutcome {
                decision: ApprovalDecision::Deny,
                approved_by: None,
                reason: Some(DenyReason::Superseded),
            },
        );
        assert_eq!(
            hold(&store, &pending("s1"), None, || {}).await,
            HoldOutcome::Rejected {
                rejection: Rejection::Superseded,
                decided_by: None
            }
        );
    }

    #[test]
    fn rejections_keep_their_recorded_reasons() {
        assert_eq!(Rejection::Declined.telemetry_reason(), "denied");
        assert_eq!(Rejection::Expired.telemetry_reason(), "timed out");
        assert_eq!(Rejection::Superseded.telemetry_reason(), "superseded");
    }
}
