//! Shared telemetry types and utilities.
//!
//! Both OSS and cloud telemetry implementations import from this module.
//! The swapped `telemetry` module re-exports [`RequestEvent`] and [`on_request`]
//! so consumer code uses `crate::telemetry::*` without change.

use std::sync::{Mutex, OnceLock};

use tokio::sync::{mpsc, watch};

pub(crate) const FLUSH_INTERVAL_SECS: u64 = 5;
pub(crate) const FLUSH_BATCH_SIZE: usize = 500;
pub(crate) const CHANNEL_CAPACITY: usize = 10_000;
const MAX_PATH_LEN: usize = 2048;

#[allow(dead_code)] // variants read by cloud telemetry (extra_data), unused in OSS
pub(crate) enum RequestDecision {
    Allowed,
    Blocked {
        rule_name: String,
    },
    RateLimited {
        rule_name: String,
    },
    ApprovalPending {
        approval_id: String,
        triggered_at: String,
    },
    ApprovalDenied {
        approval_id: String,
        reason: String,
        triggered_at: String,
        resolved_at: String,
        /// The user who denied, or `None` for a system auto-deny (timeout).
        approved_by: Option<String>,
    },
    ApprovalApproved {
        approval_id: String,
        triggered_at: String,
        resolved_at: String,
        /// The user who approved the request.
        approved_by: Option<String>,
    },
    BlockedByDefaultPolicy,
}

/// A metered spend charge attached to a request event (cloud budget feature).
/// Plain data so this shared core stays independent of the swapped `budget`
/// module; the cloud telemetry flush reads it to accumulate spend. `cost_nanos`
/// is already priced by the meter — the flush stays provider-agnostic.
#[allow(dead_code)] // read by cloud telemetry (budget flush), unused in OSS
pub(crate) struct BudgetCharge {
    pub secret_id: String,
    /// Rendered budget subject (`org:<id>` / `user:<id>`) — who the spend is
    /// attributed to. See `ee::budget::BudgetSubject`.
    pub subject: String,
    pub period_key: String,
    pub cost_nanos: i64,
}

pub(crate) struct RequestEvent {
    #[allow(dead_code)] // read by cloud telemetry (Redis counters), unused in OSS
    pub org_id: String,
    pub workspace_id: String,
    pub agent_id: String,
    #[allow(dead_code)] // read by cloud telemetry (PostHog), unused in OSS
    pub agent_name: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub provider: String,
    pub status: u16,
    pub latency_ms: u32,
    pub injection_count: u16,
    #[allow(dead_code)] // read by cloud telemetry (PostHog), unused in OSS
    pub timestamp: String,
    pub injected: bool,
    #[allow(dead_code)] // read by cloud telemetry (extra_data), unused in OSS
    pub decision: RequestDecision,
    #[allow(dead_code)] // read by cloud telemetry (extra_data), unused in OSS
    pub connection_label: Option<String>,
    #[allow(dead_code)] // read by cloud telemetry (update path), unused in OSS
    pub existing_log_id: Option<String>,
    #[allow(dead_code)] // read by cloud telemetry (pre-assigned INSERT id), unused in OSS
    pub log_id: Option<String>,
    /// Cloud-only: a metered spend charge to accumulate in the budget flush.
    /// `None` for non-budgeted requests; always `None` in OSS.
    #[allow(dead_code)] // read by cloud telemetry (budget flush), unused in OSS
    pub budget_charge: Option<BudgetCharge>,
    /// The v2 policy rule that decided this request (rule- or default-decided).
    /// `None` for plain allows and whenever the legacy path decided.
    pub matched_rule: Option<crate::policy::MatchedRule>,
}

impl crate::gateway::hooks::RequestMeta {
    /// Build the telemetry event for this request, optionally carrying a metered
    /// budget charge. Single mapping point so the default and budget paths agree.
    /// Lives here (not in `hooks`) because both the request hooks and the budget
    /// meter share it.
    pub(crate) fn into_event(self, budget_charge: Option<BudgetCharge>) -> RequestEvent {
        RequestEvent {
            org_id: self.org_id,
            workspace_id: self.workspace_id,
            agent_id: self.agent_id,
            agent_name: self.agent_name,
            method: self.method,
            host: self.host,
            path: self.path,
            provider: self.provider,
            status: self.status,
            latency_ms: self.latency_ms,
            injection_count: self.injection_count,
            timestamp: self.timestamp,
            injected: self.injected,
            decision: self.decision.unwrap_or(RequestDecision::Allowed),
            connection_label: self.connection_label,
            existing_log_id: self.existing_log_id,
            log_id: None,
            budget_charge,
            matched_rule: self.matched_rule,
        }
    }
}

pub(crate) static SENDER: OnceLock<mpsc::Sender<RequestEvent>> = OnceLock::new();

/// Record a request event. Non-blocking (~nanoseconds).
/// Silently drops events if the channel is full or not initialized.
pub(crate) fn on_request(mut event: RequestEvent) {
    if let Some(tx) = SENDER.get() {
        event.path.truncate(MAX_PATH_LEN);
        let _ = tx.try_send(event);
    }
}

/// Signals the flush loop to drain and exit. A watch rather than a flag: the
/// loop parks inside `rx.recv()`, and only something that can *wake* it will
/// do — a bare `AtomicBool` would go unnoticed until the poll interval expired.
static FLUSH_DOWN: OnceLock<watch::Sender<bool>> = OnceLock::new();

/// The flush task, so shutdown can wait for it to finish rather than guess.
static FLUSH_TASK: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::new(None);

fn flush_down_tx() -> &'static watch::Sender<bool> {
    FLUSH_DOWN.get_or_init(|| watch::channel(false).0)
}

/// Spawn the flush loop, keeping its handle for [`shutdown`].
///
/// Both editions' `init` call this instead of `tokio::spawn` — the only thing
/// they need to change to become drainable.
pub(crate) fn spawn_flush_loop<F>(flush_loop: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    *FLUSH_TASK.lock().expect("telemetry flush task") = Some(tokio::spawn(flush_loop));
}

/// Fill the buffer with whatever is already queued, without waiting.
fn fill(rx: &mut mpsc::Receiver<RequestEvent>, buffer: &mut Vec<RequestEvent>) {
    while buffer.len() < FLUSH_BATCH_SIZE {
        match rx.try_recv() {
            Ok(ev) => buffer.push(ev),
            Err(_) => break,
        }
    }
}

/// Drain available events from the channel into the buffer.
/// Returns `false` when there is nothing more to flush and the loop should end.
///
/// The buffer is always empty on entry (both flush loops drain and clear it
/// before looping), so during shutdown this returns `true` for the final
/// non-empty batch and `false` on the call after it — which is what lets the
/// loops exit through the `break` they already have.
#[must_use]
pub(crate) async fn collect_batch(
    rx: &mut mpsc::Receiver<RequestEvent>,
    buffer: &mut Vec<RequestEvent>,
) -> bool {
    let mut down = flush_down_tx().subscribe();

    if !*down.borrow() {
        tokio::select! {
            maybe = tokio::time::timeout(
                std::time::Duration::from_secs(FLUSH_INTERVAL_SECS),
                rx.recv(),
            ) => {
                return match maybe {
                    Ok(Some(event)) => {
                        buffer.push(event);
                        fill(rx, buffer);
                        true
                    }
                    Ok(None) => false,
                    Err(_) => true,
                };
            }
            _ = down.wait_for(|&down| down) => {}
        }
    }

    fill(rx, buffer);
    !buffer.is_empty()
}

/// Flush everything still buffered, then wait for the loop to finish.
///
/// Called after the connection drain, never at signal time: connections emit
/// their last events *while* they finish, and those are exactly the ones worth
/// saving — including the responses shutdown itself generates.
pub(crate) async fn shutdown(deadline: std::time::Duration) {
    let _ = flush_down_tx().send(true);

    let handle = FLUSH_TASK.lock().expect("telemetry flush task").take();
    let Some(mut handle) = handle else {
        return;
    };

    if tokio::time::timeout(deadline, &mut handle).await.is_err() {
        tracing::warn!("telemetry flush did not finish before the deadline");
        handle.abort();
    }
}

/// Pre-extracted column vectors for batch INSERT into `request_logs`.
/// Accepts `&[&RequestEvent]` so callers can filter before extracting.
pub(crate) struct BatchColumns {
    pub ids: Vec<String>,
    pub workspace_ids: Vec<String>,
    pub agent_ids: Vec<String>,
    pub methods: Vec<String>,
    pub hosts: Vec<String>,
    pub paths: Vec<String>,
    pub providers: Vec<String>,
    pub statuses: Vec<i32>,
    pub latencies: Vec<i32>,
    pub injections: Vec<i32>,
    #[allow(dead_code)] // bound only by the cloud INSERT; the OSS column stays NULL
    pub matched_rule_logical_ids: Vec<Option<String>>,
}

pub(crate) fn extract_columns(events: &[&RequestEvent]) -> BatchColumns {
    BatchColumns {
        ids: events
            .iter()
            .map(|e| {
                e.log_id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
            })
            .collect(),
        workspace_ids: events.iter().map(|e| e.workspace_id.clone()).collect(),
        agent_ids: events.iter().map(|e| e.agent_id.clone()).collect(),
        methods: events.iter().map(|e| e.method.clone()).collect(),
        hosts: events.iter().map(|e| e.host.clone()).collect(),
        paths: events.iter().map(|e| e.path.clone()).collect(),
        providers: events.iter().map(|e| e.provider.clone()).collect(),
        statuses: events.iter().map(|e| e.status as i32).collect(),
        latencies: events.iter().map(|e| e.latency_ms as i32).collect(),
        injections: events.iter().map(|e| e.injection_count as i32).collect(),
        matched_rule_logical_ids: events
            .iter()
            .map(|e| e.matched_rule.as_ref().map(|m| m.logical_id.clone()))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_event() -> RequestEvent {
        RequestEvent {
            org_id: "org1".into(),
            workspace_id: "p1".into(),
            agent_id: "a1".into(),
            agent_name: "test".into(),
            method: "POST".into(),
            host: "api.anthropic.com".into(),
            path: "/v1/messages".into(),
            provider: "anthropic".into(),
            status: 200,
            latency_ms: 100,
            injection_count: 1,
            timestamp: "2026-01-01T00:00:00Z".into(),
            injected: true,
            decision: RequestDecision::Allowed,
            connection_label: None,
            existing_log_id: None,
            log_id: None,
            budget_charge: None,
            matched_rule: None,
        }
    }

    #[test]
    fn on_request_truncates_long_paths() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        SENDER.set(tx).ok();
        let mut ev = base_event();
        ev.path = "x".repeat(MAX_PATH_LEN + 100);
        on_request(ev);
        let received = rx.try_recv().unwrap();
        assert_eq!(received.path.len(), MAX_PATH_LEN);
    }
}
