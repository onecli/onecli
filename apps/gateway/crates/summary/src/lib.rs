//! Human-readable summaries of held requests for manual-approval cards.
//!
//! When a request matches a `manual_approval` policy rule, the gateway holds it
//! and asks a human to approve. Showing the raw request body is both useless and
//! dangerous: a Gmail "send" carries a multi-kilobyte base64 MIME blob (with
//! embedded image attachments), which is unreadable *and* large enough to break
//! downstream chat clients that render the approval card (e.g. Telegram's
//! 4096-char message limit, which fail-closes some consumers to a silent deny).
//!
//! This crate turns a (possibly truncated) request-body prefix into a compact,
//! structured [`ApprovalSummary`] — "Send email · To: a@b.com · Subject: …" —
//! plus a bounded plain-text rendering for consumers without a structured UI.
//!
//! # Adding an app summarizer
//!
//! Implement [`RequestSummarizer`] on a zero-sized struct in its own module in
//! this crate and register it in `summarizer`. Anything not matched
//! falls back to `generic::summarize`, which redacts secret-looking values
//! and hard-caps length. This mirrors the per-provider plugin pattern in
//! `granular_access`.

use serde::{Deserialize, Serialize};

pub mod mime;

mod generic;
mod gmail;
mod google_calendar;
mod outlook_calendar;
mod outlook_mail;

// ── Limits ───────────────────────────────────────────────────────────────

/// Max length of any single detail value shown to the approver.
pub const MAX_VALUE_LEN: usize = 240;
/// Max length of a rendered body / generic-fallback value.
pub const MAX_BODY_LEN: usize = 500;
/// Max length of the whole rendered text block (kept well under chat limits).
pub const MAX_RENDER_LEN: usize = 3000;
/// Max length of an email/message body shown (near-)verbatim on the card.
pub const MAX_SNIPPET_LEN: usize = 1800;
/// Max number of attachment filenames to enumerate.
pub const MAX_ATTACHMENTS: usize = 5;

// ── Types ──────────────────────────────────────────────────────────────────

/// A structured, human-readable description of what a held request will do.
///
/// Serialized to the SDK as `summary` alongside the legacy `bodyPreview`.
/// Consumers with a structured UI render [`details`](Self::details); simpler
/// ones fall back to [`render_text`](Self::render_text).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalSummary {
    /// Short action title, e.g. "Send email" or "Delete calendar event".
    pub action: String,
    /// Ordered key facts, e.g. `[("To","a@b.com"), ("Subject","Hi")]`.
    pub details: Vec<ApprovalDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalDetail {
    pub label: String,
    pub value: String,
}

impl ApprovalSummary {
    pub fn new(action: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            details: Vec::new(),
        }
    }

    /// Push a detail, clamped to [`MAX_VALUE_LEN`]. Empty values are dropped.
    pub fn push(&mut self, label: impl Into<String>, value: impl Into<String>) {
        self.push_clamped(label, value, MAX_VALUE_LEN);
    }

    /// Push a detail clamped to a caller-chosen max (e.g. a longer email body).
    pub fn push_clamped(&mut self, label: impl Into<String>, value: impl Into<String>, max: usize) {
        let value = clamp(value.into().trim(), max);
        if value.is_empty() {
            return;
        }
        self.details.push(ApprovalDetail {
            label: label.into(),
            value,
        });
    }

    /// Render to a compact plain-text block for consumers without a structured
    /// UI. Always bounded — safe to embed in a fixed-size chat message.
    pub fn render_text(&self) -> String {
        let mut out = self.action.clone();
        for d in &self.details {
            out.push('\n');
            out.push_str(&d.label);
            // Multi-line values (e.g. an email body) render block-style under the
            // label so the card mirrors how the message will actually be sent.
            if d.value.contains('\n') {
                out.push_str(":\n");
            } else {
                out.push_str(": ");
            }
            out.push_str(&d.value);
        }
        clamp(&out, MAX_RENDER_LEN)
    }
}

// ── Summarizer plugin ────────────────────────────────────────────────────────

/// The peeked, bounded request a summarizer inspects. All borrowed — summarizers
/// are pure, synchronous, and do no I/O.
pub struct SummaryRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub content_type: Option<&'a str>,
    /// Bounded prefix of the request body (may be truncated mid-stream). `None`
    /// when the request had no body.
    pub body: Option<&'a [u8]>,
}

impl SummaryRequest<'_> {
    /// Uppercased HTTP method, for terse comparisons in summarizers.
    pub fn method_upper(&self) -> String {
        self.method.to_ascii_uppercase()
    }

    /// Request path with any query string removed.
    pub fn base_path(&self) -> &str {
        self.path.split('?').next().unwrap_or(self.path)
    }
}

/// A per-app summarizer. Implement on a zero-sized struct and register it in
/// `summarizer`. Return `None` to defer to the generic fallback (e.g. for an
/// endpoint this app doesn't recognize).
pub trait RequestSummarizer: Sync {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary>;
}

static GMAIL: gmail::Gmail = gmail::Gmail;
static GOOGLE_CALENDAR: google_calendar::GoogleCalendar = google_calendar::GoogleCalendar;
static OUTLOOK_MAIL: outlook_mail::OutlookMail = outlook_mail::OutlookMail;
static OUTLOOK_CALENDAR: outlook_calendar::OutlookCalendar = outlook_calendar::OutlookCalendar;

/// Resolve the summarizer for a OneCLI provider id. `None` for providers
/// without a dedicated summarizer — the caller falls back to the generic
/// rendering.
fn summarizer(provider: &str) -> Option<&'static dyn RequestSummarizer> {
    match provider {
        "gmail" => Some(&GMAIL),
        "google-calendar" => Some(&GOOGLE_CALENDAR),
        "outlook-mail" => Some(&OUTLOOK_MAIL),
        "outlook-calendar" => Some(&OUTLOOK_CALENDAR),
        _ => None,
    }
}

/// Build a human-readable summary for a held request.
///
/// `provider` is the OneCLI provider id (from `apps::provider_for_host_and_path`);
/// `body` is the peeked prefix of the request body (may be truncated). Always
/// returns a summary — unknown providers/endpoints fall back to a safe generic
/// rendering that redacts secrets and bounds length.
#[must_use]
pub fn summarize_request(
    provider: &str,
    method: &str,
    path: &str,
    content_type: Option<&str>,
    body: Option<&[u8]>,
) -> ApprovalSummary {
    let req = SummaryRequest {
        method,
        path,
        content_type,
        body,
    };
    summarizer(provider)
        .and_then(|s| s.summarize(&req))
        .unwrap_or_else(|| generic::summarize(&req))
}

// ── Shared helpers (used across submodules) ──────────────────────────────────

/// Truncate to at most `max` characters (not bytes), appending `…` when cut.
pub fn clamp(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// Parse a (possibly truncated) body as JSON; `None` on any error.
pub fn parse_json(b: &[u8]) -> Option<serde_json::Value> {
    serde_json::from_slice(b).ok()
}

/// The last non-empty path segment, e.g. the id in `/messages/{id}`.
pub fn last_segment(path: &str) -> Option<&str> {
    path.rsplit('/').find(|s| !s.is_empty())
}

/// The non-empty path segment immediately before `suffix`, e.g. the id in
/// `/messages/{id}/trash` for suffix `/trash`.
pub fn path_segment_before<'a>(path: &'a str, suffix: &str) -> Option<&'a str> {
    path.strip_suffix(suffix)?
        .rsplit('/')
        .find(|s| !s.is_empty())
}

/// Comma-joined `emailAddress.address` values from a Microsoft Graph person array
/// (`toRecipients`, `ccRecipients`, `attendees`, …), capped at `limit`. `None`
/// when the field is absent or has no addresses. Shared by the Graph summarizers,
/// which all carry people in this `{ emailAddress: { address } }` shape.
fn email_addresses(value: &serde_json::Value, key: &str, limit: usize) -> Option<String> {
    let list: Vec<&str> = value
        .get(key)?
        .as_array()?
        .iter()
        .filter_map(|p| p.get("emailAddress")?.get("address")?.as_str())
        .take(limit)
        .collect();
    (!list.is_empty()).then(|| list.join(", "))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    #[test]
    fn render_text_is_always_bounded() {
        let mut s = ApprovalSummary::new("X".repeat(50));
        for i in 0..50 {
            s.push(format!("L{i}"), "y".repeat(500));
        }
        assert!(s.render_text().chars().count() <= MAX_RENDER_LEN);
    }

    #[test]
    fn unknown_provider_with_no_body_falls_back_to_generic() {
        let s = summarize_request("whatever", "DELETE", "/v1/resource/42", None, None);
        assert_eq!(s.action, "DELETE request");
        assert_eq!(detail(&s, "Endpoint"), Some("/v1/resource/42"));
    }

    #[test]
    fn clamp_counts_chars_not_bytes_and_marks_truncation() {
        assert_eq!(clamp("hello", 10), "hello");
        assert_eq!(clamp("hello", 3), "he…");
        // Multi-byte chars are counted as one each (no mid-codepoint cut).
        assert_eq!(clamp("☃☃☃☃", 2), "☃…");
    }

    #[test]
    fn render_text_blocks_multiline_values_under_the_label() {
        let mut s = ApprovalSummary::new("Send email");
        s.push("To", "a@b.com");
        s.push("Body", "line one\nline two");
        let text = s.render_text();
        assert!(text.contains("To: a@b.com"));
        assert!(text.contains("Body:\nline one\nline two"));
    }
}
