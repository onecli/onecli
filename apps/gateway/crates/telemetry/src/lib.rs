//! Request telemetry.
//!
//! Combines the sinks in one background flush loop:
//! 1. **Postgres** batch INSERT — request audit log (every edition)
//! 2. **PostHog** batch analytics — fire-and-forget event capture,
//!    self-disabled unless both `POSTHOG_API_KEY` and `POSTHOG_HOST` are set
//! 3. **Redis** daily credit counters — for billing usage display (2xx only);
//!    on an OSS deployment without Redis these land in the in-memory cache
//! 4. **Budget spend** — metered charges persisted via the budget module
//!
//! Zero latency impact on the request path: events are buffered in a channel
//! and flushed every 5 seconds or when the buffer reaches 500 events.
//!
//! The [`core`] submodule holds the event types, the channel, and the flush
//! plumbing shared with the budget meter; this crate owns the sinks.

pub mod core;

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::core::{collect_batch, extract_columns, CHANNEL_CAPACITY, FLUSH_BATCH_SIZE, SENDER};
use cache::CacheStore;

// Re-export shared types for consumer code
pub use crate::core::{on_request, RequestEvent};

// ── Postgres batch INSERT (with extra_data JSONB for token usage) ─────

fn is_llm_provider(provider: &str) -> bool {
    matches!(
        provider,
        "anthropic" | "openai" | "deepseek" | "groq" | "openrouter"
    ) || policy::is_llm_host(provider)
}

/// Whether an event is written to `request_logs`, per edition. Cloud
/// additionally logs un-injected, allowed LLM-provider traffic (token usage /
/// spend visibility); onprem keeps its historical, narrower audit — injected
/// or non-allowed requests only — so the merged module never writes rows a
/// self-hosted deployment did not log before. Takes `Edition` as a parameter
/// so both arms are table-tested (`edition()` is read only at the call site).
fn keeps_event(e: &RequestEvent, edition: common::edition::Edition) -> bool {
    e.injected
        || !matches!(e.decision, crate::core::RequestDecision::Allowed)
        || (edition == common::edition::Edition::Cloud && is_llm_provider(&e.provider))
}

async fn insert_batch(pool: &PgPool, events: &[RequestEvent]) -> Result<(), sqlx::Error> {
    let edition = common::edition::edition();
    let injected: Vec<&RequestEvent> = events.iter().filter(|e| keeps_event(e, edition)).collect();
    if injected.is_empty() {
        return Ok(());
    }
    let c = extract_columns(&injected);
    let extra_data: Vec<Option<String>> =
        injected.iter().map(|e| serialize_extra_data(e)).collect();

    sqlx::query(
        "INSERT INTO request_logs (id, workspace_id, agent_id, method, host, path, provider, status, latency_ms, injection_count, extra_data, matched_rule_logical_id)
         SELECT id, workspace_id, agent_id, method, host, path, provider, status, latency_ms, injection_count, ed::jsonb, matched_rule_logical_id
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int4[], $9::int4[], $10::int4[], $11::text[], $12::text[])
         AS t(id, workspace_id, agent_id, method, host, path, provider, status, latency_ms, injection_count, ed, matched_rule_logical_id)",
    )
    .bind(&c.ids)
    .bind(&c.workspace_ids)
    .bind(&c.agent_ids)
    .bind(&c.methods)
    .bind(&c.hosts)
    .bind(&c.paths)
    .bind(&c.providers)
    .bind(&c.statuses)
    .bind(&c.latencies)
    .bind(&c.injections)
    .bind(&extra_data)
    .bind(&c.matched_rule_logical_ids)
    .execute(pool)
    .await?;

    Ok(())
}

async fn update_batch(pool: &PgPool, events: &[RequestEvent]) {
    for event in events {
        let Some(log_id) = event.existing_log_id.as_ref() else {
            continue;
        };
        let extra = serialize_extra_data(event).unwrap_or_else(|| "{}".to_string());
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

fn serialize_extra_data(event: &RequestEvent) -> Option<String> {
    use crate::core::RequestDecision;

    let has_decision = !matches!(event.decision, RequestDecision::Allowed);
    let has_label = event.connection_label.is_some();
    // A rule-decided ALLOW carries no decision label but still needs its
    // matched-rule name recorded (prod byte-compat: only fires when Some,
    // which requires the v2 engine — flag-gated — to have decided).
    let has_matched = event.matched_rule.is_some();
    if !has_decision && !has_label && !has_matched {
        return None;
    }
    let mut obj = serde_json::json!({});
    match event.decision {
        RequestDecision::Blocked { ref rule_name } => {
            obj["decision"] = serde_json::json!("blocked");
            obj["blocked_by_rule"] = serde_json::json!(rule_name);
        }
        RequestDecision::RateLimited { ref rule_name } => {
            obj["decision"] = serde_json::json!("rate_limited");
            obj["blocked_by_rule"] = serde_json::json!(rule_name);
        }
        RequestDecision::ApprovalPending {
            ref approval_id,
            ref triggered_at,
        } => {
            obj["decision"] = serde_json::json!("approval_pending");
            obj["approval_id"] = serde_json::json!(approval_id);
            obj["triggered_at"] = serde_json::json!(triggered_at);
        }
        RequestDecision::ApprovalDenied {
            ref approval_id,
            ref reason,
            ref triggered_at,
            ref resolved_at,
            ref approved_by,
        } => {
            obj["decision"] = serde_json::json!("approval_denied");
            obj["approval_id"] = serde_json::json!(approval_id);
            obj["approval_reason"] = serde_json::json!(reason);
            obj["triggered_at"] = serde_json::json!(triggered_at);
            obj["resolved_at"] = serde_json::json!(resolved_at);
            obj["approved_by"] = serde_json::json!(approved_by);
        }
        RequestDecision::ApprovalApproved {
            ref approval_id,
            ref triggered_at,
            ref resolved_at,
            ref approved_by,
        } => {
            obj["decision"] = serde_json::json!("approval_approved");
            obj["approval_id"] = serde_json::json!(approval_id);
            obj["triggered_at"] = serde_json::json!(triggered_at);
            obj["resolved_at"] = serde_json::json!(resolved_at);
            obj["approved_by"] = serde_json::json!(approved_by);
        }
        RequestDecision::BlockedByDefaultPolicy => {
            obj["decision"] = serde_json::json!("blocked_by_default_policy");
        }
        RequestDecision::Allowed => {}
    }
    if let Some(ref label) = event.connection_label {
        obj["connection_label"] = serde_json::json!(label);
    }
    // The display name + scope beside the typed column (the name survives rule
    // deletion; the logical id survives republishes; the scope lets the API
    // read side redact ORG rule names for non-admin viewers — the reflections'
    // redaction contract).
    if let Some(ref matched) = event.matched_rule {
        obj["matched_rule_name"] = serde_json::json!(matched.name);
        obj["matched_rule_scope"] = serde_json::json!(matched.scope);
    }
    Some(obj.to_string())
}

const REDIS_REQUEST_TTL_SECS: u64 = 45 * 24 * 60 * 60;
const REDIS_FLUSH_CONCURRENCY: usize = 64;

struct FlushContext {
    pool: PgPool,
    cache: Arc<dyn CacheStore>,
    posthog_api_key: String,
    posthog_url: String,
    environment: String,
    version: String,
    http_client: reqwest::Client,
}

/// Initialize the telemetry background flush task.
/// Must be called once at startup from `main()`.
pub fn init(pool: PgPool, cache: Arc<dyn CacheStore>) {
    // No baked-in defaults: both come from the deployment env (the cloud task
    // definition sets them), and PostHog stays self-disabled unless BOTH are
    // present — an API key with nowhere to send it is still off.
    let api_key = std::env::var("POSTHOG_API_KEY").unwrap_or_default();
    let api_host = std::env::var("POSTHOG_HOST").unwrap_or_default();
    let api_key = if api_host.is_empty() {
        String::new()
    } else {
        api_key
    };

    let (tx, rx) = mpsc::channel::<RequestEvent>(CHANNEL_CAPACITY);
    SENDER.set(tx).ok();

    let environment = std::env::var("ENVIRONMENT").unwrap_or_else(|_| "dev".to_string());
    let version = common::version::app_version();

    let ctx = FlushContext {
        pool,
        cache,
        posthog_url: format!("{api_host}/batch"),
        posthog_api_key: api_key,
        environment,
        version,
        http_client: reqwest::Client::new(),
    };

    crate::core::spawn_flush_loop(flush_loop(rx, ctx));
    info!("telemetry initialized (postgres + posthog + redis)");
}

async fn flush_loop(mut rx: mpsc::Receiver<RequestEvent>, ctx: FlushContext) {
    let mut buffer: Vec<RequestEvent> = Vec::with_capacity(FLUSH_BATCH_SIZE);

    loop {
        if !collect_batch(&mut rx, &mut buffer).await {
            break;
        }

        if buffer.is_empty() {
            continue;
        }

        // Partition: events with existing_log_id are token-merge UPDATEs
        // (for approved approval requests), the rest are regular INSERTs.
        let mut updates = Vec::new();
        let mut regular = Vec::new();
        for event in buffer.drain(..) {
            if event.existing_log_id.is_some() {
                updates.push(event);
            } else {
                regular.push(event);
            }
        }

        // 1a. Postgres batch INSERT (regular events)
        if let Err(e) = insert_batch(&ctx.pool, &regular).await {
            warn!(count = regular.len(), error = %e, "telemetry postgres batch failed");
        }

        // 1b. Postgres token-merge UPDATEs (approved approval events)
        if !updates.is_empty() {
            update_batch(&ctx.pool, &updates).await;
        }

        // Recombine for PostHog + Redis flushes (they need all events)
        buffer.extend(regular);
        buffer.extend(updates);

        // 2. PostHog batch analytics (self-disabled without an API key)
        if !ctx.posthog_api_key.is_empty() {
            flush_posthog(&ctx, &buffer).await;
        }

        // 3. Redis credit counters (2xx only)
        flush_redis(&ctx, &buffer).await;

        // 4. Budget spend (priced by the meter; off the request hot path)
        flush_budget(&ctx, &buffer).await;

        buffer.clear();
    }
}

// ── PostHog ──────────────────────────────────────────────────────────────

/// The PostHog `/batch` entries for a flush window: injected events only.
/// Pure so the filter and the event shape are unit-testable.
fn build_injection_batch(events: &[RequestEvent], environment: &str, version: &str) -> Vec<Value> {
    events
        .iter()
        .filter(|ev| ev.injected)
        .map(|ev| {
            json!({
                "event": "injection",
                "distinct_id": ev.workspace_id,
                "properties": {
                    "agent_id": ev.agent_id,
                    "agent_name": ev.agent_name,
                    "host": ev.host,
                    "provider": ev.provider,
                    "method": ev.method,
                    "status": ev.status,
                    "path": ev.path,
                    "latency_ms": ev.latency_ms,
                    "injection_count": ev.injection_count,
                    "environment": environment,
                    "gateway_version": version,
                },
                "timestamp": ev.timestamp,
            })
        })
        .collect()
}

async fn flush_posthog(ctx: &FlushContext, events: &[RequestEvent]) {
    let batch = build_injection_batch(events, &ctx.environment, &ctx.version);

    // A flush window with no injected events must not POST at all: PostHog's
    // ingestion rejects `"batch": []` with 400 "request holds no event", and
    // every quiet window used to trip exactly that. Same guard the redis and
    // budget sinks carry.
    if batch.is_empty() {
        return;
    }

    let count = batch.len();
    let payload = json!({
        "api_key": ctx.posthog_api_key,
        "batch": batch,
    });

    match ctx
        .http_client
        .post(&ctx.posthog_url)
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            // The body is PostHog's error JSON (e.g. a validation_error
            // detail) — small, secret-free, and the difference between a
            // diagnosable failure and a bare status code.
            let status = resp.status();
            let body: String = resp
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(512)
                .collect();
            warn!(status = %status, count, body = %body, "posthog batch flush failed");
        }
        Err(e) => {
            warn!(error = %e, count, "posthog batch flush error");
        }
    }
}

// ── Redis credit counters ────────────────────────────────────────────────
// Key format must match packages/api/src/ee/clients/redis-keys.ts

async fn flush_redis(ctx: &FlushContext, events: &[RequestEvent]) {
    use std::fmt::Write;

    let today = today_utc();

    // Pre-aggregate: count 2xx events per (workspace, agent, day) key
    let mut counts: HashMap<String, u64> = HashMap::with_capacity(events.len());
    let mut injection_counts: HashMap<String, u64> = HashMap::with_capacity(events.len());
    let mut key_buf = String::with_capacity(128);
    for ev in events {
        if !(200..300).contains(&ev.status) {
            continue;
        }

        if ev.injected {
            key_buf.clear();
            let _ = write!(
                key_buf,
                "api:injections:{}:{}:{}:{}",
                ev.org_id, ev.workspace_id, ev.agent_id, today
            );
            *injection_counts.entry(key_buf.clone()).or_default() += 1;
        }
        key_buf.clear();
        let _ = write!(
            key_buf,
            "api:requests:{}:{}:{}:{}",
            ev.org_id, ev.workspace_id, ev.agent_id, today
        );
        *counts.entry(key_buf.clone()).or_default() += 1;
    }

    if counts.is_empty() && injection_counts.is_empty() {
        return;
    }

    let all_counts = counts.into_iter().chain(injection_counts);

    let futs: Vec<_> = all_counts
        .map(|(key, amount)| {
            let cache = Arc::clone(&ctx.cache);
            async move {
                if cache
                    .incrby(&key, amount, REDIS_REQUEST_TTL_SECS)
                    .await
                    .is_none()
                {
                    warn!(key = %key, "redis credit counter increment failed");
                }
            }
        })
        .collect();

    stream::iter(futs)
        .buffer_unordered(REDIS_FLUSH_CONCURRENCY)
        .for_each(|()| async {})
        .await;
}

// ── Budget spend (cloud budget feature) ──────────────────────────────────

/// The budget-spend persistence seam. The licensed budget module implements
/// this (Redis hot counter + durable Postgres floor); the composition root
/// installs it at startup. Telemetry itself never names the licensed code —
/// it only aggregates the plain-data charges events carry.
#[async_trait::async_trait]
pub trait SpendSink: Send + Sync {
    async fn add_spend(
        &self,
        cache: &dyn CacheStore,
        pool: &sqlx::PgPool,
        secret_id: &str,
        subject: &str,
        period_key: &str,
        nanos: i64,
    );
}

static SPEND_SINK: std::sync::OnceLock<Box<dyn SpendSink>> = std::sync::OnceLock::new();

/// Install the spend sink. Called once at startup by the composition root; a
/// second call is a startup-order bug and panics.
pub fn install_spend_sink(sink: Box<dyn SpendSink>) {
    if SPEND_SINK.set(sink).is_err() {
        panic!("spend sink installed twice");
    }
}

/// Accumulate metered spend for budgeted requests. Aggregates the per-request
/// charges (already priced to nano-dollars by the meter) per (secret, org,
/// period) and persists each via the budget module (Redis hot counter + durable
/// Postgres floor). Runs off the request hot path; errors are logged, not fatal.
///
/// Charges ride the same bounded telemetry channel as request events
/// (`on_request` uses `try_send`), so under sustained backpressure a charge can
/// be dropped — a soft undercount, consistent with this being a best-effort cap
/// (the gate is already eventually-consistent with a small in-flight overshoot).
async fn flush_budget(ctx: &FlushContext, events: &[RequestEvent]) {
    let mut totals: HashMap<(String, String, String), i64> = HashMap::new();
    for ev in events {
        let Some(charge) = &ev.budget_charge else {
            continue;
        };
        if charge.cost_nanos <= 0 {
            continue;
        }
        *totals
            .entry((
                charge.secret_id.clone(),
                charge.subject.clone(),
                charge.period_key.clone(),
            ))
            .or_default() += charge.cost_nanos;
    }
    if totals.is_empty() {
        return;
    }

    let Some(sink) = SPEND_SINK.get() else {
        // No sink installed is a startup-order bug (main wires it before
        // telemetry starts); a charge must never be dropped silently.
        warn!("budget spend flush: no spend sink installed — charges dropped");
        return;
    };
    let futs: Vec<_> = totals
        .into_iter()
        .map(|((secret_id, subject, period_key), nanos)| {
            let cache = Arc::clone(&ctx.cache);
            let pool = ctx.pool.clone();
            async move {
                sink.add_spend(&*cache, &pool, &secret_id, &subject, &period_key, nanos)
                    .await;
            }
        })
        .collect();

    stream::iter(futs)
        .buffer_unordered(REDIS_FLUSH_CONCURRENCY)
        .for_each(|()| async {})
        .await;
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn today_utc() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        now.month() as u8,
        now.day()
    )
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
            decision: crate::core::RequestDecision::Allowed,
            connection_label: None,
            existing_log_id: None,
            log_id: None,
            budget_charge: None,
            matched_rule: None,
        }
    }

    // The one edition branch in this module, both arms: injected and
    // non-allowed events are logged everywhere; un-injected allowed LLM
    // traffic is a CLOUD-only row (spend visibility) — onprem keeps its
    // historical narrower audit. Pinned per arm so a filter change is a loud
    // decision, not a silent audit-surface shift.
    #[test]
    fn keeps_event_logs_llm_passthrough_only_on_cloud() {
        use common::edition::Edition;
        let mut llm_passthrough = base_event();
        llm_passthrough.injected = false; // allowed + un-injected + LLM provider
        assert!(keeps_event(&llm_passthrough, Edition::Cloud));
        assert!(!keeps_event(&llm_passthrough, Edition::Onprem));

        let mut non_llm_passthrough = base_event();
        non_llm_passthrough.injected = false;
        non_llm_passthrough.provider = "github".into();
        assert!(!keeps_event(&non_llm_passthrough, Edition::Cloud));

        // Injected, and blocked, events are audit rows in EVERY edition.
        assert!(keeps_event(&base_event(), Edition::Onprem));
        let mut blocked = base_event();
        blocked.injected = false;
        blocked.decision = crate::core::RequestDecision::Blocked {
            rule_name: "r".into(),
        };
        assert!(keeps_event(&blocked, Edition::Onprem));
    }

    #[test]
    fn injection_batch_skips_non_injected_events() {
        let mut ev = base_event();
        ev.injected = false;
        assert!(build_injection_batch(&[ev], "test", "0.0.0").is_empty());
    }

    #[test]
    fn injection_batch_carries_the_event_shape() {
        let batch = build_injection_batch(&[base_event()], "test", "0.0.0");
        assert_eq!(batch.len(), 1);
        let e = &batch[0];
        assert_eq!(e["event"], "injection");
        assert_eq!(e["distinct_id"], "p1");
        assert_eq!(e["properties"]["injection_count"], 1);
        assert_eq!(e["properties"]["environment"], "test");
        assert_eq!(e["properties"]["gateway_version"], "0.0.0");
    }

    /// The empty-batch guard, pinned at the wire: PostHog rejects
    /// `"batch": []` with 400 "request holds no event", so a window with no
    /// injected events must never POST. Deleting the guard makes the first
    /// assertion fail; the second is the positive control proving the
    /// listener actually observes real flushes.
    #[tokio::test]
    async fn empty_batch_never_posts_and_injected_batch_does() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_bg = Arc::clone(&hits);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                hits_bg.fetch_add(1, Ordering::SeqCst);
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(b"HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: 0\r\n\r\n")
                    .await;
            }
        });

        let ctx = FlushContext {
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://unused:unused@127.0.0.1:9/unused")
                .expect("lazy pool"),
            cache: cache::in_memory(),
            posthog_api_key: "phc_test".into(),
            posthog_url: format!("http://{addr}/batch"),
            environment: "test".into(),
            version: "0.0.0".into(),
            http_client: reqwest::Client::new(),
        };

        let mut non_injected = base_event();
        non_injected.injected = false;
        flush_posthog(&ctx, &[non_injected]).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0, "empty batch must not POST");

        flush_posthog(&ctx, &[base_event()]).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1, "injected batch must POST");
    }

    #[test]
    fn serialize_extra_data_returns_none_when_no_extra() {
        assert!(serialize_extra_data(&base_event()).is_none());
    }

    #[test]
    fn serialize_extra_data_records_matched_rule_name_and_scope() {
        // A rule-decided ALLOW writes exactly the attribution pair — the name
        // (display snapshot) and the scope (lets the API read side redact ORG
        // rule names for non-admin viewers) — and nothing else.
        let mut event = base_event();
        event.matched_rule = Some(policy::MatchedRule {
            logical_id: "l1".into(),
            name: "Allow gmail".into(),
            scope: "organization".into(),
        });
        let extra = serialize_extra_data(&event).expect("extra data");
        let obj: serde_json::Value = serde_json::from_str(&extra).unwrap();
        assert_eq!(obj["matched_rule_name"], "Allow gmail");
        assert_eq!(obj["matched_rule_scope"], "organization");
        assert_eq!(obj.as_object().unwrap().len(), 2);
    }
}
