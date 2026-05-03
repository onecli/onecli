//! WebSocket proxy: detect upgrade requests, inject credentials into the
//! handshake, connect to the upstream server, and pipe frames bidirectionally.
//!
//! This module runs alongside [`super::forward`] inside the MITM HTTP/1.1
//! service. When a WebSocket upgrade is detected, the request is routed here
//! instead of the normal reqwest-based forwarding path.

use std::sync::Arc;
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

use crate::cache::CacheStore;
use crate::inject;
use crate::policy::{self, PolicyDecision};

use super::hooks;
use super::mitm::ResolvedRules;
use super::response;
use super::ProxyContext;

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

pub(super) fn is_websocket_upgrade(req: &Request<Incoming>) -> bool {
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

pub(super) async fn handle_websocket(
    mut req: Request<Incoming>,
    host: &str,
    rules: &ResolvedRules,
    cache: &dyn CacheStore,
    proxy_ctx: &ProxyContext,
) -> Result<Response<Either<Full<Bytes>, http_body_util::StreamBody<hooks::BodyStream>>>> {
    let start = std::time::Instant::now();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    let agent_token = proxy_ctx.agent_token.as_deref().unwrap_or("");
    let decision = policy::evaluate("GET", &path, &rules.policy_rules, agent_token, cache).await;

    match &decision {
        PolicyDecision::Blocked => {
            warn!(host = %host, path = %path, "WebSocket BLOCKED by policy rule");
            return Ok(response::blocked_by_policy("GET", &path));
        }
        PolicyDecision::RateLimited {
            limit,
            window,
            retry_after_secs,
        } => {
            warn!(host = %host, path = %path, limit, window, "WebSocket RATE LIMITED");
            return Ok(response::rate_limited(*limit, window, *retry_after_secs));
        }
        PolicyDecision::ManualApproval { .. } => {
            warn!(host = %host, path = %path, "WebSocket blocked: manual approval not supported for WebSocket");
            return Ok(response::blocked_by_policy("GET", &path));
        }
        PolicyDecision::Allow => {}
    }

    let client_upgrade = hyper::upgrade::on(&mut req);

    let (parts, _body) = req.into_parts();
    let mut headers = hyper::HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if is_websocket_forwarded_header(name) {
            headers.append(name.clone(), value.clone());
        }
    }

    let mut upstream_path = path.clone();
    let injection_count =
        inject::apply_injections(&mut headers, &mut upstream_path, &rules.injection_rules);

    let hostname = super::strip_port(host);
    let port = host
        .split(':')
        .nth(1)
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(443);

    let upstream_io = connect_upstream_tls(hostname, port)
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

async fn connect_upstream_tls(
    hostname: &str,
    port: u16,
) -> Result<TokioIo<tokio_rustls::client::TlsStream<TcpStream>>> {
    let tcp = TcpStream::connect((hostname, port))
        .await
        .context("TCP connect to upstream")?;

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let mut tls_config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    tls_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    let connector = TlsConnector::from(Arc::new(tls_config));
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
        proxy_ctx.project_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) {
        let hostname = super::strip_port(host);
        let (provider, _) =
            crate::apps::provider_for_host_and_path(hostname, path).unwrap_or((hostname, hostname));

        crate::telemetry::on_request(crate::telemetry::RequestEvent {
            project_id: pid.to_string(),
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
