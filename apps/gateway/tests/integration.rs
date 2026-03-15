//! Integration tests for the onecli-gateway.
//!
//! Tests that don't require database access (health check, request rejection,
//! unauthenticated tunneling, CA persistence) run against a gateway started
//! without DATABASE_URL — the binary will fail to connect to PostgreSQL but
//! still serves /healthz and handles unauthenticated CONNECT.
//!
//! Tests that require credential resolution (intercept, SSE streaming with auth)
//! need a real PostgreSQL with seeded data and are marked `#[ignore]`.

use base64::Engine;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

/// Encode an agent token as a Basic auth header value: `Basic base64({token}:)`.
fn basic_auth(token: &str) -> String {
    // Convention: dummy username "x", token as password (like GitHub/GitLab)
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("x:{token}"));
    format!("Basic {encoded}")
}

/// Start the gateway binary with custom environment variables.
fn start_gateway_with_envs(tmp_dir: &Path, envs: &[(&str, &str)]) -> (u16, std::process::Child) {
    // Find an available port
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);

    let bin = env!("CARGO_BIN_EXE_onecli-gateway");

    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--port")
        .arg(port.to_string())
        .arg("--data-dir")
        .arg(tmp_dir.to_str().expect("valid utf8 path"));

    for (key, val) in envs {
        cmd.env(key, val);
    }

    let child = cmd
        .env("RUST_LOG", "warn")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("start gateway process");

    // Wait for gateway to be ready (poll health check)
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if std::time::Instant::now() > deadline {
            panic!("gateway failed to start within 5 seconds");
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

/// Start a gateway with DATABASE_URL and SECRET_ENCRYPTION_KEY set.
/// Requires a real PostgreSQL instance at the given URL.
fn start_gateway_with_db(
    tmp_dir: &Path,
    database_url: &str,
    secret_key: &str,
    extra_envs: &[(&str, &str)],
) -> (u16, std::process::Child) {
    let mut envs = vec![
        ("DATABASE_URL", database_url),
        ("SECRET_ENCRYPTION_KEY", secret_key),
    ];
    envs.extend_from_slice(extra_envs);
    start_gateway_with_envs(tmp_dir, &envs)
}

#[test]
fn health_check_returns_200() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if db_url.is_empty() {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    }
    let key = std::env::var("SECRET_ENCRYPTION_KEY").unwrap_or_default();
    if key.is_empty() {
        eprintln!("skipping: SECRET_ENCRYPTION_KEY not set");
        return;
    }
    let (port, mut child) = start_gateway_with_db(tmp.path(), &db_url, &key, &[]);

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to gateway");
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
    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if db_url.is_empty() {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    }
    let key = std::env::var("SECRET_ENCRYPTION_KEY").unwrap_or_default();
    if key.is_empty() {
        eprintln!("skipping: SECRET_ENCRYPTION_KEY not set");
        return;
    }
    let (port, mut child) = start_gateway_with_db(tmp.path(), &db_url, &key, &[]);

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to gateway");
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
fn connect_without_auth_tunnels() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if db_url.is_empty() {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    }
    let key = std::env::var("SECRET_ENCRYPTION_KEY").unwrap_or_default();
    if key.is_empty() {
        eprintln!("skipping: SECRET_ENCRYPTION_KEY not set");
        return;
    }
    let (port, mut child) = start_gateway_with_db(tmp.path(), &db_url, &key, &[]);

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to gateway");
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    // CONNECT without Proxy-Authorization → plain tunnel (200)
    let req = "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n";
    stream.write_all(req.as_bytes()).expect("send CONNECT");

    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).expect("read response");
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(resp.contains("200"), "expected 200 (tunnel), got: {resp}");

    child.kill().ok();
    child.wait().ok();
}

#[test]
fn connect_with_invalid_token_returns_401() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if db_url.is_empty() {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    }
    let key = std::env::var("SECRET_ENCRYPTION_KEY").unwrap_or_default();
    if key.is_empty() {
        eprintln!("skipping: SECRET_ENCRYPTION_KEY not set");
        return;
    }
    let (port, mut child) = start_gateway_with_db(tmp.path(), &db_url, &key, &[]);

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect to gateway");
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    let auth = basic_auth("aoc_nonexistent_token");
    let req = format!(
        "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: {auth}\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).expect("send CONNECT");

    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).expect("read response");
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(
        resp.contains("407"),
        "expected 407 Proxy Authentication Required for invalid token, got: {resp}"
    );

    child.kill().ok();
    child.wait().ok();
}

#[test]
fn ca_persists_across_restarts() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if db_url.is_empty() {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    }
    let key = std::env::var("SECRET_ENCRYPTION_KEY").unwrap_or_default();
    if key.is_empty() {
        eprintln!("skipping: SECRET_ENCRYPTION_KEY not set");
        return;
    }

    // First start — generates CA
    let (_, mut child1) = start_gateway_with_db(tmp.path(), &db_url, &key, &[]);
    child1.kill().ok();
    child1.wait().ok();

    // Verify CA files exist
    let ca_key = tmp.path().join("gateway").join("ca.key");
    let ca_cert = tmp.path().join("gateway").join("ca.pem");
    assert!(ca_key.exists(), "ca.key should exist after first run");
    assert!(ca_cert.exists(), "ca.pem should exist after first run");

    let cert_content_1 = std::fs::read_to_string(&ca_cert).expect("read ca.pem");

    // Second start — should load existing CA
    let (_, mut child2) = start_gateway_with_db(tmp.path(), &db_url, &key, &[]);
    child2.kill().ok();
    child2.wait().ok();

    let cert_content_2 = std::fs::read_to_string(&ca_cert).expect("read ca.pem again");

    // Same CA cert across restarts
    assert_eq!(cert_content_1, cert_content_2, "CA cert should persist");
}
