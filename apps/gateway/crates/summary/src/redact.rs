//! What counts as a secret on an approval card, and how it is hidden. Both
//! approval surfaces mask by this one key list, so they can never disagree:
//!
//! - the readable card redacts parsed values ([`redact_value`]): secret-named
//!   keys become `***`, base64 blobs and long strings are elided;
//! - the raw request view masks the body text as sent ([`mask_secrets`]),
//!   which may be cut mid-value by the gateway's peek, so it scans text
//!   instead of parsing.
//!
//! A URL's query carries credentials under names no body would use
//! (`X-Amz-Signature`, `sig`, `code`): [`is_url_credential`] widens the
//! list for those, and both the card's query rows and the gateway's log
//! lines mask by it.

use percent_encoding::percent_decode_str;
use serde_json::Value;

/// Whether a JSON / form key names a secret (`password`, `client_secret`,
/// `api_key`, a 2FA key, a session cookie, …). A header-style or spaced
/// spelling (`X-Api-Key`, `api key`) names the same secret as its snake_case
/// one.
#[must_use]
pub fn is_sensitive_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase().replace(['-', ' '], "_");
    // A PIN only as the whole name: as a fragment, `pin` is in `shipping`.
    k == "pin"
        || [
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
            "twofactor",
            "two_factor",
            "cookie",
        ]
        .iter()
        .any(|p| k.contains(p))
}

/// Name fragments that mark a credential in a URL query on top of the secret
/// keys a body is masked by ([`is_sensitive_key`]): request signatures
/// (`sig`, `X-Amz-Signature`), `X-Amz-Credential`, embedded auth tokens
/// (`tempauth`, `authtoken`), OAuth `code`, and session handles that
/// authorize on their own (`session_id`, a resumable upload's `upload_id`).
const URL_CREDENTIAL_FRAGMENTS: [&str; 6] =
    ["sig", "auth", "code", "credential", "session", "upload_id"];

/// Whether a URL query parameter's name looks like it carries a credential.
///
/// Substring-matched on the decoded, lowercased name, so a provider's new
/// `*_token` or `*_secret` is covered the day it appears, and any name ending
/// in `key` is one (Google's and Trello's `key`, `x-api-key`, Azure API
/// Management's `subscription-key`).
/// Deliberately over-inclusive: masking a harmless `next_token` cursor or a
/// `sort_key` costs a little readability, a missed credential costs a leak.
#[must_use]
pub fn is_url_credential(name: &str) -> bool {
    let name = percent_decode_str(name)
        .decode_utf8_lossy()
        .to_ascii_lowercase();
    name.ends_with("key")
        || is_sensitive_key(&name)
        || URL_CREDENTIAL_FRAGMENTS.iter().any(|f| name.contains(f))
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
/// - Multipart form (`Content-Disposition: form-data; name="password"`):
///   the part's value, through its closing boundary line.
/// - Form style (`a=b&c=d`): `password=***`, through the next `&`.
#[must_use]
pub fn mask_secrets(text: &str) -> (String, bool) {
    let (text, json_hit) = mask_json_values(text);
    let (text, pairs_hit) = if is_multipart(&text) {
        mask_multipart_values(&text)
    } else {
        mask_form_values(&text)
    };
    (text, json_hit || pairs_hit)
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

/// A body with multipart form parts, whatever its declared type.
pub(crate) fn is_multipart(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("content-disposition:") && lower.contains("form-data")
}

/// Mask each multipart part whose field name is secret-named: everything
/// between the part's blank line and its boundary line (`\r\n--…`). A part
/// cut off by truncation is masked through the end.
fn mask_multipart_values(text: &str) -> (String, bool) {
    // ASCII lowercasing keeps every byte offset, and every offset below is
    // found by an ASCII pattern, so each lands on a char boundary of `text`.
    // Without an opening delimiter, mask sensitive parts through EOF.
    let boundary = text.split_once('\n').and_then(|(line, _)| {
        let line = line.trim_end_matches('\r').trim_end_matches([' ', '\t']);
        let token = line.strip_prefix("--")?;
        (!token.is_empty() && token.len() <= 70 && !token.ends_with("--")).then_some(line)
    });
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut hit = false;
    let mut copied = 0;
    let mut from = 0;
    while let Some(at) = lower[from..].find("content-disposition:") {
        let header = from + at;
        let line_end = lower[header..]
            .find('\n')
            .map_or(lower.len(), |e| header + e);
        let Some(name) = part_name(&text[header..line_end]) else {
            from = line_end;
            continue;
        };
        let Some(value_start) = ["\r\n\r\n", "\n\n"]
            .iter()
            .filter_map(|blank| {
                lower[header..]
                    .find(blank)
                    .map(|e| header + e + blank.len())
            })
            .min()
        else {
            break;
        };
        let value_end = boundary
            .and_then(|boundary| {
                let mut offset = value_start;
                for line in text[value_start..].split_inclusive('\n') {
                    let delimiter = line
                        .trim_end_matches('\n')
                        .trim_end_matches('\r')
                        .trim_end_matches([' ', '\t']);
                    // Match the complete, case-sensitive delimiter, never a prefix.
                    if delimiter == boundary || delimiter.strip_suffix("--") == Some(boundary) {
                        if offset == value_start {
                            return Some(value_start);
                        }
                        let end = offset - 1;
                        return Some(if text[..end].ends_with('\r') {
                            end - 1
                        } else {
                            end
                        });
                    }
                    offset += line.len();
                }
                None
            })
            .unwrap_or(text.len());
        if is_sensitive_key(&name) && value_end > value_start {
            out.push_str(&text[copied..value_start]);
            out.push_str("***");
            copied = value_end;
            hit = true;
        }
        from = if boundary.is_none() && !is_sensitive_key(&name) {
            value_start
        } else {
            value_end
        };
    }
    out.push_str(&text[copied..]);
    (out, hit)
}

/// The field name in a part's `Content-Disposition` line (`name="password"`),
/// never its `filename=`.
fn part_name(line: &str) -> Option<String> {
    // Parse whole parameters so filename and quoted semicolons cannot spoof name.
    let mut rest = line.split_once(';')?.1;
    while !rest.is_empty() {
        rest = rest.trim_start();
        let (key, value) = rest.split_once('=')?;
        let value = value.trim_start();
        let (name, tail) = if let Some(quoted) = value.strip_prefix('"') {
            let mut name = String::new();
            let mut escaped = false;
            let mut end = quoted.len();
            for (at, ch) in quoted.char_indices() {
                if escaped {
                    name.push(ch);
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    end = at + 1;
                    break;
                } else {
                    name.push(ch);
                }
            }
            (name, &quoted[end..])
        } else {
            let end = value.find(';').unwrap_or(value.len());
            (value[..end].trim().to_string(), &value[end..])
        };
        if key.trim().eq_ignore_ascii_case("name") {
            return Some(name);
        }
        rest = tail.trim_start().strip_prefix(';')?;
    }
    None
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

    /// A multipart field reads as sent in the raw view, so a secret-named
    /// one is masked there exactly as the card hides it.
    #[test]
    fn masks_secret_named_multipart_fields() {
        let body = "--XX\r\nContent-Disposition: form-data; name=\"user\"\r\n\r\nada\r\n\
                    --XX\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\nhunter2\r\n\
                    --XX\r\nContent-Disposition: form-data; name=\"doc\"; filename=\"token.txt\"\r\n\
                    Content-Type: text/plain\r\n\r\nhello\r\n--XX--\r\n";
        let (text, hit) = mask_secrets(body);
        assert!(hit);
        assert!(!text.contains("hunter2"), "{text}");
        assert!(
            text.contains("name=\"password\"\r\n\r\n***\r\n--XX"),
            "{text}"
        );
        // Other fields, and a part whose FILE name looks secret, read as sent.
        assert!(text.contains("\r\n\r\nada\r\n") && text.contains("\r\n\r\nhello\r\n"));
        // Cut off inside the secret part: masked through the end.
        let (text, hit) =
            mask_secrets("--XX\nContent-Disposition: form-data; name=\"api_key\"\n\nsk-live-abc");
        assert!(hit);
        assert!(!text.contains("sk-live"), "{text}");
    }

    #[test]
    fn multipart_fake_delimiters_never_reveal_secret_suffixes() {
        for fake in ["--FAKE", "--XXsuffix", "--xx", "--XX--suffix"] {
            let body = format!("--XX\r\nContent-Disposition: form-data; name=password\r\n\r\nfirst\r\n{fake}\r\nsecret-suffix\r\n--XX\r\nContent-Disposition: form-data; name=note\r\n\r\nkeep me\r\n--XX--\r\n");
            let (masked, hit) = mask_secrets(&body);
            assert!(hit);
            assert!(
                !masked.contains("first") && !masked.contains("secret-suffix"),
                "{masked}"
            );
            assert!(masked.contains("keep me"), "{masked}");
        }
    }

    #[test]
    fn multipart_names_allow_spacing_case_and_quoted_parameters() {
        for name in [
            "NaMe = PaSsWoRd",
            "name=\"password\"",
            "name = \"pass\\word\"",
            "filename=\"safe; name=note\"; NAME\t=\tpassword",
        ] {
            let body =
                format!("--XX\nCONTENT-DISPOSITION: FORM-DATA; {name}\n\ncredential\n--XX--\n");
            let (masked, hit) = mask_secrets(&body);
            assert!(hit && !masked.contains("credential"), "{masked}");
        }
        assert_eq!(
            part_name("Content-Disposition: form-data; filename=\"name=password\"; name=note"),
            Some("note".into())
        );
    }

    #[test]
    fn multipart_empty_harmless_part_does_not_skip_following_secret() {
        let body = "--XX\nContent-Disposition: form-data; name=note\n\n--XX\nContent-Disposition: form-data; name=password\n\ncredential\n--XX--\n";
        let (masked, hit) = mask_secrets(body);
        assert!(hit && !masked.contains("credential"), "{masked}");
    }

    #[test]
    fn multipart_without_reliable_boundary_masks_through_eof() {
        for prefix in ["", "preamble\n"] {
            let body = format!("{prefix}Content-Disposition: form-data; name=note\n\nharmless\n--guess\nContent-Disposition: form-data; name=password\n\nsecret-start\n--fake\nsecret-suffix");
            let (masked, hit) = mask_secrets(&body);
            assert!(hit);
            assert!(masked.ends_with("***"), "{masked}");
            assert!(!masked.contains("secret-start") && !masked.contains("secret-suffix"));
        }
        for ending in ["cut-secret", "cut-secret\n--X", "cut-secret\n--XXsuffix"] {
            let body = format!("--XX\nContent-Disposition: form-data; name=password\n\n{ending}");
            assert!(mask_secrets(&body).0.ends_with("***"));
        }
    }

    #[test]
    fn url_credentials_cover_what_a_body_key_list_misses() {
        for name in [
            "X-Amz-Signature",
            "sig",
            "code",
            "upload_id",
            "tempauth",
            "subscription-key",
        ] {
            assert!(is_url_credential(name), "{name}");
            assert!(!is_sensitive_key(name), "{name} is already a body secret");
        }
        // Decoded before matching: `access%5Ftoken` is `access_token`.
        assert!(is_url_credential("access%5Ftoken"));
        for name in ["startDateTime", "$top", "keyword", "page"] {
            assert!(!is_url_credential(name), "{name}");
        }
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
            "Content-Disposition: form-data; name=\"password",
            "Content-Disposition: form-data; name=\"token\"\r\n\r\n",
            "content-disposition:form-data;name=\"é\"\n\né\n--",
        ] {
            let _ = mask_secrets(s);
        }
    }

    #[test]
    fn header_and_spaced_spellings_name_the_same_secret() {
        for key in ["X-Api-Key", "api key", "Client-Secret", "x-access-key"] {
            assert!(is_sensitive_key(key), "{key}");
        }
        assert!(!is_sensitive_key("Content-Type"));
    }

    /// An account sign-in carries more than a password: a 2FA key (TOTP
    /// seed), a one-time PIN, and session cookies each sign in on their own
    /// (HeyReach's `li_account/Connect`, `SubmitPin`, `ConnectWithCookies`).
    #[test]
    fn sign_in_secrets_are_masked_on_the_card_and_in_the_raw_view() {
        for key in ["twoFactorAuthKey", "two_factor_code", "pin", "PIN"] {
            assert!(is_sensitive_key(key), "{key}");
        }
        assert!(is_sensitive_key("cookies") && is_sensitive_key("Set-Cookie"));
        // A PIN only as the whole name.
        for key in ["shipping", "pinned", "mapping", "spinner"] {
            assert!(!is_sensitive_key(key), "{key}");
        }
        let (text, hit) = mask_secrets(
            r#"{"username":"u@example.com","twoFactorAuthKey":"JBSWY3DPEHPK3PXP","accountId":1,"pin":"123456","cookies":[{"name":"li_at","value":"AQEDAR-cookie"}]}"#,
        );
        assert!(hit);
        assert_eq!(
            text,
            r#"{"username":"u@example.com","twoFactorAuthKey":"***","accountId":1,"pin":"***","cookies":"***"}"#
        );
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
