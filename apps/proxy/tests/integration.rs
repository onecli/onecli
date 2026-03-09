//! Integration tests for the onecli-proxy.
//!
//! These tests start a real proxy on a random port and make actual TCP connections
//! to verify CONNECT handling, health checks, and request rejection.
//! A mock API server provides policy resolution for the proxy.

use base64::Engine;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Encode an agent token as a Basic auth header value: `Basic base64({token}:)`.
fn basic_auth(token: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{token}:"));
    format!("Basic {encoded}")
}

/// Test agent token used across integration tests.
const TEST_AGENT_TOKEN: &str = "oat_test_token_123";

/// Start a mock API server that responds to `POST /api/proxy/connect`.
/// Returns `{ "intercept": false }` for all requests (tunnel mode).
/// Returns the port and a join handle.
fn start_mock_api(response_body: &str) -> (u16, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock API");
    let port = listener.local_addr().expect("local addr").port();
    let body = response_body.to_string();

    let handle = std::thread::spawn(move || {
        // Accept connections in a loop until the listener is dropped
        listener.set_nonblocking(false).expect("set blocking");
        while let Ok((mut conn, _)) = listener.accept() {
            conn.set_read_timeout(Some(Duration::from_secs(2))).ok();

            // Read the HTTP request (drain headers + body)
            let mut buf = [0u8; 4096];
            let _ = conn.read(&mut buf);

            // Send response
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = conn.write_all(resp.as_bytes());
            let _ = conn.flush();
        }
    });

    (port, handle)
}

/// Start the proxy binary on a random available port, returning the port and child process.
/// Uses a temp dir for CA storage so tests don't interfere with each other.
/// `api_url` controls where the proxy calls for policy resolution.
fn start_proxy(tmp_dir: &Path, api_url: Option<&str>) -> (u16, std::process::Child) {
    start_proxy_with_envs(tmp_dir, api_url, &[])
}

/// Like `start_proxy` but allows setting extra environment variables on the proxy process.
fn start_proxy_with_envs(
    tmp_dir: &Path,
    api_url: Option<&str>,
    envs: &[(&str, &str)],
) -> (u16, std::process::Child) {
    // Find an available port
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);

    let bin = env!("CARGO_BIN_EXE_onecli-proxy");

    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--port")
        .arg(port.to_string())
        .arg("--data-dir")
        .arg(tmp_dir.to_str().expect("valid utf8 path"));

    if let Some(url) = api_url {
        cmd.arg("--api-url").arg(url);
    }

    for (key, val) in envs {
        cmd.env(key, val);
    }

    let child = cmd
        .env("RUST_LOG", "warn")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("start proxy process");

    // Wait for proxy to be ready (poll health check)
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if std::time::Instant::now() > deadline {
            panic!("proxy failed to start within 5 seconds");
        }
        if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")) {
            let req = format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 256];
                stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                if let Ok(n) = stream.read(&mut buf) {
                    let resp = String::from_utf8_lossy(&buf[..n]);
                    if resp.contains("200") {
                        break;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    (port, child)
}

#[test]
fn health_check_returns_200() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let (port, mut child) = start_proxy(tmp.path(), None);

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to proxy");
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let req = format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    stream.write_all(req.as_bytes()).expect("send request");

    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).expect("read response");
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(resp.contains("HTTP/1.1 200"), "expected 200, got: {resp}");

    child.kill().ok();
    child.wait().ok();
}

#[test]
fn non_connect_request_returns_400() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let (port, mut child) = start_proxy(tmp.path(), None);

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to proxy");
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let req = format!("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    stream.write_all(req.as_bytes()).expect("send request");

    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).expect("read response");
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(resp.contains("HTTP/1.1 400"), "expected 400, got: {resp}");

    child.kill().ok();
    child.wait().ok();
}

#[test]
fn connect_without_auth_returns_407() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let (port, mut child) = start_proxy(tmp.path(), None);

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to proxy");
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    // CONNECT without Proxy-Authorization
    let req = "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n";
    stream.write_all(req.as_bytes()).expect("send CONNECT");

    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).expect("read response");
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(
        resp.contains("407"),
        "expected 407 Proxy Authentication Required, got: {resp}"
    );
    assert!(
        resp.contains("Proxy-Authenticate"),
        "expected Proxy-Authenticate header, got: {resp}"
    );

    child.kill().ok();
    child.wait().ok();
}

#[test]
fn connect_without_api_returns_502() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    // Point proxy at a non-existent API server
    let (port, mut child) = start_proxy(tmp.path(), Some("http://127.0.0.1:1"));

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to proxy");
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    let auth = basic_auth(TEST_AGENT_TOKEN);
    let req = format!(
        "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: {auth}\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).expect("send CONNECT");

    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).expect("read response");
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(
        resp.contains("502"),
        "expected 502 Bad Gateway when API is unreachable, got: {resp}"
    );

    child.kill().ok();
    child.wait().ok();
}

#[test]
fn connect_with_tunnel_api_returns_200() {
    // Mock API that returns "intercept: false" (tunnel mode)
    let (api_port, _api_handle) = start_mock_api(r#"{ "intercept": false }"#);

    let tmp = tempfile::tempdir().expect("create temp dir");
    let api_url = format!("http://127.0.0.1:{api_port}");
    let (port, mut child) = start_proxy(tmp.path(), Some(&api_url));

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to proxy");
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let auth = basic_auth(TEST_AGENT_TOKEN);
    let req = format!(
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: {auth}\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).expect("send CONNECT");

    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).expect("read response");
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(
        resp.contains("200"),
        "expected 200 for CONNECT tunnel, got: {resp}"
    );

    child.kill().ok();
    child.wait().ok();
}

#[test]
fn ca_persists_across_restarts() {
    let tmp = tempfile::tempdir().expect("create temp dir");

    // First start — generates CA
    let (_, mut child1) = start_proxy(tmp.path(), None);
    child1.kill().ok();
    child1.wait().ok();

    // Verify CA files exist
    let ca_key = tmp.path().join("proxy").join("ca.key");
    let ca_cert = tmp.path().join("proxy").join("ca.pem");
    assert!(ca_key.exists(), "ca.key should exist after first run");
    assert!(ca_cert.exists(), "ca.pem should exist after first run");

    let cert_content_1 = std::fs::read_to_string(&ca_cert).expect("read ca.pem");

    // Second start — should load existing CA
    let (_, mut child2) = start_proxy(tmp.path(), None);
    child2.kill().ok();
    child2.wait().ok();

    let cert_content_2 = std::fs::read_to_string(&ca_cert).expect("read ca.pem again");

    // Same CA cert across restarts
    assert_eq!(cert_content_1, cert_content_2, "CA cert should persist");
}

#[test]
fn sse_streaming_passes_through_tunnel() {
    // Start a local SSE server that sends 3 events with 100ms gaps
    let sse_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind SSE server");
    let sse_port = sse_listener.local_addr().expect("local addr").port();

    let sse_handle = std::thread::spawn(move || {
        let (mut conn, _) = sse_listener.accept().expect("accept SSE client");
        conn.set_read_timeout(Some(Duration::from_secs(2))).ok();

        // Read the HTTP request (drain it)
        let mut buf = [0u8; 1024];
        let _ = conn.read(&mut buf);

        // Send chunked SSE response
        let header = "HTTP/1.1 200 OK\r\n\
                       Content-Type: text/event-stream\r\n\
                       Transfer-Encoding: chunked\r\n\
                       Cache-Control: no-cache\r\n\r\n";
        conn.write_all(header.as_bytes()).expect("send header");
        conn.flush().expect("flush header");

        // Send 3 SSE events with delays between them
        for i in 1..=3 {
            let event = format!("data: event {i}\n\n");
            let chunk = format!("{:x}\r\n{}\r\n", event.len(), event);
            conn.write_all(chunk.as_bytes()).expect("send chunk");
            conn.flush().expect("flush chunk");
            std::thread::sleep(Duration::from_millis(100));
        }

        // Terminating chunk
        conn.write_all(b"0\r\n\r\n").expect("send final chunk");
        conn.flush().expect("flush final");
    });

    // Mock API — tunnel mode for localhost
    let (api_port, _api_handle) = start_mock_api(r#"{ "intercept": false }"#);

    // Start proxy pointing at mock API
    let tmp = tempfile::tempdir().expect("create temp dir");
    let api_url = format!("http://127.0.0.1:{api_port}");
    let (proxy_port, mut child) = start_proxy(tmp.path(), Some(&api_url));

    // CONNECT to our SSE server through the proxy (tunnel mode)
    let mut stream =
        TcpStream::connect(format!("127.0.0.1:{proxy_port}")).expect("connect to proxy");
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_nodelay(true).expect("set nodelay");

    let auth = basic_auth(TEST_AGENT_TOKEN);
    let connect_req = format!(
        "CONNECT 127.0.0.1:{sse_port} HTTP/1.1\r\nHost: 127.0.0.1:{sse_port}\r\nProxy-Authorization: {auth}\r\n\r\n"
    );
    stream
        .write_all(connect_req.as_bytes())
        .expect("send CONNECT");

    // Read the 200 response
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).expect("read CONNECT response");
    let resp = String::from_utf8_lossy(&buf[..n]);
    assert!(resp.contains("200"), "expected 200, got: {resp}");

    // Now the tunnel is open — send an HTTP GET to the SSE server
    let get_req = format!(
        "GET /events HTTP/1.1\r\nHost: 127.0.0.1:{sse_port}\r\nAccept: text/event-stream\r\n\r\n"
    );
    stream.write_all(get_req.as_bytes()).expect("send GET");

    // Read streaming response — collect all data
    let start = Instant::now();
    let mut all_data = Vec::new();
    let mut read_buf = [0u8; 4096];

    loop {
        match stream.read(&mut read_buf) {
            Ok(0) => break,
            Ok(n) => {
                all_data.extend_from_slice(&read_buf[..n]);
                // Stop once we've seen all 3 events
                let text = String::from_utf8_lossy(&all_data);
                if text.contains("event 3") {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if start.elapsed() > Duration::from_secs(5) {
                    panic!("timeout waiting for SSE events");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => panic!("read error: {e}"),
        }
    }

    let response_text = String::from_utf8_lossy(&all_data);
    let elapsed = start.elapsed();

    // Verify all 3 events arrived
    assert!(
        response_text.contains("data: event 1"),
        "missing event 1 in: {response_text}"
    );
    assert!(
        response_text.contains("data: event 2"),
        "missing event 2 in: {response_text}"
    );
    assert!(
        response_text.contains("data: event 3"),
        "missing event 3 in: {response_text}"
    );

    // Verify streaming behavior: the 3 events had 100ms gaps, so total should be >= 200ms.
    // If buffered, they'd all arrive at once near the end.
    assert!(
        elapsed >= Duration::from_millis(150),
        "response arrived too fast ({elapsed:?}) — likely buffered instead of streamed"
    );

    sse_handle.join().expect("SSE server thread");
    child.kill().ok();
    child.wait().ok();
}

#[test]
fn connect_with_intercept_injects_headers() {
    // ── 1. Start a TLS mock upstream that echoes received headers ──
    let upstream_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind upstream");
    let upstream_port = upstream_listener.local_addr().expect("addr").port();

    let upstream_handle = std::thread::spawn(move || {
        // Generate a self-signed cert for "localhost"
        let cert_key = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("generate upstream cert");
        let cert_der = cert_key.cert.der().clone();
        let key_der = cert_key.key_pair.serialize_der();

        let certs = vec![cert_der];
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(key_der),
        );

        let server_config = Arc::new(
            rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .expect("upstream server config"),
        );

        let (tcp, _) = upstream_listener.accept().expect("accept upstream conn");
        tcp.set_read_timeout(Some(Duration::from_secs(5))).ok();

        let server_conn = rustls::ServerConnection::new(server_config).expect("server conn");
        let mut tls = rustls::StreamOwned::new(server_conn, tcp);

        // Read the forwarded HTTP request
        let mut buf = [0u8; 4096];
        let n = tls.read(&mut buf).expect("read upstream request");
        let request = String::from_utf8_lossy(&buf[..n]).to_string();

        // Echo the request back as the response body so the test can inspect headers
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            request.len(),
            request
        );
        tls.write_all(resp.as_bytes())
            .expect("write upstream response");
        tls.flush().expect("flush upstream");

        request
    });

    // ── 2. Mock API — returns intercept=true with injection rules ──
    let api_body = r#"{"intercept":true,"rules":[{"path_pattern":"*","injections":[{"action":"set_header","name":"x-api-key","value":"sk-ant-test-key"},{"action":"remove_header","name":"x-remove-me"}]}]}"#;
    let (api_port, _api_handle) = start_mock_api(api_body);

    // ── 3. Start proxy with invalid-cert acceptance (for self-signed upstream) ──
    let tmp = tempfile::tempdir().expect("create temp dir");
    let api_url = format!("http://127.0.0.1:{api_port}");
    let (proxy_port, mut child) = start_proxy_with_envs(
        tmp.path(),
        Some(&api_url),
        &[("PROXY_DANGER_ACCEPT_INVALID_CERTS", "1")],
    );

    // ── 4. CONNECT to upstream through the proxy ──
    let mut stream =
        TcpStream::connect(format!("127.0.0.1:{proxy_port}")).expect("connect to proxy");
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_nodelay(true).expect("set nodelay");

    let auth = basic_auth(TEST_AGENT_TOKEN);
    let connect_req = format!(
        "CONNECT localhost:{upstream_port} HTTP/1.1\r\nHost: localhost:{upstream_port}\r\nProxy-Authorization: {auth}\r\n\r\n"
    );
    stream
        .write_all(connect_req.as_bytes())
        .expect("send CONNECT");

    // Read the CONNECT response
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).expect("read CONNECT response");
    let resp = String::from_utf8_lossy(&buf[..n]);
    assert!(
        resp.contains("200"),
        "expected 200 for CONNECT, got: {resp}"
    );

    // ── 5. TLS handshake with the proxy (MITM), trusting the proxy CA ──
    let ca_pem_path = tmp.path().join("proxy").join("ca.pem");
    let ca_pem = std::fs::read(&ca_pem_path).expect("read proxy CA cert");

    let mut root_store = rustls::RootCertStore::empty();
    let certs: Vec<_> = rustls_pemfile::certs(&mut &ca_pem[..])
        .collect::<Result<Vec<_>, _>>()
        .expect("parse CA PEM");
    for cert in certs {
        root_store.add(cert).expect("add CA to root store");
    }

    let client_config = Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .with_root_certificates(root_store)
        .with_no_client_auth(),
    );

    let server_name =
        rustls::pki_types::ServerName::try_from("localhost").expect("valid server name");
    let client_conn =
        rustls::ClientConnection::new(client_config, server_name).expect("client conn");
    let mut tls = rustls::StreamOwned::new(client_conn, stream);

    // ── 6. Send an HTTP request through the MITM tunnel ──
    let http_req = format!(
        "GET /v1/messages HTTP/1.1\r\nHost: localhost:{upstream_port}\r\nAccept: application/json\r\nX-Remove-Me: should-be-gone\r\n\r\n"
    );
    tls.write_all(http_req.as_bytes())
        .expect("send HTTP request");
    tls.flush().expect("flush TLS");

    // ── 7. Read the response (which echoes the upstream-received headers) ──
    let mut response_buf = vec![0u8; 8192];
    let n = tls.read(&mut response_buf).expect("read response");
    let response = String::from_utf8_lossy(&response_buf[..n]).to_string();

    // The upstream echoed the full HTTP request it received.
    // The response body contains the request line + headers as the proxy forwarded them.

    // Verify: injected header is present
    assert!(
        response.contains("x-api-key: sk-ant-test-key")
            || response.contains("X-Api-Key: sk-ant-test-key")
            || response.contains("x-api-key:sk-ant-test-key"),
        "expected x-api-key header to be injected, response:\n{response}"
    );

    // Verify: removed header is absent
    let response_lower = response.to_lowercase();
    assert!(
        !response_lower.contains("x-remove-me"),
        "expected x-remove-me header to be removed, response:\n{response}"
    );

    // Verify: original accept header is still present
    assert!(
        response_lower.contains("accept: application/json")
            || response_lower.contains("accept:application/json"),
        "expected accept header to survive, response:\n{response}"
    );

    upstream_handle.join().expect("upstream thread");
    child.kill().ok();
    child.wait().ok();
}
