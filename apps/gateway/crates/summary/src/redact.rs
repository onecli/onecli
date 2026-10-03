//! What counts as a secret on an approval card, and how it is hidden. Both
//! approval surfaces mask by this one key list, so they can never disagree:
//!
//! - the readable card redacts parsed values ([`redact_value`]): secret-named
//!   keys become `***`, base64 blobs and long strings are elided;
//! - the raw request view masks the body text as sent ([`mask_secrets`]),
//!   which may be cut mid-value by the gateway's peek, so it scans text
//!   instead of parsing.

use serde_json::Value;

/// Whether a JSON / form key names a secret (`password`, `client_secret`,
/// `api_key`, …).
pub(crate) fn is_sensitive_key(k: &str) -> bool {
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

/// A parsed value as the card may show it: a secret-named key's value is
/// `***` (whatever its shape), strings are elided by [`redact_string`].
pub(crate) fn redact_value(key: Option<&str>, v: &Value) -> Value {
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

/// A string value as the card may show it: a base64 blob or a long string is
/// replaced by its size.
pub(crate) fn redact_string(s: &str) -> String {
    let n = s.chars().count();
    if looks_like_base64_blob(s) {
        return format!("<{n} chars, base64>");
    }
    if n > 96 {
        return format!("<{n} chars>");
    }
    s.to_string()
}

pub(crate) fn looks_like_base64_blob(s: &str) -> bool {
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

/// Mask the values of secret-named fields in a request body's text, so the
/// rest reads exactly as sent. Returns the text and whether anything was
/// masked. A value cut off by truncation is masked through the end.
///
/// - JSON: a string value keeps its quotes (`"password": "***"`); a number,
///   literal, object or array becomes `"***"` whole.
/// - Form style (`a=b&c=d`): `password=***`, through the next `&`.
#[must_use]
pub fn mask_secrets(text: &str) -> (String, bool) {
    let (text, json_hit) = mask_json_values(text);
    let (text, form_hit) = mask_form_values(&text);
    (text, json_hit || form_hit)
}

fn mask_json_values(text: &str) -> (String, bool) {
    // Byte-level on purpose: every index below is only ever used to copy
    // bytes, never to slice a `str`, so no input (truncated, odd escapes,
    // multi-byte chars) can panic, and the scan never stops early.
    let b = text.as_bytes();
    let n = b.len();
    let mut out: Vec<u8> = Vec::with_capacity(n);
    let mut hit = false;
    let mut copied = 0;
    let mut i = 0;
    // Index of the closing quote of the string opening at `q` (`n` if cut).
    let string_end = |q: usize| {
        let mut e = q + 1;
        while e < n && b[e] != b'"' {
            e += if b[e] == b'\\' { 2 } else { 1 };
        }
        e.min(n)
    };
    // Index just past the object/array opening at `o` (`n` if cut).
    let container_end = |o: usize| {
        let mut depth = 0usize;
        let mut e = o;
        while e < n {
            match b[e] {
                b'"' => e = string_end(e),
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return e + 1;
                    }
                }
                _ => {}
            }
            e += 1;
        }
        n
    };
    let skip_ws = |mut k: usize| {
        while k < n && b[k].is_ascii_whitespace() {
            k += 1;
        }
        k
    };
    while i < n {
        if b[i] != b'"' {
            i += 1;
            continue;
        }
        let key_end = string_end(i);
        let colon = skip_ws(key_end + 1);
        if key_end >= n || colon >= n || b[colon] != b':' {
            // A string value, not a key: skip past it.
            i = key_end + 1;
            continue;
        }
        let key = String::from_utf8_lossy(&b[i + 1..key_end]);
        let v = skip_ws(colon + 1);
        if v >= n || !is_sensitive_key(&key) {
            i = v;
            continue;
        }
        // (keep through, resume copying at, mask, continue scanning at)
        let (keep_to, resume_at, mask, next): (usize, usize, &[u8], usize) = match b[v] {
            b'"' => {
                let e = string_end(v);
                (v + 1, e, b"***", e + 1)
            }
            b'{' | b'[' => {
                let e = container_end(v);
                (v, e, b"\"***\"", e)
            }
            _ => {
                let mut e = v;
                while e < n && !matches!(b[e], b',' | b'}' | b']') && !b[e].is_ascii_whitespace() {
                    e += 1;
                }
                (v, e, b"\"***\"", e)
            }
        };
        out.extend_from_slice(&b[copied..keep_to]);
        out.extend_from_slice(mask);
        copied = resume_at;
        hit = true;
        i = next;
    }
    if copied < n {
        out.extend_from_slice(&b[copied..]);
    }
    (String::from_utf8_lossy(&out).into_owned(), hit)
}

fn mask_form_values(text: &str) -> (String, bool) {
    // Only bodies that look like `a=b&c=d`, never JSON.
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') || !text.contains('=') {
        return (text.to_string(), false);
    }
    let mut hit = false;
    let parts: Vec<String> = text
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, _)) if is_sensitive_key(k.trim()) => {
                hit = true;
                format!("{k}=***")
            }
            _ => pair.to_string(),
        })
        .collect();
    (parts.join("&"), hit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_secret_named_fields_and_leaves_the_rest_verbatim() {
        let (text, hit) = mask_secrets(
            r#"{"username":"ada","password":"hunter2","nested":{"client_secret":"s3","n":1},"api_key":12345,"note":"password is fine here"}"#,
        );
        assert!(hit);
        // A secret-looking word inside a normal value is left alone.
        assert_eq!(
            text,
            r#"{"username":"ada","password":"***","nested":{"client_secret":"***","n":1},"api_key":"***","note":"password is fine here"}"#
        );
    }

    /// The card hides a secret key's value whatever its shape, so the raw
    /// view must too: an object or array under a secret key is masked whole.
    #[test]
    fn masks_an_object_or_array_under_a_secret_key_whole() {
        let (text, hit) = mask_secrets(
            r#"{"api_keys":["k1","k2"],"secret":{"v":"x","deep":[{"a":"]"}]},"after":"kept"}"#,
        );
        assert!(hit);
        assert_eq!(text, r#"{"api_keys":"***","secret":"***","after":"kept"}"#);
        // Cut off inside the container: masked through the end.
        let (text, _) = mask_secrets(r#"{"token":{"value":"abcdef"#);
        assert_eq!(text, r#"{"token":"***""#);
    }

    #[test]
    fn masks_a_secret_cut_off_by_truncation() {
        let (text, hit) = mask_secrets(r#"{"a":"x","token":"abcdefghijkl"#);
        assert!(hit);
        assert!(!text.contains("abcdef"), "partial secret leaked: {text}");
    }

    #[test]
    fn masks_form_encoded_secrets() {
        let (text, hit) = mask_secrets("grant_type=password&username=ada&password=hunter2");
        assert!(hit);
        assert_eq!(text, "grant_type=password&username=ada&password=***");
    }

    #[test]
    fn survives_hostile_input_without_panicking() {
        for s in [
            "\"",
            "\"\\",
            "{\"password\":",
            "{\"password\"",
            "{\"password\":\"é\\\"",
            "\"a\":\"b\"\"password\":1",
            "{\"🔑password\":\"x\"}",
            "{\"secret\":[[[\"",
            "{\"secret\":]]]}",
        ] {
            let _ = mask_secrets(s);
        }
    }

    #[test]
    fn redacted_values_hide_secrets_of_any_shape() {
        let v: Value = serde_json::from_str(r#"{"token":["a"],"name":"ok"}"#).unwrap();
        assert_eq!(
            redact_value(None, &v),
            serde_json::json!({"token":"***","name":"ok"})
        );
    }
}
