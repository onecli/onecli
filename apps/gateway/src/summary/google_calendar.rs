//! Google Calendar — manual-approval summaries.
//!
//! Covers the major Calendar API v3 resources (events, calendars, calendarList,
//! acl, freeBusy, settings, colors, channels) with a friendly action title and
//! a few useful details lifted from the path / JSON body. Registered as the
//! `"google-calendar"` summarizer in [`super::summarizer`].

use serde_json::Value;

use super::{
    last_segment, parse_json, path_segment_before, ApprovalSummary, RequestSummarizer,
    SummaryRequest,
};

pub(super) struct GoogleCalendar;

impl RequestSummarizer for GoogleCalendar {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let m = req.method_upper();
        let base = req.base_path();
        // Everything lives under `/calendar/v3/`; `rest` is the path after it.
        let rest = base.split("/calendar/v3/").nth(1)?;

        // Route by resource (specific → general), then by method in the helper.
        if rest.starts_with("freeBusy") {
            return Some(ApprovalSummary::new("Query free/busy"));
        }
        if rest.starts_with("colors") {
            return Some(ApprovalSummary::new("Read calendar colors"));
        }
        if rest.starts_with("channels/stop") {
            return Some(ApprovalSummary::new("Stop calendar notifications"));
        }
        if rest.starts_with("users/me/calendarList") {
            return calendar_list(&m, base);
        }
        if rest.starts_with("users/me/settings") {
            return settings(&m, base);
        }
        if rest.contains("/events") {
            return events(&m, base, req);
        }
        if rest.contains("/acl") {
            return acl(&m, base, req);
        }
        if base.ends_with("/clear") {
            return Some(id_summary(
                "Clear calendar",
                "Calendar",
                path_segment_before(base, "/clear"),
            ));
        }
        if rest.starts_with("calendars") {
            return calendars(&m, base, req);
        }
        None
    }
}

// ── Resources ────────────────────────────────────────────────────────────────

fn events(m: &str, base: &str, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
    // Action sub-paths win over the bare collection / item.
    if base.ends_with("/events/watch") {
        return Some(ApprovalSummary::new("Watch calendar events"));
    }
    if base.ends_with("/quickAdd") {
        return Some(ApprovalSummary::new("Quick-add calendar event"));
    }
    if base.ends_with("/import") {
        return Some(event_with_body("Import calendar event", req));
    }
    if base.ends_with("/move") {
        return Some(id_summary(
            "Move calendar event",
            "Event",
            path_segment_before(base, "/move"),
        ));
    }
    if base.ends_with("/instances") {
        return Some(id_summary(
            "List event instances",
            "Event",
            path_segment_before(base, "/instances"),
        ));
    }

    let is_collection = base.ends_with("/events");
    match m {
        "POST" => Some(event_with_body("Create calendar event", req)),
        "GET" if is_collection => Some(ApprovalSummary::new("List calendar events")),
        "GET" => Some(id_summary(
            "Read calendar event",
            "Event",
            last_segment(base),
        )),
        "PUT" | "PATCH" => {
            let mut s = id_summary("Update calendar event", "Event", last_segment(base));
            if let Some(v) = req.body.and_then(parse_json) {
                extract_event_fields(&mut s, &v);
            }
            Some(s)
        }
        "DELETE" => Some(id_summary(
            "Delete calendar event",
            "Event",
            last_segment(base),
        )),
        _ => None,
    }
}

fn acl(m: &str, base: &str, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
    if base.ends_with("/acl/watch") {
        return Some(ApprovalSummary::new("Watch calendar sharing"));
    }
    let is_collection = base.ends_with("/acl");
    match m {
        "GET" if is_collection => Some(ApprovalSummary::new("List calendar sharing rules")),
        "GET" => Some(id_summary("Read sharing rule", "Rule", last_segment(base))),
        "POST" => {
            let mut s = ApprovalSummary::new("Share calendar");
            extract_acl_fields(&mut s, req);
            Some(s)
        }
        "PUT" | "PATCH" => {
            let mut s = id_summary("Update sharing rule", "Rule", last_segment(base));
            extract_acl_fields(&mut s, req);
            Some(s)
        }
        "DELETE" => Some(id_summary(
            "Remove sharing rule",
            "Rule",
            last_segment(base),
        )),
        _ => None,
    }
}

fn calendar_list(m: &str, base: &str) -> Option<ApprovalSummary> {
    if base.ends_with("/calendarList/watch") {
        return Some(ApprovalSummary::new("Watch calendar list"));
    }
    let is_collection = base.ends_with("/calendarList");
    Some(match m {
        "GET" if is_collection => ApprovalSummary::new("List calendars"),
        "GET" => id_summary("Read calendar list entry", "Calendar", last_segment(base)),
        "POST" => ApprovalSummary::new("Add calendar to list"),
        "PUT" | "PATCH" => id_summary("Update calendar list entry", "Calendar", last_segment(base)),
        "DELETE" => id_summary("Remove calendar from list", "Calendar", last_segment(base)),
        _ => return None,
    })
}

fn settings(m: &str, base: &str) -> Option<ApprovalSummary> {
    if base.ends_with("/settings/watch") {
        return Some(ApprovalSummary::new("Watch calendar settings"));
    }
    if m != "GET" {
        return None;
    }
    Some(if base.ends_with("/settings") {
        ApprovalSummary::new("List calendar settings")
    } else {
        id_summary("Read calendar setting", "Setting", last_segment(base))
    })
}

fn calendars(m: &str, base: &str, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
    match m {
        "POST" => {
            let mut s = ApprovalSummary::new("Create calendar");
            push_body_str(&mut s, req, "summary", "Title");
            Some(s)
        }
        "GET" => Some(id_summary("Read calendar", "Calendar", last_segment(base))),
        "PUT" | "PATCH" => {
            let mut s = id_summary("Update calendar", "Calendar", last_segment(base));
            push_body_str(&mut s, req, "summary", "Title");
            Some(s)
        }
        "DELETE" => Some(id_summary(
            "Delete calendar",
            "Calendar",
            last_segment(base),
        )),
        _ => None,
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// A summary with one optional id detail (`label: id`).
fn id_summary(action: &str, label: &str, id: Option<&str>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(action);
    if let Some(id) = id {
        s.push(label, id);
    }
    s
}

/// A summary whose details come from an event JSON body (create/import).
fn event_with_body(action: &str, req: &SummaryRequest<'_>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(action);
    if let Some(v) = req.body.and_then(parse_json) {
        extract_event_fields(&mut s, &v);
    }
    s
}

/// Lift the human-relevant event fields onto the card.
fn extract_event_fields(s: &mut ApprovalSummary, v: &Value) {
    push_json_str(s, v, "summary", "Title");
    push_json_str(s, v, "location", "Location");
    if let Some(start) = event_time(v, "start") {
        s.push("Start", start);
    }
    if let Some(end) = event_time(v, "end") {
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

/// Lift an ACL rule's `role` and `scope.value` (who it's shared with).
fn extract_acl_fields(s: &mut ApprovalSummary, req: &SummaryRequest<'_>) {
    if let Some(v) = req.body.and_then(parse_json) {
        push_json_str(s, &v, "role", "Role");
        if let Some(who) = v
            .get("scope")
            .and_then(|sc| sc.get("value"))
            .and_then(|x| x.as_str())
        {
            s.push("Who", who);
        }
    }
}

/// Push `label: <v[key]>` when `key` is a present string.
fn push_json_str(s: &mut ApprovalSummary, v: &Value, key: &str, label: &str) {
    if let Some(val) = v.get(key).and_then(|x| x.as_str()) {
        s.push(label, val);
    }
}

/// Parse the body and push a single string field `label: <body[key]>`.
fn push_body_str(s: &mut ApprovalSummary, req: &SummaryRequest<'_>, key: &str, label: &str) {
    if let Some(v) = req.body.and_then(parse_json) {
        push_json_str(s, &v, key, label);
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

    const EVENTS: &str = "/calendar/v3/calendars/primary/events";

    // ── Events ──

    #[test]
    fn create_event_extracts_fields() {
        let body = br#"{"summary":"Team sync","location":"Room 4","start":{"dateTime":"2026-06-20T15:00:00Z"},"attendees":[{"email":"x@y.com"},{"email":"z@y.com"}]}"#;
        let s = summarize("POST", EVENTS, Some(body));
        assert_eq!(s.action, "Create calendar event");
        assert_eq!(detail(&s, "Title"), Some("Team sync"));
        assert_eq!(detail(&s, "Location"), Some("Room 4"));
        assert_eq!(detail(&s, "Start"), Some("2026-06-20T15:00:00Z"));
        assert_eq!(detail(&s, "Attendees"), Some("x@y.com, z@y.com"));
    }

    #[test]
    fn all_day_event_uses_date() {
        let body =
            br#"{"summary":"Holiday","start":{"date":"2026-12-25"},"end":{"date":"2026-12-26"}}"#;
        let s = summarize("POST", EVENTS, Some(body));
        assert_eq!(detail(&s, "Start"), Some("2026-12-25"));
        assert_eq!(detail(&s, "End"), Some("2026-12-26"));
    }

    #[test]
    fn delete_event_uses_path_id() {
        let s = summarize("DELETE", &format!("{EVENTS}/evt123"), None);
        assert_eq!(s.action, "Delete calendar event");
        assert_eq!(detail(&s, "Event"), Some("evt123"));
    }

    #[test]
    fn list_events() {
        let s = summarize("GET", EVENTS, None);
        assert_eq!(s.action, "List calendar events");
    }

    #[test]
    fn read_event_by_id() {
        let s = summarize("GET", &format!("{EVENTS}/evt123"), None);
        assert_eq!(s.action, "Read calendar event");
        assert_eq!(detail(&s, "Event"), Some("evt123"));
    }

    #[test]
    fn move_event_uses_path_id() {
        let s = summarize("POST", &format!("{EVENTS}/evt123/move"), None);
        assert_eq!(s.action, "Move calendar event");
        assert_eq!(detail(&s, "Event"), Some("evt123"));
    }

    #[test]
    fn quick_add_event() {
        let s = summarize("POST", &format!("{EVENTS}/quickAdd"), None);
        assert_eq!(s.action, "Quick-add calendar event");
    }

    #[test]
    fn list_event_instances() {
        let s = summarize("GET", &format!("{EVENTS}/evt123/instances"), None);
        assert_eq!(s.action, "List event instances");
        assert_eq!(detail(&s, "Event"), Some("evt123"));
    }

    // ── Calendars ──

    #[test]
    fn create_calendar_extracts_title() {
        let body = br#"{"summary":"Project X"}"#;
        let s = summarize("POST", "/calendar/v3/calendars", Some(body));
        assert_eq!(s.action, "Create calendar");
        assert_eq!(detail(&s, "Title"), Some("Project X"));
    }

    #[test]
    fn clear_calendar_uses_path_id() {
        let s = summarize("POST", "/calendar/v3/calendars/primary/clear", None);
        assert_eq!(s.action, "Clear calendar");
        assert_eq!(detail(&s, "Calendar"), Some("primary"));
    }

    // ── CalendarList ──

    #[test]
    fn list_calendars() {
        let s = summarize("GET", "/calendar/v3/users/me/calendarList", None);
        assert_eq!(s.action, "List calendars");
    }

    // ── Acl ──

    #[test]
    fn share_calendar_extracts_role_and_who() {
        let body = br#"{"role":"reader","scope":{"type":"user","value":"a@b.com"}}"#;
        let s = summarize("POST", "/calendar/v3/calendars/primary/acl", Some(body));
        assert_eq!(s.action, "Share calendar");
        assert_eq!(detail(&s, "Role"), Some("reader"));
        assert_eq!(detail(&s, "Who"), Some("a@b.com"));
    }

    #[test]
    fn list_acl_rules() {
        let s = summarize("GET", "/calendar/v3/calendars/primary/acl", None);
        assert_eq!(s.action, "List calendar sharing rules");
    }

    // ── FreeBusy / Colors ──

    #[test]
    fn freebusy_query() {
        let s = summarize("POST", "/calendar/v3/freeBusy", Some(b"{}"));
        assert_eq!(s.action, "Query free/busy");
    }

    #[test]
    fn read_colors() {
        let s = summarize("GET", "/calendar/v3/colors", None);
        assert_eq!(s.action, "Read calendar colors");
    }
}
