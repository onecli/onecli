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
    collect_batch, insert_batch, CHANNEL_CAPACITY, FLUSH_BATCH_SIZE, SENDER,
};

// Re-export shared types for consumer code (forward.rs)
pub(crate) use crate::telemetry_core::{on_request, RequestEvent};

/// Initialize the telemetry background flush task.
/// Must be called once at startup from `main()`.
pub(crate) fn init(pool: PgPool, _cache: Arc<dyn CacheStore>) {
    let (tx, rx) = mpsc::channel::<RequestEvent>(CHANNEL_CAPACITY);
    SENDER.set(tx).ok();
    tokio::spawn(flush_loop(rx, pool));
    info!("telemetry initialized (postgres)");
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
