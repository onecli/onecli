//! Generic fallback summary for providers/endpoints without a dedicated
//! summarizer.
//!
//! Renders a safe, bounded view of an arbitrary request body: redacts
//! secret-named JSON keys, elides base64 blobs, summarizes binary, and hard-caps
//! length so an approval card can never leak a secret or overflow a chat client.

use serde_json::Value;

use super::redact::{looks_like_base64_blob, redact_value};
use super::{
    clamp, humanize_key, json_object, parse_json, ApprovalSummary, SummaryRequest, MAX_BODY_LEN,
};

/// Summarize any request: method + endpoint, plus a redacted, bounded body.
/// A flat JSON object body (every value a scalar) renders as one labeled row
/// per field ("Name: Acme"), readable for any app, instead of a JSON blob.
/// Anything nested, truncated, or non-JSON keeps the redacted `Body` string.
pub(super) fn summarize(req: &SummaryRequest<'_>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(format!("{} request", req.method_upper()));
    s.push("Endpoint", req.base_path());
    if let Some(b) = req.body {
        if push_flat_fields(&mut s, req.content_type, b) {
            return s;
        }
        let rendered = render_body(req.content_type, b);
        if !rendered.is_empty() {
            s.push_clamped("Body", rendered, MAX_BODY_LEN);
        }
    }
    s
}

/// Push one row per field of a flat JSON object body. Returns `false` (and
/// pushes nothing) when the body is not a non-empty object of scalars, so the
/// caller falls back to the redacted blob. Values go through the same
/// redaction as the blob: secret-named keys become `***`, blobs are elided.
fn push_flat_fields(s: &mut ApprovalSummary, content_type: Option<&str>, body: &[u8]) -> bool {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    if !(ct.contains("json") || looks_like_json(body)) {
        return false;
    }
    let Some(obj) = json_object(body) else {
        return false;
    };
    let flat = !obj.is_empty()
        && obj
            .values()
            .all(|v| !matches!(v, Value::Object(_) | Value::Array(_)));
    if !flat {
        return false;
    }
    s.push_fields(&obj, |s, key, value| {
        let shown = match redact_value(Some(key), value) {
            Value::String(v) => v,
            Value::Null => "(empty)".to_string(),
            other => other.to_string(),
        };
        s.push(humanize_key(key), shown);
    });
    true
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
        // Nested, so it stays one redacted Body blob.
        let big = "A".repeat(4000);
        let body = format!(
            "{{\"image\":\"{big}\",\"name\":\"foo\",\"api_key\":\"sk-123\",\"meta\":{{}}}}"
        );
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

    #[test]
    fn flat_json_becomes_labeled_rows_with_redaction() {
        let big = "B".repeat(400);
        let body = format!(
            r#"{{"first_name":"Ada","lastName":"Lovelace","is_active":true,"count":3,"note":null,"api_key":"sk-live-1","avatar":"{big}"}}"#
        );
        let s = generic(
            "POST",
            "/v1/people",
            Some("application/json"),
            Some(body.as_bytes()),
        );
        assert_eq!(detail(&s, "First name"), Some("Ada"));
        assert_eq!(detail(&s, "Last name"), Some("Lovelace"));
        assert_eq!(detail(&s, "Is active"), Some("true"));
        assert_eq!(detail(&s, "Count"), Some("3"));
        assert_eq!(detail(&s, "Note"), Some("(empty)"));
        assert_eq!(detail(&s, "Api key"), Some("***"));
        assert!(detail(&s, "Avatar").unwrap().contains("base64"));
        assert_eq!(detail(&s, "Body"), None);
    }

    #[test]
    fn flat_json_rows_are_capped() {
        let fields: Vec<String> = (0..15).map(|i| format!("\"k{i}\":{i}")).collect();
        let body = format!("{{{}}}", fields.join(","));
        let s = generic(
            "POST",
            "/v1/x",
            Some("application/json"),
            Some(body.as_bytes()),
        );
        // Endpoint + 12 rows + "More".
        assert_eq!(s.details.len(), 14);
        assert_eq!(detail(&s, "More"), Some("+3 more fields"));
    }

    #[test]
    fn truncated_or_nested_json_keeps_the_body_blob() {
        for body in [r#"{"a":1,"b":"#, r#"{"a":[1,2]}"#, r#"[{"a":1}]"#, "{}"] {
            let s = generic(
                "POST",
                "/v1/x",
                Some("application/json"),
                Some(body.as_bytes()),
            );
            assert!(
                s.details
                    .iter()
                    .all(|d| d.label == "Endpoint" || d.label == "Body"),
                "{body}: {:?}",
                s.details
            );
        }
    }
}
