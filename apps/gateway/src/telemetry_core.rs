//! Shared telemetry types and utilities.
//!
//! Both OSS and cloud telemetry implementations import from this module.
//! The swapped `telemetry` module re-exports [`RequestEvent`] and [`on_request`]
//! so consumer code uses `crate::telemetry::*` without change.

use std::sync::OnceLock;

use sqlx::PgPool;
use tokio::sync::mpsc;

pub(crate) const FLUSH_INTERVAL_SECS: u64 = 5;
pub(crate) const FLUSH_BATCH_SIZE: usize = 500;
pub(crate) const CHANNEL_CAPACITY: usize = 10_000;
const MAX_PATH_LEN: usize = 2048;

pub(crate) struct RequestEvent {
    pub account_id: String,
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

/// Batch INSERT events into the `request_logs` table using UNNEST.
pub(crate) async fn insert_batch(
    pool: &PgPool,
    events: &[RequestEvent],
) -> Result<(), sqlx::Error> {
    let ids: Vec<String> = events
        .iter()
        .map(|_| uuid::Uuid::new_v4().to_string())
        .collect();
    let account_ids: Vec<String> = events.iter().map(|e| e.account_id.clone()).collect();
    let agent_ids: Vec<String> = events.iter().map(|e| e.agent_id.clone()).collect();
    let methods: Vec<String> = events.iter().map(|e| e.method.clone()).collect();
    let hosts: Vec<String> = events.iter().map(|e| e.host.clone()).collect();
    let paths: Vec<String> = events.iter().map(|e| e.path.clone()).collect();
    let providers: Vec<String> = events.iter().map(|e| e.provider.clone()).collect();
    let statuses: Vec<i32> = events.iter().map(|e| e.status as i32).collect();
    let latencies: Vec<i32> = events.iter().map(|e| e.latency_ms as i32).collect();
    let injections: Vec<i32> = events.iter().map(|e| e.injection_count as i32).collect();

    sqlx::query(
        "INSERT INTO request_logs (id, account_id, agent_id, method, host, path, provider, status, latency_ms, injection_count)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int4[], $9::int4[], $10::int4[])",
    )
    .bind(&ids)
    .bind(&account_ids)
    .bind(&agent_ids)
    .bind(&methods)
    .bind(&hosts)
    .bind(&paths)
    .bind(&providers)
    .bind(&statuses)
    .bind(&latencies)
    .bind(&injections)
    .execute(pool)
    .await?;

    Ok(())
}
