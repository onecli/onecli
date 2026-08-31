//! Generic fallback summary for providers/endpoints without a dedicated
//! summarizer.
//!
//! Renders a safe, bounded view of an arbitrary request body: redacts
//! secret-named JSON keys, elides base64 blobs, summarizes binary, and hard-caps
//! length so an approval card can never leak a secret or overflow a chat client.

use serde_json::Value;

use super::{clamp, parse_json, ApprovalSummary, SummaryRequest, MAX_BODY_LEN};

/// Summarize any request: method + endpoint, plus a redacted, bounded body.
pub(super) fn summarize(req: &SummaryRequest<'_>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(format!("{} request", req.method_upper()));
    s.push("Endpoint", req.base_path());
    if let Some(b) = req.body {
        let rendered = render_body(req.content_type, b);
        if !rendered.is_empty() {
            s.push_clamped("Body", rendered, MAX_BODY_LEN);
        }
    }
    s
}

/// Render an arbitrary body to a safe, bounded string: redact JSON (secret-named
/// keys → `***`, long/base64 strings → elided), summarize binary, or redact long
/// base64 runs in plain text.
fn render_body(content_type: Option<&str>, body: &[u8]) -> String {
    if body.is_empty() {
        return String::new();
    }
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    if ct.contains("json") || looks_like_json(body) {
        if let Some(v) = parse_json(body) {
            let redacted = redact_value(None, &v);
            return clamp(
                &serde_json::to_string(&redacted).unwrap_or_default(),
                MAX_BODY_LEN,
            );
        }
        // Truncated/invalid JSON — fall through to text redaction of the prefix.
    }
    if is_mostly_binary(body) {
        return format!("<binary, {}+ bytes>", body.len());
    }
    redact_text(&String::from_utf8_lossy(body))
}

fn redact_value(key: Option<&str>, v: &Value) -> Value {
    if key.is_some_and(is_sensitive_key) {
        return Value::String("***".into());
    }
    match v {
        Value::String(s) => Value::String(redact_string(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| redact_value(None, x)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), redact_value(Some(k), x)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn redact_string(s: &str) -> String {
    let n = s.chars().count();
    if looks_like_base64_blob(s) {
        return format!("<{n} chars, base64>");
    }
    if n > 96 {
        return format!("<{n} chars>");
    }
    s.to_string()
}

fn redact_text(s: &str) -> String {
    let mut out = String::new();
    for (i, token) in s.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if looks_like_base64_blob(token) {
            out.push_str(&format!("<{} chars, base64>", token.len()));
        } else {
            out.push_str(token);
        }
        if out.len() > MAX_BODY_LEN {
            break;
        }
    }
    clamp(&out, MAX_BODY_LEN)
}

// ── Heuristics ───────────────────────────────────────────────────────────────

fn is_sensitive_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    [
        "authorization",
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_key",
        "accesskey",
        "private_key",
        "client_secret",
        "refresh_token",
    ]
    .iter()
    .any(|p| k.contains(p))
}

fn looks_like_base64_blob(s: &str) -> bool {
    let n = s.len();
    if n < 100 {
        return false;
    }
    let b64 = s
        .bytes()
        .filter(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
        .count();
    b64 as f64 >= 0.97 * n as f64
}

fn is_mostly_binary(b: &[u8]) -> bool {
    if b.is_empty() {
        return false;
    }
    let sample = &b[..b.len().min(512)];
    let nonprint = sample
        .iter()
        .filter(|&&c| c < 0x09 || (0x0d < c && c < 0x20))
        .count();
    nonprint as f64 > 0.10 * sample.len() as f64
}

fn looks_like_json(b: &[u8]) -> bool {
    matches!(
        b.iter().find(|c| !c.is_ascii_whitespace()),
        Some(b'{') | Some(b'[')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generic(method: &str, path: &str, ct: Option<&str>, body: Option<&[u8]>) -> ApprovalSummary {
        summarize(&SummaryRequest {
            method,
            path,
            content_type: ct,
            body,
        })
    }

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    #[test]
    fn json_redacts_base64_and_secrets_and_bounds() {
        let big = "A".repeat(4000);
        let body = format!("{{\"image\":\"{big}\",\"name\":\"foo\",\"api_key\":\"sk-123\"}}");
        let s = generic(
            "POST",
            "/v1/things",
            Some("application/json"),
            Some(body.as_bytes()),
        );
        assert_eq!(s.action, "POST request");
        let rendered = detail(&s, "Body").unwrap();
        assert!(rendered.contains("foo"));
        assert!(
            rendered.contains("base64"),
            "big blob should be elided: {rendered}"
        );
        assert!(!rendered.contains(&big));
        assert!(
            rendered.contains("***"),
            "secret key should be redacted: {rendered}"
        );
        assert!(rendered.chars().count() <= MAX_BODY_LEN);
    }

    #[test]
    fn binary_body_is_summarized_not_dumped() {
        let body = vec![0u8; 5000];
        let s = generic(
            "POST",
            "/v1/upload",
            Some("application/octet-stream"),
            Some(&body),
        );
        assert!(detail(&s, "Body").unwrap().contains("binary"));
    }

    #[test]
    fn endpoint_drops_query_string() {
        let s = generic("DELETE", "/v1/resource/42?token=abc", None, None);
        assert_eq!(detail(&s, "Endpoint"), Some("/v1/resource/42"));
    }
}
