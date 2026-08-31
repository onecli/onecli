//! Outlook Mail (Microsoft Graph) — manual-approval summaries.
//!
//! Unlike Gmail's base64 RFC822 `raw`, Graph carries a structured JSON `message`
//! (`subject`, `body.{contentType,content}`, `toRecipients[].emailAddress.address`,
//! `attachments[].name`). `sendMail` nests it under `message`; draft-create
//! (`POST /messages`) puts the fields at the top level. HTML bodies are reduced
//! to readable text. Registered as `"outlook-mail"` in [`super::summarizer`].

use serde_json::Value;

use crate::{
    last_segment, parse_json, path_segment_before, ApprovalSummary, RequestSummarizer,
    SummaryRequest, MAX_ATTACHMENTS, MAX_SNIPPET_LEN,
};

pub(super) struct OutlookMail;

impl RequestSummarizer for OutlookMail {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let m = req.method_upper();
        let base = req.base_path();

        // POST /v1.0/me/sendMail — the message is normally nested under `message`
        // (alongside `saveToSentItems`), but Graph also accepts the message fields
        // at the top level (docs Example 5). Handle both; borrow, don't clone.
        if m == "POST" && base.ends_with("/sendMail") {
            let mut s = ApprovalSummary::new("Send email");
            if let Some(v) = req.body.and_then(parse_json) {
                populate_from_message(&mut s, v.get("message").unwrap_or(&v));
            }
            ensure_note(&mut s);
            return Some(s);
        }

        // POST /v1.0/me/messages/{id}/send — send a previously created draft.
        if m == "POST" && base.ends_with("/send") && base.contains("/messages/") {
            let mut s = ApprovalSummary::new("Send existing draft");
            if let Some(id) = path_segment_before(base, "/send") {
                s.push("Message", id);
            }
            return Some(s);
        }

        // POST .../messages — create a draft; message fields are at the top level.
        if m == "POST" && base.ends_with("/messages") {
            let mut s = ApprovalSummary::new("Create draft");
            if let Some(v) = req.body.and_then(parse_json) {
                populate_from_message(&mut s, &v);
            }
            ensure_note(&mut s);
            return Some(s);
        }

        if m == "DELETE" && base.contains("/messages/") {
            let mut s = ApprovalSummary::new("Delete message");
            if let Some(id) = last_segment(base) {
                s.push("Message", id);
            }
            return Some(s);
        }
        None
    }
}

fn ensure_note(s: &mut ApprovalSummary) {
    if s.details.is_empty() {
        s.push("Note", "email contents not in preview");
    }
}

/// Map a Graph `message` object onto the summary's detail fields.
fn populate_from_message(s: &mut ApprovalSummary, message: &Value) {
    if let Some(to) = super::email_addresses(message, "toRecipients", 20) {
        s.push("To", to);
    }
    if let Some(cc) = super::email_addresses(message, "ccRecipients", 20) {
        s.push("Cc", cc);
    }
    if let Some(subject) = message.get("subject").and_then(|v| v.as_str()) {
        s.push("Subject", subject);
    }
    let names = attachment_names(message);
    if !names.is_empty() {
        s.push("Attachments", names.join(", "));
    }
    if let Some(body) = body_text(message) {
        s.push_clamped("Body", body, MAX_SNIPPET_LEN);
    }
}

fn attachment_names(message: &Value) -> Vec<String> {
    message
        .get("attachments")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()).map(String::from))
                .take(MAX_ATTACHMENTS)
                .collect()
        })
        .unwrap_or_default()
}

/// The message body as readable text. HTML is reduced to text; plain-text passes
/// through. `None` when absent/empty.
fn body_text(message: &Value) -> Option<String> {
    let body = message.get("body")?;
    let content = body.get("content").and_then(|v| v.as_str())?;
    let is_html = body
        .get("contentType")
        .and_then(|v| v.as_str())
        .is_some_and(|t| t.eq_ignore_ascii_case("html"));
    let text = if is_html {
        html_to_text(content)
    } else {
        content.to_string()
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

// ── Tiny HTML→text reducer (best-effort, for readability only) ────────────────

/// Reduce HTML to readable text: block/break tags become line breaks, remaining
/// tags are dropped, a few common entities are decoded, and whitespace is
/// normalized. Not a parser — just enough to make an approval card legible.
fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut chars = html.chars();
    while let Some(c) = chars.next() {
        if c != '<' {
            out.push(c);
            continue;
        }
        // Consume the tag, capturing its (lowercased) name to decide on breaks.
        let mut tag = String::new();
        for tc in chars.by_ref() {
            if tc == '>' {
                break;
            }
            tag.push(tc);
        }
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase();
        if is_block_tag(&name) {
            out.push('\n');
        }
    }
    normalize_lines(&decode_entities(&out))
}

fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "br" | "p"
            | "div"
            | "li"
            | "ul"
            | "ol"
            | "tr"
            | "table"
            | "blockquote"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    )
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        // `&amp;` last so we don't double-decode (`&amp;lt;` → `&lt;`, not `<`).
        .replace("&amp;", "&")
}

/// Collapse intra-line whitespace to single spaces and runs of blank lines to a
/// single blank line; neutralize ``` so it can't break a chat code fence.
fn normalize_lines(s: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut blank = 0usize;
    for raw in s.split('\n') {
        let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            if blank <= 1 {
                lines.push(String::new());
            }
        } else {
            blank = 0;
            lines.push(line);
        }
    }
    lines.join("\n").trim().replace("```", "'''")
}

#[cfg(test)]
mod tests {
    use crate::{summarize_request, ApprovalSummary};

    fn summarize(method: &str, path: &str, body: Option<&[u8]>) -> ApprovalSummary {
        summarize_request("outlook-mail", method, path, Some("application/json"), body)
    }

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    #[test]
    fn send_mail_extracts_recipients_subject_and_html_body() {
        let body = br#"{"message":{"subject":"Q3 report","toRecipients":[{"emailAddress":{"address":"lisa@example.com","name":"Lisa"}}],"ccRecipients":[{"emailAddress":{"address":"sam@example.com"}}],"body":{"contentType":"HTML","content":"<div>Hi Lisa,</div><p>Here is the <b>report</b>.</p>"},"attachments":[{"name":"q3.pdf"}]},"saveToSentItems":true}"#;
        let s = summarize("POST", "/v1.0/me/sendMail", Some(body));
        assert_eq!(s.action, "Send email");
        assert_eq!(detail(&s, "To"), Some("lisa@example.com"));
        assert_eq!(detail(&s, "Cc"), Some("sam@example.com"));
        assert_eq!(detail(&s, "Subject"), Some("Q3 report"));
        assert_eq!(detail(&s, "Attachments"), Some("q3.pdf"));
        let body_detail = detail(&s, "Body").unwrap();
        assert!(body_detail.contains("Hi Lisa,"));
        assert!(body_detail.contains("Here is the report."));
        // HTML tags never leak onto the card.
        assert!(!body_detail.contains('<'));
    }

    #[test]
    fn send_mail_accepts_top_level_message_fields() {
        // Graph also accepts sendMail with the message fields at the top level
        // (no `message` wrapper) — see docs Example 5.
        let body = br#"{"subject":"Please respond by Friday","toRecipients":[{"emailAddress":{"address":"meganb@contoso.com"}}],"body":{"contentType":"Text","content":"thanks"}}"#;
        let s = summarize("POST", "/v1.0/me/sendMail", Some(body));
        assert_eq!(s.action, "Send email");
        assert_eq!(detail(&s, "To"), Some("meganb@contoso.com"));
        assert_eq!(detail(&s, "Subject"), Some("Please respond by Friday"));
    }

    #[test]
    fn create_draft_reads_top_level_message() {
        let body = br#"{"subject":"Draft hello","toRecipients":[{"emailAddress":{"address":"a@b.com"}}],"body":{"contentType":"Text","content":"plain body"}}"#;
        let s = summarize("POST", "/v1.0/me/messages", Some(body));
        assert_eq!(s.action, "Create draft");
        assert_eq!(detail(&s, "To"), Some("a@b.com"));
        assert_eq!(detail(&s, "Subject"), Some("Draft hello"));
        assert_eq!(detail(&s, "Body"), Some("plain body"));
    }

    #[test]
    fn delete_message_uses_path_id() {
        let s = summarize("DELETE", "/v1.0/me/messages/AAMkAGI2", None);
        assert_eq!(s.action, "Delete message");
        assert_eq!(detail(&s, "Message"), Some("AAMkAGI2"));
    }

    #[test]
    fn send_existing_draft_uses_path_id() {
        let s = summarize("POST", "/v1.0/me/messages/AAMkAGI2/send", None);
        assert_eq!(s.action, "Send existing draft");
        assert_eq!(detail(&s, "Message"), Some("AAMkAGI2"));
    }
}
