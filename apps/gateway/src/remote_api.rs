//! HTTP endpoints for managing remote access pairing on the gateway.
//!
//! These endpoints are protected by the gateway secret and called by the web API
//! to initiate pairing, check status, and disconnect.

use std::sync::Arc;

use bw_rat_client::{IdentityFingerprint, Psk};
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use crate::remote::RemoteAccessManager;

// ── Request types ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PskPairRequest {
    psk_hex: String,
    fingerprint_hex: String,
}

#[derive(Deserialize)]
struct RendezvousPairRequest {
    code: String,
}

// ── Handler ─────────────────────────────────────────────────────────────

/// Route a non-CONNECT request to the appropriate remote access endpoint.
/// Returns `None` if the path doesn't match `/api/remote/*`.
pub(crate) async fn handle_remote_api<T>(
    req: &Request<T>,
    body_bytes: &[u8],
    manager: &Arc<RemoteAccessManager>,
    gateway_secret: Option<&str>,
) -> Option<Response<Full<Bytes>>> {
    let path = req.uri().path();
    if !path.starts_with("/api/remote/") {
        return None;
    }

    // Validate gateway secret
    if !validate_secret(req, gateway_secret) {
        return Some(json_response(
            StatusCode::FORBIDDEN,
            r#"{"error":"invalid gateway secret"}"#,
        ));
    }

    let method = req.method().as_str();
    match (method, path) {
        ("POST", "/api/remote/pair/psk") => Some(handle_pair_psk(body_bytes, manager).await),
        ("POST", "/api/remote/pair/rendezvous") => {
            Some(handle_pair_rendezvous(body_bytes, manager).await)
        }
        ("GET", "/api/remote/status") => Some(handle_status(manager).await),
        ("DELETE", "/api/remote/pair") => Some(handle_disconnect(manager).await),
        _ => Some(json_response(
            StatusCode::NOT_FOUND,
            r#"{"error":"not found"}"#,
        )),
    }
}

// ── Endpoint handlers ───────────────────────────────────────────────────

async fn handle_pair_psk(body: &[u8], manager: &Arc<RemoteAccessManager>) -> Response<Full<Bytes>> {
    let req: PskPairRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return error_response(StatusCode::BAD_REQUEST, format!("invalid request body: {e}"));
        }
    };

    let psk = match Psk::from_hex(&req.psk_hex) {
        Ok(p) => p,
        Err(e) => {
            return error_response(StatusCode::BAD_REQUEST, format!("invalid PSK hex: {e}"));
        }
    };

    let fp_bytes = match hex::decode(&req.fingerprint_hex) {
        Ok(b) if b.len() == 32 => {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&b);
            IdentityFingerprint(arr)
        }
        Ok(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "fingerprint must be 32 bytes (64 hex chars)".into(),
            );
        }
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                format!("invalid fingerprint hex: {e}"),
            );
        }
    };

    match manager.pair_with_psk(psk, fp_bytes).await {
        Ok(()) => json_response(StatusCode::OK, r#"{"status":"paired"}"#),
        Err(e) => {
            warn!(error = %e, "PSK pairing failed");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, format!("pairing failed: {e}"))
        }
    }
}

async fn handle_pair_rendezvous(
    body: &[u8],
    manager: &Arc<RemoteAccessManager>,
) -> Response<Full<Bytes>> {
    let req: RendezvousPairRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return error_response(StatusCode::BAD_REQUEST, format!("invalid request body: {e}"));
        }
    };

    match manager.pair_with_rendezvous(&req.code).await {
        Ok(fingerprint) => {
            let fp_hex = hex::encode(fingerprint.0);
            let body = json!({"status": "paired", "fingerprint": fp_hex}).to_string();
            json_response(StatusCode::OK, &body)
        }
        Err(e) => {
            warn!(error = %e, "rendezvous pairing failed");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, format!("pairing failed: {e}"))
        }
    }
}

async fn handle_status(manager: &Arc<RemoteAccessManager>) -> Response<Full<Bytes>> {
    let status = manager.status().await;
    let json =
        serde_json::to_string(&status).unwrap_or_else(|_| r#"{"error":"serialize"}"#.to_string());
    json_response(StatusCode::OK, &json)
}

async fn handle_disconnect(manager: &Arc<RemoteAccessManager>) -> Response<Full<Bytes>> {
    match manager.disconnect().await {
        Ok(()) => json_response(StatusCode::OK, r#"{"status":"disconnected"}"#),
        Err(e) => {
            warn!(error = %e, "disconnect failed");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("disconnect failed: {e}"),
            )
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn validate_secret<T>(req: &Request<T>, gateway_secret: Option<&str>) -> bool {
    let Some(expected) = gateway_secret else {
        // No secret configured — allow (OSS without secret)
        return true;
    };
    req.headers()
        .get("x-gateway-secret")
        .and_then(|v| v.to_str().ok())
        == Some(expected)
}

fn error_response(status: StatusCode, message: String) -> Response<Full<Bytes>> {
    let body = json!({"error": message}).to_string();
    json_response(status, &body)
}

fn json_response(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::from(body.to_string())));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        "content-type",
        hyper::header::HeaderValue::from_static("application/json"),
    );
    resp
}
