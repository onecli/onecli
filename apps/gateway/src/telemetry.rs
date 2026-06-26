//! Request telemetry: Postgres request logging.
//!
//! Logs every credential-injected request to the `request_logs` table via a
//! background batch INSERT. Zero latency impact on the request path.
//!
//! OSS: Postgres only. Cloud swaps this module via `#[cfg(feature = "cloud")]`
//! to add PostHog analytics + Redis credit counters.

use std::sync::Arc;

use serde_json::json;
use sqlx::PgPool;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::cache::CacheStore;
use crate::telemetry_core::{
    collect_batch, extract_columns, RequestDecision, CHANNEL_CAPACITY, FLUSH_BATCH_SIZE, SENDER,
};

// Re-export shared types for consumer code
pub(crate) use crate::telemetry_core::{on_request, RequestEvent};

/// Initialize the telemetry background flush task.
/// Must be called once at startup from `main()`.
pub(crate) fn init(pool: PgPool, _cache: Arc<dyn CacheStore>) {
    let (tx, rx) = mpsc::channel::<RequestEvent>(CHANNEL_CAPACITY);
    SENDER.set(tx).ok();
    tokio::spawn(flush_loop(rx, pool));
    info!("telemetry initialized (postgres)");
}

async fn insert_batch(pool: &PgPool, events: &[RequestEvent]) -> Result<(), sqlx::Error> {
    let filtered: Vec<&RequestEvent> = events
        .iter()
        .filter(|e| e.injected || !matches!(e.decision, RequestDecision::Allowed))
        .collect();
    if filtered.is_empty() {
        return Ok(());
    }
    let c = extract_columns(&filtered);

    sqlx::query(
        "INSERT INTO request_logs (id, project_id, agent_id, method, host, path, provider, status, latency_ms, injection_count)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int4[], $9::int4[], $10::int4[])",
    )
    .bind(&c.ids)
    .bind(&c.project_ids)
    .bind(&c.agent_ids)
    .bind(&c.methods)
    .bind(&c.hosts)
    .bind(&c.paths)
    .bind(&c.providers)
    .bind(&c.statuses)
    .bind(&c.latencies)
    .bind(&c.injections)
    .execute(pool)
    .await?;

    Ok(())
}

async fn update_batch(pool: &PgPool, events: &[RequestEvent]) {
    for event in events {
        let Some(log_id) = event.existing_log_id.as_ref() else {
            continue;
        };
        let extra = match &event.decision {
            RequestDecision::ApprovalApproved {
                approval_id,
                triggered_at,
                resolved_at,
                approved_by,
            } => json!({
                "decision": "approval_approved",
                "approval_id": approval_id,
                "triggered_at": triggered_at,
                "resolved_at": resolved_at,
                "approved_by": approved_by,
            })
            .to_string(),
            RequestDecision::ApprovalDenied {
                approval_id,
                reason,
                triggered_at,
                resolved_at,
                approved_by,
            } => json!({
                "decision": "approval_denied",
                "approval_id": approval_id,
                "approval_reason": reason,
                "triggered_at": triggered_at,
                "resolved_at": resolved_at,
                "approved_by": approved_by,
            })
            .to_string(),
            _ => "{}".to_string(),
        };
        if let Err(e) = sqlx::query(
            "UPDATE request_logs \
             SET status = $1, latency_ms = $2, \
                 extra_data = COALESCE(extra_data, '{}'::jsonb) || $3::jsonb \
             WHERE id = $4",
        )
        .bind(event.status as i32)
        .bind(event.latency_ms as i32)
        .bind(&extra)
        .bind(log_id)
        .execute(pool)
        .await
        {
            warn!(log_id = %log_id, error = %e, "telemetry approval update failed");
        }
    }
}

async fn flush_loop(mut rx: mpsc::Receiver<RequestEvent>, pool: PgPool) {
    let mut buffer: Vec<RequestEvent> = Vec::with_capacity(FLUSH_BATCH_SIZE);

    loop {
        if !collect_batch(&mut rx, &mut buffer).await {
            break;
        }

        if buffer.is_empty() {
            continue;
        }

        let mut updates = Vec::new();
        let mut regular = Vec::new();
        for event in buffer.drain(..) {
            if event.existing_log_id.is_some() {
                updates.push(event);
            } else {
                regular.push(event);
            }
        }

        if let Err(e) = insert_batch(&pool, &regular).await {
            warn!(count = regular.len(), error = %e, "telemetry batch insert failed");
        }

        if !updates.is_empty() {
            update_batch(&pool, &updates).await;
        }

        buffer.clear();
    }
}
