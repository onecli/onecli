//! Forward hooks — extension points for the request forwarding pipeline.
//!
//! OSS version: all hooks are no-ops. The cloud build swaps this module
//! via `#[path = "cloud/hooks.rs"]` to add trial budget enforcement and
//! Anthropic token tracking.

use std::pin::Pin;

use futures_util::TryStreamExt;
use http_body_util::{Either, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::Response;

use super::mitm::ResolvedRules;
use super::ProxyContext;

// ── Shared types ────────────────────────────────────────────────────────

pub(crate) type BodyStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Frame<Bytes>, reqwest::Error>> + Send>>;

pub(crate) type ForwardResponseBody = Either<Full<Bytes>, StreamBody<BodyStream>>;

/// Common telemetry fields for a proxied request, passed from forward to hooks.
pub(crate) struct RequestMeta {
    pub project_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub provider: String,
    pub status: u16,
    pub latency_ms: u32,
    pub injection_count: u16,
    pub timestamp: String,
    pub injected: bool,
}

// ── Hooks ───────────────────────────────────────────────────────────────

pub(crate) fn prepare_request(
    _rules: &ResolvedRules,
    _host: &str,
    _path: &str,
    _headers: &mut hyper::HeaderMap,
) {
}

pub(crate) fn pre_forward(
    _rules: &ResolvedRules,
    _proxy_ctx: &ProxyContext,
) -> Option<Response<ForwardResponseBody>> {
    None
}

pub(crate) fn track_and_wrap(
    meta: RequestMeta,
    _rules: &ResolvedRules,
    _resp_headers: &hyper::HeaderMap,
    stream: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> BodyStream {
    crate::telemetry::on_request(crate::telemetry::RequestEvent {
        project_id: meta.project_id,
        agent_id: meta.agent_id,
        agent_name: meta.agent_name,
        method: meta.method,
        host: meta.host,
        path: meta.path,
        provider: meta.provider,
        status: meta.status,
        latency_ms: meta.latency_ms,
        injection_count: meta.injection_count,
        timestamp: meta.timestamp,
        injected: meta.injected,
    });
    Box::pin(stream.map_ok(Frame::data))
}
