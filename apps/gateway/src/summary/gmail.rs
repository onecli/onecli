//! Gmail — manual-approval summaries.
//!
//! Send / draft-create carry a base64url RFC822 message in the JSON `raw` field;
//! we decode the peeked prefix and lift To/Cc/Subject/attachments/body onto the
//! card (never echoing the base64). Other actions (trash, label edits, delete)
//! summarize from the path and a small JSON body.
//!
//! Registered as the `"gmail"` summarizer in [`super::summarizer`].

use super::{
    last_segment, mime, parse_json, path_segment_before, ApprovalSummary, RequestSummarizer,
    SummaryRequest, MAX_SNIPPET_LEN,
};

pub(super) struct Gmail;

impl RequestSummarizer for Gmail {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let m = req.method_upper();
        let base = req.base_path();

        // Send / draft-create carry a base64url RFC822 message in `raw`.
        let is_send = m == "POST" && base.ends_with("/messages/send");
        let is_draft_create = m == "POST" && base.ends_with("/drafts");
        if is_send || is_draft_create {
            let mut s = ApprovalSummary::new(if is_send {
                "Send email"
            } else {
                "Create draft"
            });
            if let Some(raw) = req.body.and_then(|b| json_string_value_prefix(b, "raw")) {
                populate_from_mime(&mut s, &mime::decode_b64_prefix(raw));
            }
            if s.details.is_empty() {
                s.push("Note", "email contents not in preview");
            }
            return Some(s);
        }

        if m == "POST" && base.ends_with("/drafts/send") {
            return Some(ApprovalSummary::new("Send existing draft"));
        }

        if m == "POST" && base.ends_with("/trash") {
            let mut s = ApprovalSummary::new("Move message to trash");
            if let Some(id) = path_segment_before(base, "/trash") {
                s.push("Message", id);
            }
            return Some(s);
        }
        if m == "POST" && base.ends_with("/untrash") {
            let mut s = ApprovalSummary::new("Restore message from trash");
            if let Some(id) = path_segment_before(base, "/untrash") {
                s.push("Message", id);
            }
            return Some(s);
        }
        if m == "POST" && base.ends_with("/modify") {
            let mut s = ApprovalSummary::new("Modify message labels");
            if let Some(id) = path_segment_before(base, "/modify") {
                s.push("Message", id);
            }
            if let Some(v) = req.body.and_then(parse_json) {
                if let Some(add) = string_array(&v, "addLabelIds") {
                    s.push("Add labels", add);
                }
                if let Some(rm) = string_array(&v, "removeLabelIds") {
                    s.push("Remove labels", rm);
                }
            }
            return Some(s);
        }
        if m == "DELETE" {
            if base.contains("/drafts/") {
                let mut s = ApprovalSummary::new("Delete draft");
                if let Some(id) = last_segment(base) {
                    s.push("Draft", id);
                }
                return Some(s);
            }
            if base.contains("/messages/") {
                let mut s = ApprovalSummary::new("Delete message");
                if let Some(id) = last_segment(base) {
                    s.push("Message", id);
                }
                return Some(s);
            }
        }
        if m == "GET" {
            if base.ends_with("/profile") {
                return Some(ApprovalSummary::new("Read profile"));
            }
            if base.ends_with("/messages") {
                return Some(ApprovalSummary::new("List messages"));
            }
            if base.contains("/messages/") {
                let mut s = ApprovalSummary::new("Read email");
                if let Some(id) = last_segment(base) {
                    s.push("Message", id);
                }
                return Some(s);
            }
        }
        None
    }
}

/// Map a parsed RFC822 message onto the summary's detail fields.
fn populate_from_mime(s: &mut ApprovalSummary, decoded: &[u8]) {
    let msg = mime::parse(decoded);
    if let Some(to) = msg.to {
        s.push("To", to);
    }
    if let Some(cc) = msg.cc {
        s.push("Cc", cc);
    }
    if let Some(subject) = msg.subject {
        s.push("Subject", subject);
    }
    if !msg.attachments.is_empty() {
        s.push("Attachments", msg.attachments.join(", "));
    } else if msg.has_attachments {
        s.push("Attachments", "yes (filenames not in preview)");
    }
    if let Some(body) = msg.body {
        s.push_clamped("Body", body, MAX_SNIPPET_LEN);
    }
}

/// Extract the prefix of a JSON string value for `key` (`"key":"<prefix>"`),
/// tolerating a truncated body with no closing quote. Base64url/standard values
/// contain no `"`/`\`, so a scan to the next unescaped quote is sufficient.
fn json_string_value_prefix<'a>(body: &'a [u8], key: &str) -> Option<&'a [u8]> {
    let needle = format!("\"{key}\"");
    let mut i = find_sub(body, needle.as_bytes())? + needle.len();
    while i < body.len() && body[i].is_ascii_whitespace() {
        i += 1;
    }
    if body.get(i) != Some(&b':') {
        return None;
    }
    i += 1;
    while i < body.len() && body[i].is_ascii_whitespace() {
        i += 1;
    }
    if body.get(i) != Some(&b'"') {
        return None;
    }
    i += 1;
    let start = i;
    while i < body.len() && !(body[i] == b'"' && body[i - 1] != b'\\') {
        i += 1;
    }
    Some(&body[start..i])
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Join the string elements of a JSON array field into a comma list, or `None`
/// when absent/empty. Used for Gmail's `addLabelIds` / `removeLabelIds`.
fn string_array(v: &serde_json::Value, key: &str) -> Option<String> {
    let items: Vec<&str> = v
        .get(key)?
        .as_array()?
        .iter()
        .filter_map(|x| x.as_str())
        .collect();
    (!items.is_empty()).then(|| items.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn b64url(bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    fn summarize(method: &str, path: &str, body: Option<&[u8]>) -> ApprovalSummary {
        // Route through the real entry point so the "gmail" registration is exercised.
        super::super::summarize_request("gmail", method, path, Some("application/json"), body)
    }

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    const MULTIPART_EMAIL: &str = "To: Lisa <lisa@example.com>\r\n\
Subject: Q3 report\r\n\
Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n\
\r\n\
--BOUND\r\n\
Content-Type: text/plain; charset=\"UTF-8\"\r\n\
\r\n\
Hi Lisa, here is the screenshot you asked for.\r\n\
--BOUND\r\n\
Content-Type: image/png; name=\"screenshot.png\"\r\n\
Content-Disposition: attachment; filename=\"screenshot.png\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
iVBORw0KGgoAAAANSUhEUg==\r\n\
--BOUND--\r\n";

    #[test]
    fn send_with_image_decodes_to_readable_fields() {
        let body = format!("{{\"raw\":\"{}\"}}", b64url(MULTIPART_EMAIL.as_bytes()));
        let s = summarize(
            "POST",
            "/gmail/v1/users/me/messages/send",
            Some(body.as_bytes()),
        );
        assert_eq!(s.action, "Send email");
        assert_eq!(detail(&s, "To"), Some("Lisa <lisa@example.com>"));
        assert_eq!(detail(&s, "Subject"), Some("Q3 report"));
        assert_eq!(detail(&s, "Attachments"), Some("screenshot.png"));
        assert!(detail(&s, "Body").unwrap().contains("Hi Lisa"));
        // Never leaks the base64 blob.
        assert!(!s.render_text().contains("iVBORw0KGgo"));
    }

    #[test]
    fn send_with_truncated_raw_still_gets_headers() {
        // Encode only the header portion, then drop the closing JSON quote/brace
        // to simulate a body peeked mid-stream.
        let headers = "To: a@b.com\r\nSubject: Hello there\r\nContent-Type: text/plain\r\n\r\nbody";
        let body = format!("{{\"raw\":\"{}", b64url(headers.as_bytes()));
        let s = summarize(
            "POST",
            "/gmail/v1/users/me/messages/send",
            Some(body.as_bytes()),
        );
        assert_eq!(s.action, "Send email");
        assert_eq!(detail(&s, "To"), Some("a@b.com"));
        assert_eq!(detail(&s, "Subject"), Some("Hello there"));
    }

    #[test]
    fn trash_uses_path_id_no_body() {
        let s = super::super::summarize_request(
            "gmail",
            "POST",
            "/gmail/v1/users/me/messages/18abc/trash",
            None,
            None,
        );
        assert_eq!(s.action, "Move message to trash");
        assert_eq!(detail(&s, "Message"), Some("18abc"));
    }

    #[test]
    fn body_preserves_line_breaks() {
        let mime = "To: a@b.com\r\nSubject: Hi\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\nHey Jonathan,\r\n\r\nThis is a test.\r\n\r\nJonathan\r\n--\r\nSent via Nano\r\n";
        let body = format!("{{\"raw\":\"{}\"}}", b64url(mime.as_bytes()));
        let s = summarize(
            "POST",
            "/gmail/v1/users/me/messages/send",
            Some(body.as_bytes()),
        );
        let body_detail = detail(&s, "Body").unwrap();
        assert!(
            body_detail.contains("Hey Jonathan,\n\nThis is a test."),
            "newlines should be preserved, got: {body_detail:?}"
        );
        assert!(s.render_text().contains("Body:\nHey Jonathan,"));
    }

    #[test]
    fn get_messages_lists() {
        let s = super::super::summarize_request(
            "gmail",
            "GET",
            "/gmail/v1/users/me/messages",
            None,
            None,
        );
        assert_eq!(s.action, "List messages");
    }

    #[test]
    fn get_message_by_id_reads() {
        let s = super::super::summarize_request(
            "gmail",
            "GET",
            "/gmail/v1/users/me/messages/18abc",
            None,
            None,
        );
        assert_eq!(s.action, "Read email");
        assert_eq!(detail(&s, "Message"), Some("18abc"));
    }

    #[test]
    fn modify_labels_lists_add_and_remove() {
        let body = br#"{"addLabelIds":["IMPORTANT"],"removeLabelIds":["INBOX","UNREAD"]}"#;
        let s = summarize("POST", "/gmail/v1/users/me/messages/42/modify", Some(body));
        assert_eq!(s.action, "Modify message labels");
        assert_eq!(detail(&s, "Message"), Some("42"));
        assert_eq!(detail(&s, "Add labels"), Some("IMPORTANT"));
        assert_eq!(detail(&s, "Remove labels"), Some("INBOX, UNREAD"));
    }
}
