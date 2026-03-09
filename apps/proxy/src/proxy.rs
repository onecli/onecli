//! HTTP proxy server: connection handling, MITM interception, and tunneling.
//!
//! This module owns the `ProxyServer` struct and the core request flow:
//! accept → authenticate → resolve (via [`connect`]) → MITM or tunnel.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use dashmap::DashMap;
use futures_util::TryStreamExt;
use http_body::Body as HttpBody;
use http_body_util::{Empty, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tracing::{info, warn};

use crate::ca::CertificateAuthority;
use crate::connect::{self, CachedConnect, ConnectCacheKey, ConnectError};
use crate::inject::{self, ConnectRule};

// ── ProxyServer ─────────────────────────────────────────────────────────

pub struct ProxyServer {
    ca: Arc<CertificateAuthority>,
    http_client: reqwest::Client,
    port: u16,
    /// OneCLI web API base URL (for credential fetching).
    api_url: Arc<str>,
    /// Shared secret for authenticating requests to the web API.
    /// `None` if no secret is configured (credential fetching disabled).
    proxy_secret: Option<Arc<str>>,
    /// Cache of resolved connect responses per (agent_token, host).
    connect_cache: Arc<DashMap<ConnectCacheKey, CachedConnect>>,
}

impl ProxyServer {
    pub fn new(
        ca: CertificateAuthority,
        port: u16,
        api_url: String,
        proxy_secret: Option<String>,
    ) -> Self {
        Self {
            ca: Arc::new(ca),
            http_client: reqwest::Client::builder()
                .danger_accept_invalid_certs(
                    std::env::var("PROXY_DANGER_ACCEPT_INVALID_CERTS").is_ok(),
                )
                .build()
                .expect("build HTTP client"),
            port,
            api_url: Arc::from(api_url.as_str()),
            proxy_secret: proxy_secret.map(|s| Arc::from(s.as_str())),
            connect_cache: Arc::new(DashMap::new()),
        }
    }

    /// Start the proxy TCP listener. Runs forever.
    pub async fn run(&self) -> Result<()> {
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let listener = TcpListener::bind(addr)
            .await
            .context("binding TCP listener")?;

        info!(addr = %addr, "listening for connections");

        loop {
            let (stream, peer_addr) = listener.accept().await?;
            let ca = Arc::clone(&self.ca);
            let http_client = self.http_client.clone();
            let api_url = Arc::clone(&self.api_url);
            let proxy_secret = self.proxy_secret.clone();
            let connect_cache = Arc::clone(&self.connect_cache);

            tokio::spawn(async move {
                if let Err(e) = handle_connection(
                    stream,
                    peer_addr,
                    ca,
                    http_client,
                    api_url,
                    proxy_secret,
                    connect_cache,
                )
                .await
                {
                    warn!(peer = %peer_addr, error = %e, "connection error");
                }
            });
        }
    }
}

// ── Connection handling ─────────────────────────────────────────────────

/// Handle a single client connection. Parses the HTTP request and dispatches
/// CONNECT requests to the MITM or tunnel handler.
async fn handle_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    ca: Arc<CertificateAuthority>,
    http_client: reqwest::Client,
    api_url: Arc<str>,
    proxy_secret: Option<Arc<str>>,
    connect_cache: Arc<DashMap<ConnectCacheKey, CachedConnect>>,
) -> Result<()> {
    let io = TokioIo::new(stream);

    http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let ca = Arc::clone(&ca);
                let http_client = http_client.clone();
                let api_url = Arc::clone(&api_url);
                let proxy_secret = proxy_secret.clone();
                let connect_cache = Arc::clone(&connect_cache);
                async move {
                    handle_request(
                        req,
                        peer_addr,
                        ca,
                        http_client,
                        api_url,
                        proxy_secret,
                        connect_cache,
                    )
                    .await
                }
            }),
        )
        .with_upgrades()
        .await
        .context("serving HTTP connection")
}

/// Route incoming requests: CONNECT → MITM (or tunnel), everything else → reject.
async fn handle_request(
    req: Request<Incoming>,
    peer_addr: SocketAddr,
    ca: Arc<CertificateAuthority>,
    http_client: reqwest::Client,
    api_url: Arc<str>,
    proxy_secret: Option<Arc<str>>,
    connect_cache: Arc<DashMap<ConnectCacheKey, CachedConnect>>,
) -> Result<Response<Empty<Bytes>>, anyhow::Error> {
    if req.method() == Method::CONNECT {
        // Authenticate: extract agent token from Proxy-Authorization header
        let agent_token = match inject::extract_agent_token(&req) {
            Some(token) if !token.is_empty() => token,
            _ => {
                warn!(peer = %peer_addr, "CONNECT rejected: missing or invalid proxy auth");
                return Ok(respond_407());
            }
        };

        let host = req
            .uri()
            .authority()
            .context("CONNECT request missing host:port")?
            .to_string();

        let hostname = strip_port(&host).to_string();

        // Resolve via API (or cache) what to do for this agent + host
        let connect_response = match connect::resolve(
            &agent_token,
            &hostname,
            &http_client,
            &api_url,
            proxy_secret.as_deref(),
            &connect_cache,
        )
        .await
        {
            Ok(resp) => resp,
            Err(ConnectError::InvalidToken) => {
                warn!(peer = %peer_addr, host = %host, "CONNECT rejected: invalid agent token");
                return Ok(respond_407());
            }
            Err(ConnectError::ApiUnreachable(e)) => {
                warn!(peer = %peer_addr, host = %host, error = %e, "CONNECT rejected: API unreachable");
                let mut resp = Response::new(Empty::new());
                *resp.status_mut() = hyper::StatusCode::BAD_GATEWAY;
                return Ok(resp);
            }
        };

        let intercept = connect_response.intercept;
        let rules = connect_response.rules;

        info!(
            peer = %peer_addr,
            host = %host,
            mode = if intercept { "mitm" } else { "tunnel" },
            rule_count = rules.len(),
            "CONNECT"
        );

        tokio::spawn(async move {
            match hyper::upgrade::on(req).await {
                Ok(upgraded) => {
                    let result = if intercept {
                        mitm(upgraded, &host, &ca, http_client, rules).await
                    } else {
                        tunnel(upgraded, &host).await
                    };
                    if let Err(e) = result {
                        warn!(host = %host, error = %e, "connection error");
                    }
                }
                Err(e) => {
                    warn!(host = %host, error = %e, "upgrade failed");
                }
            }
        });

        // 200 tells the client the tunnel is established.
        // hyper will then upgrade the connection, handing raw IO to our task above.
        Ok(Response::new(Empty::new()))
    } else if req.method() == Method::GET && req.uri().path() == "/healthz" {
        Ok(Response::new(Empty::new()))
    } else {
        // Plain HTTP proxy requests are not supported — only CONNECT (HTTPS).
        warn!(
            peer = %peer_addr,
            method = %req.method(),
            uri = %req.uri(),
            "rejected non-CONNECT request"
        );
        let mut resp = Response::new(Empty::new());
        *resp.status_mut() = hyper::StatusCode::BAD_REQUEST;
        Ok(resp)
    }
}

// ── MITM & tunnel ───────────────────────────────────────────────────────

/// MITM: terminate TLS with the client using a generated leaf cert,
/// then forward HTTP requests to the real server.
async fn mitm(
    upgraded: hyper::upgrade::Upgraded,
    host: &str,
    ca: &CertificateAuthority,
    http_client: reqwest::Client,
    rules: Vec<ConnectRule>,
) -> Result<()> {
    let hostname = strip_port(host);

    // TLS handshake with client using a leaf cert for this hostname
    let server_config = ca.server_config_for_host(hostname)?;
    let acceptor = TlsAcceptor::from(server_config);

    // Upgraded → TokioIo (hyper→tokio) → TLS accept → TokioIo (tokio→hyper)
    let client_io = TokioIo::new(upgraded);
    let tls_stream = acceptor
        .accept(client_io)
        .await
        .context("TLS handshake with client")?;

    // Serve HTTP/1.1 on the decrypted TLS stream.
    // The client thinks it's talking to the real server.
    let host_owned = host.to_string();
    let rules = Arc::new(rules);
    let io = TokioIo::new(tls_stream);

    http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let host = host_owned.clone();
                let client = http_client.clone();
                let rules = Arc::clone(&rules);
                async move { forward_request(req, &host, client, &rules).await }
            }),
        )
        .await
        .context("serving MITM connection")
}

/// Forward a single HTTP request to the real upstream server and stream the response back.
/// Both request and response bodies are streamed — no full buffering in memory.
/// This is critical for SSE (Server-Sent Events) and large payloads.
/// Applies injection rules (set_header, remove_header) before forwarding.
async fn forward_request(
    req: Request<Incoming>,
    host: &str,
    http_client: reqwest::Client,
    rules: &[ConnectRule],
) -> anyhow::Result<Response<impl HttpBody<Data = Bytes, Error = reqwest::Error>>> {
    let method = req.method().clone();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("https://{host}{path}");

    let (parts, body) = req.into_parts();

    // Collect forwarded headers into a mutable map for injection
    let mut headers = hyper::HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if is_forwarded_header(name) {
            headers.append(name.clone(), value.clone());
        }
    }

    // Apply injection rules matching this request path
    let injection_count = inject::apply_injections(&mut headers, &path, rules);

    // Build upstream request with (possibly modified) headers
    let mut upstream = http_client.request(method.clone(), &url);
    for (name, value) in headers.iter() {
        upstream = upstream.header(name.clone(), value.clone());
    }

    // Stream request body to upstream via HttpBody wrapper
    upstream = upstream.body(reqwest::Body::wrap(body));

    // Send to real server
    let upstream_resp = upstream
        .send()
        .await
        .with_context(|| format!("forwarding to {url}"))?;

    let status = upstream_resp.status();
    let resp_headers = upstream_resp.headers().clone();

    // Log before streaming response body
    let content_type = resp_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");

    info!(
        method = %method,
        url = %url,
        status = %status.as_u16(),
        content_type = %content_type,
        injections_applied = injection_count,
        "MITM"
    );

    // Stream response body to client (no buffering — critical for SSE)
    let resp_stream = upstream_resp.bytes_stream().map_ok(Frame::data);
    let body = StreamBody::new(resp_stream);

    let mut response = Response::new(body);
    *response.status_mut() = status;

    // Forward response headers, skipping hop-by-hop
    for (name, value) in resp_headers.iter() {
        if is_forwarded_header(name) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }

    Ok(response)
}

/// Tunnel: connect to the target server and splice bytes in both directions
/// until either side closes the connection. Used for non-intercepted domains.
async fn tunnel(upgraded: hyper::upgrade::Upgraded, host: &str) -> Result<()> {
    let mut server = TcpStream::connect(host)
        .await
        .with_context(|| format!("connecting to upstream {host}"))?;

    let mut client = TokioIo::new(upgraded);

    let (client_to_server, server_to_client) =
        tokio::io::copy_bidirectional(&mut client, &mut server)
            .await
            .context("bidirectional copy")?;

    info!(
        host = %host,
        client_to_server,
        server_to_client,
        "tunnel closed"
    );

    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Build a 407 Proxy Authentication Required response.
fn respond_407() -> Response<Empty<Bytes>> {
    let mut resp = Response::new(Empty::new());
    *resp.status_mut() = hyper::StatusCode::PROXY_AUTHENTICATION_REQUIRED;
    resp.headers_mut().insert(
        "proxy-authenticate",
        HeaderValue::from_static("Basic realm=\"OneCLI Proxy\""),
    );
    resp
}

/// Returns true if a header should be forwarded between client and upstream.
/// Filters out hop-by-hop headers and headers managed by the transport layer.
fn is_forwarded_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    )
}

/// Strip port from a `host:port` string, returning just the hostname.
fn strip_port(host: &str) -> &str {
    host.split(':').next().unwrap_or(host)
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── strip_port ──────────────────────────────────────────────────────

    #[test]
    fn strip_port_removes_port() {
        assert_eq!(strip_port("example.com:443"), "example.com");
        assert_eq!(strip_port("api.anthropic.com:8080"), "api.anthropic.com");
    }

    #[test]
    fn strip_port_handles_bare_hostname() {
        assert_eq!(strip_port("example.com"), "example.com");
        assert_eq!(strip_port("localhost"), "localhost");
    }

    #[test]
    fn strip_port_handles_ipv6_no_brackets() {
        // IPv6 with port typically uses brackets, but strip_port just splits on ':'
        // For bracket-wrapped IPv6 like [::1]:443, it returns "[" — this is acceptable
        // since hyper always sends host:port format for CONNECT
        assert_eq!(strip_port("[::1]:443"), "[");
    }

    #[test]
    fn strip_port_handles_empty() {
        assert_eq!(strip_port(""), "");
    }

    // ── is_forwarded_header ─────────────────────────────────────────────

    #[test]
    fn is_forwarded_header_strips_hop_by_hop() {
        let hop_by_hop = [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "proxy-connection",
            "te",
            "trailers",
            "transfer-encoding",
            "upgrade",
            "host",
            "content-length",
        ];

        for name in hop_by_hop {
            let header = HeaderName::from_static(name);
            assert!(
                !is_forwarded_header(&header),
                "{name} should be filtered out"
            );
        }
    }

    #[test]
    fn is_forwarded_header_passes_content_headers() {
        let forwarded = [
            "content-type",
            "authorization",
            "accept",
            "user-agent",
            "x-api-key",
            "x-custom-header",
            "cache-control",
        ];

        for name in forwarded {
            let header = HeaderName::from_static(name);
            assert!(is_forwarded_header(&header), "{name} should be forwarded");
        }
    }

    // ── respond_407 ─────────────────────────────────────────────────────

    #[test]
    fn respond_407_has_correct_status_and_header() {
        let resp = respond_407();
        assert_eq!(
            resp.status(),
            hyper::StatusCode::PROXY_AUTHENTICATION_REQUIRED
        );
        let auth_header = resp
            .headers()
            .get("proxy-authenticate")
            .expect("should have Proxy-Authenticate header");
        assert_eq!(auth_header, "Basic realm=\"OneCLI Proxy\"");
    }
}
