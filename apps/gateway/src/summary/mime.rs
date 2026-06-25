//! Minimal, best-effort RFC822/MIME extraction for approval previews.
//!
//! Reads only what an approver needs — To/Cc/Subject, attachment names, and a
//! `text/plain` body snippet — from a (possibly truncated) decoded message.
//! Assumes UTF-8 (decoded lossily); HTML-only bodies and non-UTF-8 charsets are
//! intentionally not handled. Never allocates beyond the input prefix.
//!
//! Shared by raw-MIME providers (Gmail's base64url `raw` today). Robust
//! charset/HTML/nested handling is out of scope — swap in a parser crate if that
//! becomes a need.

use base64::Engine;

use super::{clamp, MAX_ATTACHMENTS, MAX_SNIPPET_LEN};

/// The fields lifted out of a message for the approval card.
pub(crate) struct ParsedMessage {
    pub to: Option<String>,
    pub cc: Option<String>,
    pub subject: Option<String>,
    /// Attachment filenames found in part headers (may be empty).
    pub attachments: Vec<String>,
    /// True when the top-level type is `multipart/mixed`, even if no filename was
    /// found in the peeked prefix.
    pub has_attachments: bool,
    pub body: Option<String>,
}

/// Parse a decoded RFC822 message prefix into the fields shown on the card.
pub(crate) fn parse(decoded: &[u8]) -> ParsedMessage {
    let text = String::from_utf8_lossy(decoded);
    let headers = headers(&text);
    let content_type = header_value(&headers, "content-type").unwrap_or("");
    ParsedMessage {
        to: header_value(&headers, "to").map(decode_rfc2047),
        cc: header_value(&headers, "cc").map(decode_rfc2047),
        subject: header_value(&headers, "subject").map(decode_rfc2047),
        attachments: attachments(&text),
        has_attachments: content_type
            .to_ascii_lowercase()
            .contains("multipart/mixed"),
        body: text_snippet(&text, content_type),
    }
}

/// Decode a base64 (url-safe or standard) prefix, tolerating truncation,
/// whitespace, and padding. Returns whatever decodes from the largest 4-byte
/// aligned prefix. Used to turn a Gmail `raw` value into message bytes.
pub(crate) fn decode_b64_prefix(raw: &[u8]) -> Vec<u8> {
    let cleaned: Vec<u8> = raw
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=' && *b != b'\\')
        .collect();
    let keep = cleaned.len() - cleaned.len() % 4;
    let slice = &cleaned[..keep];
    if let Ok(decoded) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(slice) {
        return decoded;
    }
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(slice)
        .unwrap_or_default()
}

/// Parse the top-of-message headers into `(lowercased-name, value)` pairs.
/// Unfolds continuation lines and stops at the first blank line (or end, when the
/// prefix was truncated mid-headers).
fn headers(text: &str) -> Vec<(String, String)> {
    let unix = text.replace("\r\n", "\n");
    let block = unix.split_once("\n\n").map_or(unix.as_str(), |(h, _)| h);

    let mut headers: Vec<(String, String)> = Vec::new();
    for line in block.split('\n') {
        if line.starts_with([' ', '\t']) {
            if let Some(last) = headers.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    headers
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

/// Collect attachment filenames, scanning **only** `Content-Disposition` /
/// `Content-Type` header lines (and their folded continuations). This avoids
/// false positives from a body that happens to contain `filename=…`.
fn attachments(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut names: Vec<String> = Vec::new();
    let mut in_param_header = false;
    for line in normalized.lines() {
        if names.len() >= MAX_ATTACHMENTS {
            break;
        }
        if !line.starts_with([' ', '\t']) {
            let lower = line.to_ascii_lowercase();
            in_param_header =
                lower.starts_with("content-disposition:") || lower.starts_with("content-type:");
        }
        if !in_param_header {
            continue;
        }
        if let Some(name) = filename_param(line) {
            if !name.is_empty() && !names.contains(&name) {
                names.push(clamp(&name, 80));
            }
        }
    }
    names
}

/// Extract a `filename=`/`filename*=`/`name=` parameter value from one header
/// line, handling quoted values and RFC2231 `charset''value` form.
fn filename_param(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let lower = line.to_ascii_lowercase();
    let kpos = lower.find("filename").or_else(|| lower.find("name="))?;
    // Advance to the '=' (allowing `filename*=` / `filename` + index).
    let mut i = kpos;
    while i < bytes.len() && bytes[i] != b'=' && bytes[i] != b';' && i - kpos < 12 {
        i += 1;
    }
    if bytes.get(i) != Some(&b'=') {
        return None;
    }
    i += 1;
    let value = if bytes.get(i) == Some(&b'"') {
        i += 1;
        let start = i;
        while i < bytes.len() && bytes[i] != b'"' {
            i += 1;
        }
        line[start..i].to_string()
    } else {
        let start = i;
        while i < bytes.len() && !matches!(bytes[i], b';' | b'\r' | b'\n') {
            i += 1;
        }
        line[start..i].trim().to_string()
    };
    // RFC2231 ext value: `UTF-8''name.png` → keep the part after `''`.
    let value = value.rsplit_once("''").map_or(value.as_str(), |(_, v)| v);
    Some(decode_rfc2047(value.trim().trim_matches('"')))
}

/// Best-effort `text/plain` snippet from a (possibly multipart) message,
/// preserving paragraph structure so it reads like the real email.
fn text_snippet(text: &str, content_type: &str) -> Option<String> {
    let ct = content_type.to_ascii_lowercase();
    let (region, cte) = if ct.contains("multipart") {
        let tp = text.to_ascii_lowercase().find("text/plain")?;
        let after = &text[tp..];
        let body_start = after.find("\n\n").or_else(|| after.find("\r\n\r\n"))?;
        // Detect the transfer-encoding from *this* part's own headers only —
        // scanning further would pick up a later part's (e.g. a base64 image
        // attachment) and wrongly try to base64-decode the plaintext snippet.
        let cte = detect_cte(&after[..body_start]);
        let body = &after[body_start..];
        let end = body.find("\n--").unwrap_or(body.len());
        (body[..end].trim().to_string(), cte)
    } else if ct.starts_with("text/") || ct.is_empty() {
        let body_start = text.find("\n\n").or_else(|| text.find("\r\n\r\n"))?;
        (
            text[body_start..].trim().to_string(),
            detect_cte(&text[..body_start]),
        )
    } else {
        return None;
    };

    let decoded = match cte.as_str() {
        "base64" => {
            let cleaned: String = region.chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(cleaned)
                .ok()?;
            String::from_utf8_lossy(&bytes).into_owned()
        }
        "quoted-printable" => decode_quoted_printable(&region),
        _ => region,
    };

    let cleaned = normalize_body(&decoded);
    if cleaned.is_empty() {
        return None;
    }
    // Drop snippets that decoded to mostly non-printable bytes (wrong part, etc.).
    // Newlines/tabs are expected structure, so they aren't counted as garbage.
    let garbage = cleaned
        .chars()
        .filter(|c| c.is_control() && !c.is_whitespace())
        .count();
    if garbage as f64 > 0.2 * cleaned.chars().count().max(1) as f64 {
        return None;
    }
    Some(clamp(&cleaned, MAX_SNIPPET_LEN))
}

fn detect_cte(headers: &str) -> String {
    headers
        .split('\n')
        .take(20)
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-transfer-encoding:")
                .map(|v| v.trim().to_string())
        })
        .unwrap_or_default()
}

/// Normalize a body for display: trim trailing whitespace per line, collapse runs
/// of blank lines to a single blank line, and neutralize ``` so it can't break a
/// downstream code fence. Preserves paragraph structure (newlines).
fn normalize_body(s: &str) -> String {
    let unix = s.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = Vec::new();
    let mut blank = 0usize;
    for line in unix.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank += 1;
            if blank <= 1 {
                lines.push(String::new());
            }
        } else {
            blank = 0;
            lines.push(trimmed.to_string());
        }
    }
    lines.join("\n").trim().replace("```", "'''")
}

// ── RFC2047 / quoted-printable ───────────────────────────────────────────────

/// Decode RFC2047 encoded-words (`=?charset?B?…?=` / `=?charset?Q?…?=`).
/// Best-effort: charset is ignored (decoded lossily as UTF-8); unparseable tokens
/// are left literal.
fn decode_rfc2047(input: &str) -> String {
    if !input.contains("=?") {
        return input.to_string();
    }
    let mut out = String::new();
    let mut rest = input;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let parts: Vec<&str> = after.splitn(3, '?').collect();
        if parts.len() < 3 {
            out.push_str("=?");
            rest = after;
            continue;
        }
        let Some(end) = parts[2].find("?=") else {
            out.push_str("=?");
            rest = after;
            continue;
        };
        let encoded = &parts[2][..end];
        let tail = &parts[2][end + 2..];
        let decoded = match parts[1].to_ascii_uppercase().as_str() {
            "B" => base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .ok()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_else(|| encoded.to_string()),
            "Q" => decode_q(encoded),
            _ => encoded.to_string(),
        };
        out.push_str(&decoded);
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn decode_q(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'_' => {
                out.push(b' ');
                i += 1;
            }
            b'=' if i + 2 < bytes.len() => match (hexval(bytes[i + 1]), hexval(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(b'=');
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn decode_quoted_printable(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' {
            if bytes.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            if bytes.get(i + 1) == Some(&b'\r') && bytes.get(i + 2) == Some(&b'\n') {
                i += 3;
                continue;
            }
            if i + 2 < bytes.len() {
                if let (Some(h), Some(l)) = (hexval(bytes[i + 1]), hexval(bytes[i + 2])) {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hexval(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'A'..=b'F' => Some(b - b'A' + 10),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc2047_encoded_words_decode() {
        // "=?UTF-8?B?8J+Ymg==?=" is base64 for the 😚 emoji.
        assert_eq!(decode_rfc2047("=?UTF-8?B?8J+Ymg==?="), "\u{1F61A}");
        assert_eq!(decode_rfc2047("=?UTF-8?Q?Hi_there?="), "Hi there");
        assert_eq!(decode_rfc2047("plain subject"), "plain subject");
    }

    #[test]
    fn attachments_only_come_from_part_headers() {
        // A body mentioning `filename=` must NOT register as an attachment.
        let msg = "Content-Type: text/plain\n\nplease save as filename=secret.txt thanks\n";
        assert!(parse(msg.as_bytes()).attachments.is_empty());

        // A real Content-Disposition header is picked up (and deduped vs the
        // Content-Type `name=` param for the same part).
        let msg2 = "Content-Type: multipart/mixed; boundary=B\n\n--B\n\
Content-Type: image/png; name=\"a.png\"\n\
Content-Disposition: attachment; filename=\"a.png\"\n\n--B--\n";
        assert_eq!(
            parse(msg2.as_bytes()).attachments,
            vec!["a.png".to_string()]
        );
    }

    #[test]
    fn body_snippet_keeps_paragraphs() {
        let msg = "Content-Type: text/plain\n\nHello,\n\nLine two.\n\n\n\ntoo many blanks\n";
        let body = parse(msg.as_bytes()).body.unwrap();
        assert!(body.contains("Hello,\n\nLine two."));
        // 3+ blank lines collapse to a single blank line.
        assert!(!body.contains("\n\n\n"));
    }
}
