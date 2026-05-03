//! Request telemetry: Postgres request logging.
//!
//! Logs every credential-injected request to the `request_logs` table via a
//! background batch INSERT. Zero latency impact on the request path.
//!
//! OSS: Postgres only. Cloud swaps this module via `#[cfg(feature = "cloud")]`
//! to add PostHog analytics + Redis credit counters.

use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::cache::CacheStore;
use crate::telemetry_core::{
    collect_batch, extract_columns, CHANNEL_CAPACITY, FLUSH_BATCH_SIZE, SENDER,
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
    let injected: Vec<&RequestEvent> = events.iter().filter(|e| e.injected).collect();
    if injected.is_empty() {
        return Ok(());
    }
    let c = extract_columns(&injected);

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

async fn flush_loop(mut rx: mpsc::Receiver<RequestEvent>, pool: PgPool) {
    let mut buffer: Vec<RequestEvent> = Vec::with_capacity(FLUSH_BATCH_SIZE);

    loop {
        if !collect_batch(&mut rx, &mut buffer).await {
            break;
        }

        if buffer.is_empty() {
            continue;
        }

        if let Err(e) = insert_batch(&pool, &buffer).await {
            warn!(count = buffer.len(), error = %e, "telemetry batch insert failed");
        }

        buffer.clear();
    }
}
