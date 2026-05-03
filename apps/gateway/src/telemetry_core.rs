//! Shared telemetry types and utilities.
//!
//! Both OSS and cloud telemetry implementations import from this module.
//! The swapped `telemetry` module re-exports [`RequestEvent`] and [`on_request`]
//! so consumer code uses `crate::telemetry::*` without change.

use std::sync::OnceLock;

use tokio::sync::mpsc;

pub(crate) const FLUSH_INTERVAL_SECS: u64 = 5;
pub(crate) const FLUSH_BATCH_SIZE: usize = 500;
pub(crate) const CHANNEL_CAPACITY: usize = 10_000;
const MAX_PATH_LEN: usize = 2048;

pub(crate) struct RequestEvent {
    pub project_id: String,
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
    #[cfg(feature = "cloud")]
    pub model: Option<String>,
    #[cfg(feature = "cloud")]
    pub input_tokens: Option<i32>,
    #[cfg(feature = "cloud")]
    pub output_tokens: Option<i32>,
    #[cfg(feature = "cloud")]
    pub cache_creation_input_tokens: Option<i32>,
    #[cfg(feature = "cloud")]
    pub cache_read_input_tokens: Option<i32>,
    #[cfg(feature = "cloud")]
    #[allow(dead_code)] // read by cloud telemetry (token counters), unused in OSS
    pub is_trial: bool,
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

/// Drain available events from the channel into the buffer.
/// Returns `false` when the channel is closed (sender dropped).
#[must_use]
pub(crate) async fn collect_batch(
    rx: &mut mpsc::Receiver<RequestEvent>,
    buffer: &mut Vec<RequestEvent>,
) -> bool {
    let maybe = tokio::time::timeout(
        std::time::Duration::from_secs(FLUSH_INTERVAL_SECS),
        rx.recv(),
    )
    .await;

    match maybe {
        Ok(Some(event)) => {
            buffer.push(event);
            while buffer.len() < FLUSH_BATCH_SIZE {
                match rx.try_recv() {
                    Ok(ev) => buffer.push(ev),
                    Err(_) => break,
                }
            }
            true
        }
        Ok(None) => false,
        Err(_) => true,
    }
}

/// Pre-extracted column vectors for batch INSERT into `request_logs`.
/// Accepts `&[&RequestEvent]` so callers can filter before extracting.
pub(crate) struct BatchColumns {
    pub ids: Vec<String>,
    pub project_ids: Vec<String>,
    pub agent_ids: Vec<String>,
    pub methods: Vec<String>,
    pub hosts: Vec<String>,
    pub paths: Vec<String>,
    pub providers: Vec<String>,
    pub statuses: Vec<i32>,
    pub latencies: Vec<i32>,
    pub injections: Vec<i32>,
}

pub(crate) fn extract_columns(events: &[&RequestEvent]) -> BatchColumns {
    BatchColumns {
        ids: events
            .iter()
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect(),
        project_ids: events.iter().map(|e| e.project_id.clone()).collect(),
        agent_ids: events.iter().map(|e| e.agent_id.clone()).collect(),
        methods: events.iter().map(|e| e.method.clone()).collect(),
        hosts: events.iter().map(|e| e.host.clone()).collect(),
        paths: events.iter().map(|e| e.path.clone()).collect(),
        providers: events.iter().map(|e| e.provider.clone()).collect(),
        statuses: events.iter().map(|e| e.status as i32).collect(),
        latencies: events.iter().map(|e| e.latency_ms as i32).collect(),
        injections: events.iter().map(|e| e.injection_count as i32).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_event() -> RequestEvent {
        RequestEvent {
            project_id: "p1".into(),
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
            #[cfg(feature = "cloud")]
            model: None,
            #[cfg(feature = "cloud")]
            input_tokens: None,
            #[cfg(feature = "cloud")]
            output_tokens: None,
            #[cfg(feature = "cloud")]
            cache_creation_input_tokens: None,
            #[cfg(feature = "cloud")]
            cache_read_input_tokens: None,
            #[cfg(feature = "cloud")]
            is_trial: false,
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
