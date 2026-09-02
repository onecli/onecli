//! Anthropic usage metering: extracts token usage from the response (SSE stream
//! or non-streaming JSON) and prices it via [`super::pricing`].
//!
//! SSE: `message_start.usage` carries input + cache tokens and the model;
//! `message_delta.usage` carries the (final) output token count.

use super::meter::UsageAccumulator;
use super::pricing::{cost_nanos, TokenUsage};

/// Cap on buffered bytes for the non-streaming JSON path. A Messages response is
/// small; anything larger is treated as unparseable (charge $0 + warn) rather
/// than trusted as a partial parse.
const MAX_JSON_BYTES: usize = 256 * 1024;

/// Cap on a single buffered SSE line (one `data:` event). Anthropic events are
/// a few KB at most; an unterminated line past this is discarded so a
/// newline-less stream can't grow the buffer without bound (memory exhaustion).
const MAX_SSE_LINE_BYTES: usize = 512 * 1024;

/// Build an Anthropic accumulator. SSE responses (`text/event-stream`) parse
/// incrementally; non-streaming JSON buffers the (small) body to read `usage`.
pub fn accumulator(is_sse: bool) -> Box<dyn UsageAccumulator> {
    if is_sse {
        Box::<SseAccumulator>::default()
    } else {
        Box::<JsonAccumulator>::default()
    }
}

fn json_u64(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0)
}

fn usage_from_json(usage: Option<&serde_json::Value>, model: Option<String>) -> TokenUsage {
    TokenUsage {
        input: usage.map_or(0, |u| json_u64(u, "input_tokens")),
        output: usage.map_or(0, |u| json_u64(u, "output_tokens")),
        cache_creation: usage.map_or(0, |u| json_u64(u, "cache_creation_input_tokens")),
        cache_read: usage.map_or(0, |u| json_u64(u, "cache_read_input_tokens")),
        model,
    }
}

#[derive(Default)]
struct SseAccumulator {
    line_buf: Vec<u8>,
    usage: TokenUsage,
}

impl SseAccumulator {
    /// Associated (not `&mut self`) so a caller can borrow `self.line_buf` for
    /// the line slice and `&mut self.usage` simultaneously as disjoint fields.
    fn parse_data(usage: &mut TokenUsage, data: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        match v.get("type").and_then(serde_json::Value::as_str) {
            Some("message_start") => {
                if let Some(msg) = v.get("message") {
                    if let Some(model) = msg.get("model").and_then(serde_json::Value::as_str) {
                        usage.model = Some(model.to_string());
                    }
                    if let Some(u) = msg.get("usage") {
                        usage.input = json_u64(u, "input_tokens");
                        usage.cache_creation = json_u64(u, "cache_creation_input_tokens");
                        usage.cache_read = json_u64(u, "cache_read_input_tokens");
                    }
                }
            }
            Some("message_delta") => {
                if let Some(u) = v.get("usage") {
                    let out = json_u64(u, "output_tokens");
                    if out > 0 {
                        usage.output = out;
                    }
                }
            }
            _ => {}
        }
    }
}

impl UsageAccumulator for SseAccumulator {
    fn feed(&mut self, chunk: &[u8]) {
        self.line_buf.extend_from_slice(chunk);
        // Parse each complete line from a borrowed slice (no per-line allocation)
        // and drop all consumed bytes in a single drain (no per-line buffer shift).
        let mut consumed = 0;
        while let Some(rel) = self.line_buf[consumed..].iter().position(|&b| b == b'\n') {
            let end = consumed + rel;
            let line = &self.line_buf[consumed..end];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if let Some(rest) = line.strip_prefix(b"data:") {
                if let Ok(s) = std::str::from_utf8(rest) {
                    Self::parse_data(&mut self.usage, s.trim());
                }
            }
            consumed = end + 1;
        }
        if consumed > 0 {
            self.line_buf.drain(..consumed);
        }
        // Discard a pathologically long unterminated line so a stream with no
        // newline can't exhaust memory. Worst case we undercount that one event.
        if self.line_buf.len() > MAX_SSE_LINE_BYTES {
            tracing::warn!("budget: oversized SSE line discarded — metering may undercount");
            self.line_buf.clear();
        }
    }

    fn finish(&mut self) -> i64 {
        cost_nanos(&self.usage)
    }
}

#[derive(Default)]
struct JsonAccumulator {
    buf: Vec<u8>,
    truncated: bool,
}

impl UsageAccumulator for JsonAccumulator {
    fn feed(&mut self, chunk: &[u8]) {
        if self.truncated {
            return;
        }
        if self.buf.len() + chunk.len() > MAX_JSON_BYTES {
            self.truncated = true;
            self.buf = Vec::new();
            return;
        }
        self.buf.extend_from_slice(chunk);
    }

    fn finish(&mut self) -> i64 {
        if self.truncated {
            tracing::warn!("budget: anthropic json body exceeded cap; charging $0");
            return 0;
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&self.buf) else {
            tracing::warn!("budget: failed to parse anthropic json usage; charging $0");
            return 0;
        };
        let model = v
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(String::from);
        cost_nanos(&usage_from_json(v.get("usage"), model))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parses_message_start_and_delta_across_chunks() {
        let mut acc = SseAccumulator::default();
        // Split mid-line to exercise the line buffer.
        acc.feed(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-4-8\",\"usage\":{\"input_tokens\":1000,");
        acc.feed(b"\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}\n\n");
        acc.feed(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":100}}\n\n");
        // 1000 in × 5000 + 100 out × 25000 = 7_500_000
        assert_eq!(acc.finish(), 7_500_000);
    }

    #[test]
    fn json_parses_usage_object() {
        let mut acc = JsonAccumulator::default();
        acc.feed(
            br#"{"model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":100}}"#,
        );
        // sonnet: 1000×3000 + 100×15000 = 3_000_000 + 1_500_000
        assert_eq!(acc.finish(), 4_500_000);
    }

    #[test]
    fn json_over_cap_charges_zero() {
        let mut acc = JsonAccumulator::default();
        acc.feed(&vec![b'x'; MAX_JSON_BYTES + 1]);
        assert_eq!(acc.finish(), 0);
    }

    #[test]
    fn unparseable_json_charges_zero() {
        let mut acc = JsonAccumulator::default();
        acc.feed(b"not json");
        assert_eq!(acc.finish(), 0);
    }

    /// Counts WARN-or-higher events; the observation the dev-log finding was
    /// about (the "missing model" WARN on every session start) made visible
    /// to a test, so the fix is proven by behavior rather than inspection.
    struct WarnCounter(std::sync::Arc<std::sync::atomic::AtomicUsize>);

    impl tracing::Subscriber for WarnCounter {
        fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
            metadata.level() <= &tracing::Level::WARN
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, _: &tracing::Event<'_>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
    }

    #[test]
    fn models_list_body_meters_as_free_without_warning() {
        // The exact production shape behind the dev-log finding: jcode's
        // session-start GET /v1/models rides the meter (track_and_wrap wraps
        // every 2xx to a budgeted Anthropic credential), and its body has no
        // `usage` and no top-level `model`.
        let warns = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cost = tracing::subscriber::with_default(WarnCounter(warns.clone()), || {
            let mut acc = JsonAccumulator::default();
            acc.feed(
                br#"{"data":[{"id":"claude-opus-4-8-20260315","type":"model"},{"id":"claude-sonnet-4-6","type":"model"}],"has_more":false}"#,
            );
            acc.finish()
        });
        assert_eq!(cost, 0, "a models list is non-billable");
        assert_eq!(
            warns.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "zero-usage metering must not emit the missing-model WARN"
        );
    }

    #[test]
    fn billable_body_without_model_still_warns_and_charges() {
        // The counter-case proving the WARN (and the Opus fallback) survives
        // where it matters: tokens present, model absent.
        let warns = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cost = tracing::subscriber::with_default(WarnCounter(warns.clone()), || {
            let mut acc = JsonAccumulator::default();
            acc.feed(br#"{"usage":{"input_tokens":1000,"output_tokens":100}}"#);
            acc.finish()
        });
        // Opus fallback: 1000×5000 + 100×25000
        assert_eq!(cost, 7_500_000);
        assert_eq!(warns.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
