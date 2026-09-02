//! Outlook Calendar (Microsoft Graph) — manual-approval summaries.
//!
//! Event create/update carry a JSON body (`subject`, `location.displayName`,
//! `start.dateTime`, `end.dateTime`, `attendees[].emailAddress.address`); delete
//! carries the event id in the path. Registered as `"outlook-calendar"` in
//! [`super::summarizer`].

use serde_json::Value;

use crate::{last_segment, parse_json, ApprovalSummary, RequestSummarizer, SummaryRequest};

pub(super) struct OutlookCalendar;

impl RequestSummarizer for OutlookCalendar {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let m = req.method_upper();
        let base = req.base_path();
        if !base.contains("/events") {
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
            if let Some(title) = v.get("subject").and_then(|x| x.as_str()) {
                s.push("Title", title);
            }
            if let Some(loc) = v
                .get("location")
                .and_then(|l| l.get("displayName"))
                .and_then(|x| x.as_str())
            {
                s.push("Location", loc);
            }
            if let Some(start) = event_time(&v, "start") {
                s.push("Start", start);
            }
            if let Some(end) = event_time(&v, "end") {
                s.push("End", end);
            }
            if let Some(attendees) = super::email_addresses(&v, "attendees", 10) {
                s.push("Attendees", attendees);
            }
        }
        Some(s)
    }
}

/// Graph event `start`/`end` is a `dateTimeTimeZone`: `{ "dateTime": "…",
/// "timeZone": "…" }`. The `dateTime` carries no offset, so the `timeZone` is
/// appended when present (e.g. `2026-06-20T15:00:00 (Pacific Standard Time)`).
fn event_time(v: &Value, key: &str) -> Option<String> {
    let node = v.get(key)?;
    let date_time = node.get("dateTime").and_then(|x| x.as_str())?;
    match node.get("timeZone").and_then(|x| x.as_str()) {
        Some(tz) if !tz.is_empty() => Some(format!("{date_time} ({tz})")),
        _ => Some(date_time.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use crate::{summarize_request, ApprovalSummary};

    fn summarize(method: &str, path: &str, body: Option<&[u8]>) -> ApprovalSummary {
        summarize_request(
            "outlook-calendar",
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
        let body = br#"{"subject":"Team sync","location":{"displayName":"Room 4"},"start":{"dateTime":"2026-06-20T15:00:00","timeZone":"UTC"},"end":{"dateTime":"2026-06-20T15:30:00","timeZone":"UTC"},"attendees":[{"emailAddress":{"address":"x@y.com"}},{"emailAddress":{"address":"z@y.com"}}]}"#;
        let s = summarize("POST", "/v1.0/me/events", Some(body));
        assert_eq!(s.action, "Create calendar event");
        assert_eq!(detail(&s, "Title"), Some("Team sync"));
        assert_eq!(detail(&s, "Location"), Some("Room 4"));
        // Graph dateTime has no offset, so the timeZone is appended.
        assert_eq!(detail(&s, "Start"), Some("2026-06-20T15:00:00 (UTC)"));
        assert_eq!(detail(&s, "End"), Some("2026-06-20T15:30:00 (UTC)"));
        assert_eq!(detail(&s, "Attendees"), Some("x@y.com, z@y.com"));
    }

    #[test]
    fn delete_event_uses_path_id() {
        let s = summarize("DELETE", "/v1.0/me/events/AAMkAGI2evt", None);
        assert_eq!(s.action, "Delete calendar event");
        assert_eq!(detail(&s, "Event"), Some("AAMkAGI2evt"));
    }

    #[test]
    fn update_event_via_patch() {
        let body = br#"{"subject":"Renamed"}"#;
        let s = summarize("PATCH", "/v1.0/me/events/AAMkAGI2evt", Some(body));
        assert_eq!(s.action, "Update calendar event");
        assert_eq!(detail(&s, "Title"), Some("Renamed"));
    }
}
