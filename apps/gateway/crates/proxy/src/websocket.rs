//! WebSocket proxy: detect upgrade requests, inject credentials into the
//! handshake, connect to the upstream server, and pipe frames bidirectionally.
//!
//! This module runs alongside [`super::forward`] inside the MITM HTTP/1.1
//! service. When a WebSocket upgrade is detected, the request is routed here
//! instead of the normal reqwest-based forwarding path.

use std::time::Duration;

use anyhow::{Context, Result};
use http_body_util::{Either, Full};
use hyper::body::{Bytes, Incoming};
use hyper::client::conn::http1;
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tracing::{info, warn};

use cache::CacheStore;
use policy::PolicyDecision;

use super::hooks;
use super::mitm::ResolvedRules;
use super::response;
use context::ProxyContext;

const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

const WEBSOCKET_HANDSHAKE_HEADERS: &[&str] = &[
    "upgrade",
    "connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
    "origin",
];

const WEBSOCKET_RESPONSE_HEADERS: &[&str] = &[
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
];

pub fn is_websocket_upgrade(req: &Request<Incoming>) -> bool {
    let has_upgrade = req
        .headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));

    let has_connection = req
        .headers()
        .get("connection")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("upgrade"));

    has_upgrade && has_connection
}

fn is_websocket_forwarded_header(name: &HeaderName) -> bool {
    let s = name.as_str();
    if s == "host" || s == "content-length" || s == crate::connect::CONNECTION_ID_HEADER {
        return false;
    }
    if WEBSOCKET_HANDSHAKE_HEADERS.contains(&s) {
        return true;
    }
    const NON_WS_HOP_BY_HOP: &[&str] = &[
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailers",
        "transfer-encoding",
    ];
    !NON_WS_HOP_BY_HOP.contains(&s)
}

// 8/7: this leg needs the same request context `forward_request` does, plus the
// upstream connector resolved at CONNECT. `expect` rather than `allow` so the
// attribute is removed by CI the day a refactor drops the count back under.
#[expect(clippy::too_many_arguments)]
pub async fn handle_websocket(
    mut req: Request<Incoming>,
    host: &str,
    // The original, pre-rewrite host the policy rules match against (the effective
    // `host` may be app-rewritten) — mirrors `forward_request`'s `policy_host`.
    policy_host: &str,
    rules: &ResolvedRules,
    cache: &dyn CacheStore,
    engine: &crate::connect::PolicyEngine,
    proxy_ctx: &ProxyContext,
    // Resolved at CONNECT time against the operator's skip-verify configuration,
    // so this leg trusts exactly what the HTTP leg trusts.
    connector: &TlsConnector,
) -> Result<Response<Either<Full<Bytes>, http_body_util::StreamBody<hooks::BodyStream>>>> {
    let start = std::time::Instant::now();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    let has_injections = rules.injects();

    // An empty resource scope reaches nothing — refuse the upgrade outright
    // (the HTTP path does the same in forward.rs).
    if let Some(resp) = hooks::refuse_empty_scope(rules, proxy_ctx, policy_host, "GET", &path) {
        warn!(host = %policy_host, path = %path, "empty resource scope — WebSocket upgrade denied");
        return Ok(resp);
    }

    // Step-7 app-availability pre-check (DB-free — resolved at connect; see
    // forward.rs). Governs only identifiable app providers, so raw/LLM hosts are
    // never blocked. WebSocket upgrades are GET. Matches on `policy_host`
    // (pre-rewrite + port-stripped), NOT the port-bearing/rewritten `host`.
    if let Some(provider) =
        ee::principals::app_availability_block(policy_host, &path, &rules.available_apps)
    {
        warn!(host = %policy_host, path = %path, provider = %provider, "WebSocket app unavailable to workspace — refusing request");
        return Ok(ee::response::app_unavailable(
            &provider,
            "GET",
            &path,
            policy_host,
        ));
    }

    // The first-match engine over `policy_rules_v2` is authoritative. WebSocket
    // blocks emit no telemetry today, so the matched rule is not attributed here
    // (allow-attribution for ws is out of scope) — only the decision is consumed.
    let (decision, _matched) = policy_engine::evaluate(
        proxy_ctx,
        policy_host,
        "GET",
        &path,
        policy::ConditionBody::None,
        has_injections,
        policy::is_llm_host(host),
        rules.winning_connection_id.as_deref(),
        cache,
        &rules.policy_rules_v2,
    )
    .await;

    match &decision {
        PolicyDecision::BlockedByDefaultPolicy => {
            warn!(host = %host, path = %path, "WebSocket BLOCKED by default deny policy");
            return Ok(response::blocked_by_default_policy(
                "GET",
                &path,
                host,
                proxy_ctx.workspace_id.as_deref(),
            ));
        }
        PolicyDecision::Blocked { rule_name } => {
            warn!(host = %host, path = %path, rule = %rule_name, "WebSocket BLOCKED by policy rule");
            return Ok(response::blocked_by_policy(
                "GET",
                &path,
                rule_name,
                proxy_ctx.workspace_id.as_deref(),
            ));
        }
        PolicyDecision::RateLimited {
            limit,
            window,
            retry_after_secs,
            ..
        } => {
            warn!(host = %host, path = %path, limit, window, "WebSocket RATE LIMITED");
            return Ok(response::rate_limited(*limit, window, *retry_after_secs));
        }
        PolicyDecision::ManualApproval { .. } => {
            warn!(host = %host, path = %path, "WebSocket blocked: manual approval not supported for WebSocket");
            return Ok(response::blocked_by_policy(
                "GET",
                &path,
                "Manual approval required",
                proxy_ctx.workspace_id.as_deref(),
            ));
        }
        PolicyDecision::Allow => {}
    }

    // Run the pre-forward guards (budget, granular access) on the upgrade.
    // injection_count is 0 here, so quota is skipped. WebSocket upgrades are
    // GET with no inspectable body (the resource guard is a no-op here;
    // Dropbox/folder traffic never arrives over WebSocket).
    if let Some(resp) = hooks::pre_forward(
        rules,
        proxy_ctx,
        host,
        cache,
        &engine.pool,
        0,
        req.method().as_str(),
        &path,
        req.headers(),
        None,
    )
    .await
    {
        return Ok(resp);
    }

    let client_upgrade = hyper::upgrade::on(&mut req);

    let (parts, _body) = req.into_parts();
    let mut headers = hyper::HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if is_websocket_forwarded_header(name) {
            headers.append(name.clone(), value.clone());
        }
    }

    // The upgrade is allowed: mint any deferred credential now, exactly as the
    // HTTP path does. Without this a deferred connection would upgrade with no
    // credential at all and fail upstream — latent today (no token-scoped
    // provider serves WebSocket), load-bearing the moment one does.
    let injection_rules =
        match crate::forward::materialize_injections(rules, engine, cache, "GET", &path).await {
            Ok(rules) => rules,
            Err(resp) => return Ok(*resp),
        };

    let mut upstream_path = path.clone();
    let injection_count =
        inject::apply_injections(&mut headers, &mut upstream_path, &injection_rules);

    let hostname = common::util::strip_port(host);
    let port = host
        .split(':')
        .nth(1)
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(443);

    let upstream_io = connect_upstream_tls(hostname, port, connector)
        .await
        .context("WebSocket: connecting to upstream")?;

    let (mut sender, conn) = http1::Builder::new()
        .handshake(upstream_io)
        .await
        .context("WebSocket: upstream HTTP handshake")?;

    tokio::spawn(async move {
        if let Err(e) = conn.with_upgrades().await {
            warn!(error = %e, "WebSocket: upstream connection driver error");
        }
    });

    let mut upstream_req = Request::builder()
        .method("GET")
        .uri(&upstream_path)
        .body(http_body_util::Empty::<Bytes>::new())
        .context("building upstream WebSocket request")?;

    let host_header = if port == 443 { hostname } else { host };
    upstream_req.headers_mut().insert(
        "host",
        HeaderValue::from_str(host_header).unwrap_or(HeaderValue::from_static("localhost")),
    );
    for (name, value) in headers.iter() {
        upstream_req
            .headers_mut()
            .append(name.clone(), value.clone());
    }

    let upstream_resp = sender
        .send_request(upstream_req)
        .await
        .context("WebSocket: sending upgrade request to upstream")?;

    if upstream_resp.status() != StatusCode::SWITCHING_PROTOCOLS {
        warn!(
            host = %host,
            status = %upstream_resp.status().as_u16(),
            "WebSocket: upstream rejected upgrade"
        );
        let status = upstream_resp.status();
        let body = format!(
            "WebSocket upgrade rejected by upstream ({})",
            status.as_u16()
        );
        let mut resp = Response::new(Either::Left(Full::new(Bytes::from(body))));
        *resp.status_mut() = status;
        return Ok(resp);
    }

    let resp_headers = upstream_resp.headers().clone();

    let upstream_upgraded = hyper::upgrade::on(upstream_resp)
        .await
        .context("WebSocket: extracting upstream upgraded IO")?;

    let mut client_resp = Response::new(Either::Left(Full::new(Bytes::new())));
    *client_resp.status_mut() = StatusCode::SWITCHING_PROTOCOLS;

    for name_str in WEBSOCKET_RESPONSE_HEADERS {
        if let Ok(name) = HeaderName::from_bytes(name_str.as_bytes()) {
            if let Some(value) = resp_headers.get(&name) {
                client_resp.headers_mut().insert(name, value.clone());
            }
        }
    }

    emit_telemetry(proxy_ctx, host, &path, injection_count, start);

    let host_owned = host.to_string();
    tokio::spawn(async move {
        match client_upgrade.await {
            Ok(client_io) => {
                let mut client = TokioIo::new(client_io);
                let mut upstream = TokioIo::new(upstream_upgraded);

                match pipe_websocket(&mut client, &mut upstream, WS_IDLE_TIMEOUT).await {
                    Ok((c2s, s2c)) => {
                        info!(
                            host = %host_owned,
                            client_to_server = c2s,
                            server_to_client = s2c,
                            "WebSocket closed"
                        );
                    }
                    Err(e) => {
                        info!(host = %host_owned, error = %e, "WebSocket pipe ended");
                    }
                }
            }
            Err(e) => {
                warn!(host = %host_owned, error = %e, "WebSocket: client upgrade failed");
            }
        }
    });

    Ok(client_resp)
}

/// Dial the upstream over TLS with the connection's resolved configuration.
///
/// The config is built once at startup and handed down, so this neither
/// rebuilds a root store per upgrade nor decides for itself what to trust —
/// deciding for itself is how this leg came to ignore the operator's
/// skip-verify settings while the HTTP leg honored them.
async fn connect_upstream_tls(
    hostname: &str,
    port: u16,
    connector: &TlsConnector,
) -> Result<TokioIo<tokio_rustls::client::TlsStream<TcpStream>>> {
    let tcp = TcpStream::connect((hostname, port))
        .await
        .context("TCP connect to upstream")?;

    let server_name = rustls::pki_types::ServerName::try_from(hostname.to_string())
        .context("invalid server name")?;

    let tls_stream = connector
        .connect(server_name, tcp)
        .await
        .context("TLS handshake with upstream")?;

    Ok(TokioIo::new(tls_stream))
}

async fn pipe_websocket<C, S>(
    client: &mut C,
    server: &mut S,
    timeout: Duration,
) -> std::io::Result<(u64, u64)>
where
    C: AsyncRead + AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (cr, cw) = tokio::io::split(client);
    let (sr, sw) = tokio::io::split(server);

    let c2s = copy_with_idle_timeout(cr, sw, timeout);
    let s2c = copy_with_idle_timeout(sr, cw, timeout);

    tokio::try_join!(c2s, s2c)
}

async fn copy_with_idle_timeout<R, W>(
    mut reader: R,
    mut writer: W,
    timeout: Duration,
) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 8192];
    let mut total = 0u64;

    loop {
        let n = match tokio::time::timeout(timeout, reader.read(&mut buf)).await {
            Ok(Ok(0)) => return Ok(total),
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Ok(total),
        };
        writer.write_all(&buf[..n]).await?;
        total += n as u64;
    }
}

fn emit_telemetry(
    proxy_ctx: &ProxyContext,
    host: &str,
    path: &str,
    injection_count: usize,
    start: std::time::Instant,
) {
    info!(
        method = "WEBSOCKET",
        host = %host,
        path = %path,
        injections_applied = injection_count,
        latency_ms = start.elapsed().as_millis() as u32,
        "WebSocket upgrade"
    );

    if let (Some(pid), Some(aid)) = (
        proxy_ctx.workspace_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) {
        let hostname = common::util::strip_port(host);
        let (provider, _) =
            apps::provider_for_host_and_path(hostname, path).unwrap_or((hostname, hostname));

        telemetry::on_request(telemetry::RequestEvent {
            org_id: proxy_ctx
                .organization_id
                .as_deref()
                .unwrap_or("")
                .to_string(),
            workspace_id: pid.to_string(),
            agent_id: aid.to_string(),
            agent_name: proxy_ctx
                .agent_name
                .as_deref()
                .unwrap_or("unknown")
                .to_string(),
            method: "WEBSOCKET".to_string(),
            host: host.to_string(),
            path: path.to_string(),
            provider: provider.to_string(),
            status: 101,
            latency_ms: start.elapsed().as_millis() as u32,
            injection_count: injection_count as u16,
            timestamp: time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Iso8601::DEFAULT)
                .unwrap_or_default(),
            injected: injection_count > 0,
            decision: telemetry::core::RequestDecision::Allowed,
            connection_label: None,
            existing_log_id: None,
            log_id: None,
            budget_charge: None,
            matched_rule: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_header_preserved() {
        let name = HeaderName::from_static("sec-websocket-key");
        assert!(is_websocket_forwarded_header(&name));

        let name = HeaderName::from_static("upgrade");
        assert!(is_websocket_forwarded_header(&name));

        let name = HeaderName::from_static("connection");
        assert!(is_websocket_forwarded_header(&name));

        let name = HeaderName::from_static("origin");
        assert!(is_websocket_forwarded_header(&name));
    }

    #[test]
    fn dangerous_headers_stripped() {
        let name = HeaderName::from_static("proxy-authorization");
        assert!(!is_websocket_forwarded_header(&name));

        let name = HeaderName::from_static("host");
        assert!(!is_websocket_forwarded_header(&name));

        let name = HeaderName::from_static("transfer-encoding");
        assert!(!is_websocket_forwarded_header(&name));
    }

    #[test]
    fn regular_headers_forwarded() {
        let name = HeaderName::from_static("authorization");
        assert!(is_websocket_forwarded_header(&name));

        let name = HeaderName::from_static("x-custom-header");
        assert!(is_websocket_forwarded_header(&name));

        let name = HeaderName::from_static("accept");
        assert!(is_websocket_forwarded_header(&name));
    }
}
