//! Google Calendar — manual-approval summaries.
//!
//! Event create/update carry a JSON body (`summary`, `location`, `start`/`end`,
//! `attendees`); delete carries the event id in the path. Registered as the
//! `"google-calendar"` summarizer in [`super::summarizer`].

use serde_json::Value;

use super::{last_segment, parse_json, ApprovalSummary, RequestSummarizer, SummaryRequest};

pub(super) struct GoogleCalendar;

impl RequestSummarizer for GoogleCalendar {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let m = req.method_upper();
        let base = req.base_path();
        if !base.contains("/calendar/v3/") || !base.contains("/events") {
            return None;
        }
        let action = match m.as_str() {
            "POST" => "Create calendar event",
            "PUT" | "PATCH" => "Update calendar event",
            "DELETE" => "Delete calendar event",
            _ => return None,
        };
        let mut s = ApprovalSummary::new(action);

        if m == "DELETE" {
            if let Some(id) = last_segment(base) {
                s.push("Event", id);
            }
            return Some(s);
        }

        if let Some(v) = req.body.and_then(parse_json) {
            if let Some(title) = v.get("summary").and_then(|x| x.as_str()) {
                s.push("Title", title);
            }
            if let Some(loc) = v.get("location").and_then(|x| x.as_str()) {
                s.push("Location", loc);
            }
            if let Some(start) = event_time(&v, "start") {
                s.push("Start", start);
            }
            if let Some(end) = event_time(&v, "end") {
                s.push("End", end);
            }
            if let Some(attendees) = v.get("attendees").and_then(|x| x.as_array()) {
                let emails: Vec<String> = attendees
                    .iter()
                    .filter_map(|a| a.get("email").and_then(|e| e.as_str()).map(String::from))
                    .take(10)
                    .collect();
                if !emails.is_empty() {
                    s.push("Attendees", emails.join(", "));
                }
            }
        }
        Some(s)
    }
}

/// A Google Calendar event endpoint's `start`/`end` is either a timed
/// `{"dateTime": …}` or an all-day `{"date": …}`.
fn event_time(v: &Value, key: &str) -> Option<String> {
    let node = v.get(key)?;
    node.get("dateTime")
        .and_then(|x| x.as_str())
        .or_else(|| node.get("date").and_then(|x| x.as_str()))
        .map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summarize(method: &str, path: &str, body: Option<&[u8]>) -> ApprovalSummary {
        super::super::summarize_request(
            "google-calendar",
            method,
            path,
            Some("application/json"),
            body,
        )
    }

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    #[test]
    fn create_event_extracts_fields() {
        let body = br#"{"summary":"Team sync","location":"Room 4","start":{"dateTime":"2026-06-20T15:00:00Z"},"attendees":[{"email":"x@y.com"},{"email":"z@y.com"}]}"#;
        let s = summarize("POST", "/calendar/v3/calendars/primary/events", Some(body));
        assert_eq!(s.action, "Create calendar event");
        assert_eq!(detail(&s, "Title"), Some("Team sync"));
        assert_eq!(detail(&s, "Location"), Some("Room 4"));
        assert_eq!(detail(&s, "Start"), Some("2026-06-20T15:00:00Z"));
        assert_eq!(detail(&s, "Attendees"), Some("x@y.com, z@y.com"));
    }

    #[test]
    fn delete_event_uses_path_id() {
        let s = summarize(
            "DELETE",
            "/calendar/v3/calendars/primary/events/evt123",
            None,
        );
        assert_eq!(s.action, "Delete calendar event");
        assert_eq!(detail(&s, "Event"), Some("evt123"));
    }

    #[test]
    fn all_day_event_uses_date() {
        let body =
            br#"{"summary":"Holiday","start":{"date":"2026-12-25"},"end":{"date":"2026-12-26"}}"#;
        let s = summarize("POST", "/calendar/v3/calendars/primary/events", Some(body));
        assert_eq!(detail(&s, "Start"), Some("2026-12-25"));
        assert_eq!(detail(&s, "End"), Some("2026-12-26"));
    }
}
