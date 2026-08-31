//! Generic metering: a pass-through byte stream that feeds response bytes to a
//! provider-specific [`UsageAccumulator`] and, at stream end (or drop), computes
//! a $ cost and emits a telemetry event carrying the budget charge.
//!
//! `has_meter` + `accumulator_for` are the per-provider extension point — adding
//! a provider is a new [`UsageAccumulator`] impl plus one match arm. Everything
//! else here (pass-through, fire-once-at-end, accounting) is provider-agnostic.

use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::{Stream, TryStreamExt};
use hyper::body::{Bytes, Frame};

use context::BodyStream;
use telemetry::core::BudgetCharge;
use telemetry::core::RequestMeta;

use super::{anthropic, spend, BudgetBinding};

type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

/// Provider-specific usage accumulator: fed raw response bytes as they stream,
/// returns the total cost (nano-dollars) at the end.
pub trait UsageAccumulator: Send {
    fn feed(&mut self, chunk: &[u8]);
    fn finish(&mut self) -> i64;
}

/// Whether a metering strategy exists for this secret type (the dispatch switch).
pub fn has_meter(secret_type: &str) -> bool {
    matches!(secret_type, "anthropic")
}

/// Build the accumulator for a secret type. `is_sse` selects streaming vs JSON
/// parsing for providers that support both (Anthropic).
fn accumulator_for(secret_type: &str, is_sse: bool) -> Option<Box<dyn UsageAccumulator>> {
    match secret_type {
        "anthropic" => Some(anthropic::accumulator(is_sse)),
        _ => None,
    }
}

/// Wrap a response stream so its cost is metered against `binding` at stream end.
/// If no meter matches the provider, the stream passes through unchanged and the
/// telemetry event fires immediately with no charge (the gate still enforced any
/// prior spend; we just can't add to it for an unmetered provider).
pub fn wrap_metered(
    binding: &BudgetBinding,
    meta: RequestMeta,
    is_sse: bool,
    stream: ByteStream,
) -> BodyStream {
    match accumulator_for(&binding.secret_type, is_sse) {
        Some(acc) => Box::pin(MeteringStream {
            inner: stream,
            acc,
            charge: Some(ChargeCtx {
                meta,
                secret_id: binding.secret_id.clone(),
                subject: binding.subject.to_string(),
                period_key: spend::period_key(binding.period),
            }),
        }),
        None => {
            telemetry::on_request(meta.into_event(None));
            Box::pin(stream.map_ok(Frame::data))
        }
    }
}

struct ChargeCtx {
    meta: RequestMeta,
    secret_id: String,
    /// Rendered [`super::BudgetSubject`] (`org:<id>` / `user:<id>`).
    subject: String,
    period_key: String,
}

struct MeteringStream {
    inner: ByteStream,
    acc: Box<dyn UsageAccumulator>,
    /// `Some` until the charge fires (exactly once, at stream end or drop).
    charge: Option<ChargeCtx>,
}

impl MeteringStream {
    fn fire(&mut self) {
        let Some(ctx) = self.charge.take() else {
            return;
        };
        let cost_nanos = self.acc.finish();
        let charge = BudgetCharge {
            secret_id: ctx.secret_id,
            subject: ctx.subject,
            period_key: ctx.period_key,
            cost_nanos,
        };
        telemetry::on_request(ctx.meta.into_event(Some(charge)));
    }
}

impl Stream for MeteringStream {
    type Item = Result<Frame<Bytes>, reqwest::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                this.acc.feed(&bytes);
                Poll::Ready(Some(Ok(Frame::data(bytes))))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e))),
            Poll::Ready(None) => {
                this.fire();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for MeteringStream {
    fn drop(&mut self) {
        // Also fires on early client disconnect / aborted stream — charging for
        // tokens parsed so far. No-op if the stream already ended cleanly.
        self.fire();
    }
}
