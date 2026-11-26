//! Outlook Calendar (Microsoft Graph) — manual-approval summaries.
//!
//! Event create/update carry a JSON body (`subject`, `location.displayName`,
//! `start.dateTime`, `end.dateTime`, `attendees[].emailAddress.address`); delete
//! carries the event id in the path. Registered as `"outlook-calendar"` in
//! [`super::summarizer`].

use serde_json::Value;

use crate::{
    last_segment, parse_json, ApprovalSummary, RequestSummarizer, SummaryKind, SummaryRequest,
};

pub(super) struct OutlookCalendar;

impl RequestSummarizer for OutlookCalendar {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let m = req.method_upper();
        let base = req.base_path();
        if m == "GET" {
            return read_events(req, base);
        }
        if !base.contains("/events") {
            return None;
        }
        let action = match m.as_str() {
            "POST" => "Create calendar event",
            "PUT" | "PATCH" => "Update calendar event",
            "DELETE" => {
                let mut s = ApprovalSummary::new("Delete calendar event");
                if let Some(id) = last_segment(base) {
                    s.push("Event", id);
                }
                return Some(s);
            }
            _ => return None,
        };
        let mut s = ApprovalSummary::new(action).with_kind(SummaryKind::Event);

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

/// A read of the calendar: the window it covers (`calendarView`'s
/// `startDateTime` / `endDateTime`), which calendar, one event, or the
/// calendar list. Most of these cards are an agent checking availability.
fn read_events(req: &SummaryRequest<'_>, base: &str) -> Option<ApprovalSummary> {
    let segs: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    // `/v1.0/me/…` or `/v1.0/users/{id}/…`: whose calendar.
    let (owner, rest) = match segs.as_slice() {
        ["v1.0" | "beta", "me", rest @ ..] => (None, rest),
        ["v1.0" | "beta", "users", user, rest @ ..] => (Some(*user), rest),
        _ => return None,
    };
    let (group, rest) = match rest {
        ["calendarGroups", group, "calendars", ..] => (Some(*group), &rest[2..]),
        ["calendarGroups", ..] => return None,
        _ => (None, rest),
    };
    let mut s = match rest {
        ["calendarView"] | ["calendars", _, "calendarView"] | ["calendar", "calendarView"] => {
            let mut s = ApprovalSummary::new("Read calendar events");
            if let Some(from) = req.query_param("startDateTime") {
                s.push("From", super::one_line(&from, super::MAX_VALUE_LEN));
            }
            if let Some(to) = req.query_param("endDateTime") {
                s.push("To", super::one_line(&to, super::MAX_VALUE_LEN));
            }
            s
        }
        ["events"] | ["calendars", _, "events"] | ["calendar", "events"] => {
            ApprovalSummary::new("List calendar events")
        }
        ["events", id] | ["calendar", "events", id] | ["calendars", _, "events", id] => {
            let mut s = ApprovalSummary::new("Read calendar event");
            s.push(
                "Event",
                super::one_line(&super::decode_segment(id), super::MAX_VALUE_LEN),
            );
            s
        }
        ["calendars"] => ApprovalSummary::new("List calendars"),
        _ => return None,
    };
    if let Some(group) = group {
        s.push(
            "Calendar group",
            super::one_line(&super::decode_segment(group), super::MAX_VALUE_LEN),
        );
    }
    if let ["calendars", id, ..] = rest {
        s.push(
            "Calendar",
            super::one_line(&super::decode_segment(id), super::MAX_VALUE_LEN),
        );
    }
    if let Some(user) = owner {
        s.push(
            "Calendar of",
            super::one_line(&super::decode_segment(user), super::MAX_VALUE_LEN),
        );
    }
    if let Some(filter) = req.query_param("$filter") {
        s.push("Filter", super::one_line(&filter, super::MAX_VALUE_LEN));
    }
    if let Some(top) = req.query_param("$top") {
        s.push("Page size", super::one_line(&top, super::MAX_VALUE_LEN));
    }
    Some(s)
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
    fn calendar_reads_say_which_window() {
        let s = summarize(
            "GET",
            "/v1.0/me/calendarView?startDateTime=2026-10-20T00:00:00Z&endDateTime=2026-10-27T00:00:00Z&$top=50",
            None,
        );
        assert_eq!(s.action, "Read calendar events");
        assert!(!s.is_generic());
        assert_eq!(detail(&s, "From"), Some("2026-10-20T00:00:00Z"));
        assert_eq!(detail(&s, "To"), Some("2026-10-27T00:00:00Z"));
        assert_eq!(detail(&s, "Page size"), Some("50"));
        let s = summarize(
            "GET",
            "/v1.0/users/alex@example.com/calendars/AQMk/calendarView",
            None,
        );
        assert_eq!(detail(&s, "Calendar"), Some("AQMk"));
        assert_eq!(detail(&s, "Calendar of"), Some("alex@example.com"));
        assert_eq!(
            summarize("GET", "/v1.0/me/events/AAMk1", None).action,
            "Read calendar event"
        );
        assert_eq!(
            summarize("GET", "/v1.0/me/calendars", None).action,
            "List calendars"
        );
        assert!(summarize("GET", "/v1.0/me/people", None).is_generic());
    }

    #[test]
    fn nested_calendar_reads_keep_their_scope_and_decode_targets() {
        let s = summarize(
            "GET",
            "/v1.0/users/alex%40example.com/calendarGroups/group-1/calendars/cal-2/events/event%2B3?$filter=subject%20eq%20%27Review%27&$top=2",
            None,
        );
        assert_eq!(s.action, "Read calendar event");
        assert_eq!(detail(&s, "Event"), Some("event+3"));
        assert_eq!(detail(&s, "Calendar"), Some("cal-2"));
        assert_eq!(detail(&s, "Calendar group"), Some("group-1"));
        assert_eq!(detail(&s, "Calendar of"), Some("alex@example.com"));
        assert_eq!(detail(&s, "Filter"), Some("subject eq 'Review'"));
        assert_eq!(detail(&s, "Page size"), Some("2"));
        assert!(summarize("GET", "/unknown/me/calendarView", None).is_generic());
        assert!(summarize("GET", "/v1.0/me/events/id/attachments", None).is_generic());
        assert!(summarize("GET", "/v1.0/me/calendarGroups/group/events", None).is_generic());
        let s = summarize(
            "GET",
            "/v1.0/users/alex%0Aforged/events?$filter=subject%0AFake%3Avalue",
            None,
        );
        assert!(!detail(&s, "Calendar of").unwrap().contains('\n'));
        assert!(!detail(&s, "Filter").unwrap().contains('\n'));
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
