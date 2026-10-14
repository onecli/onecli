//! Zoom: manual-approval summaries for meetings.
//!
//! A scheduled meeting reads like the calendar event it becomes (title,
//! start, invitees), so cards lay it out with the same event preview.
//! Zoom's body carries a `start_time` plus a `duration` in minutes; the card
//! shows `Start` as written (with the body's `timezone` when the time has no
//! offset) and the `Duration`, never a computed end in a zone it would have
//! to guess. A change to one occurrence of a recurring meeting says so: without
//! `occurrence_id`, Zoom changes or deletes the whole series. Registered as the
//! `"zoom"` summarizer in [`super::summarizer`].

use serde_json::{Map, Value};

use super::{
    decode_segment, json_object, one_line, ApprovalSummary, RequestSummarizer, SummaryKind,
    SummaryRequest, MAX_VALUE_LEN,
};

pub(super) struct Zoom;

/// Most invitee emails listed before the rest collapse to "+N more".
const MAX_INVITEES: usize = 10;

impl RequestSummarizer for Zoom {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let segs: Vec<&str> = req
            .base_path()
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let m = req.method_upper();
        let body = req.body.and_then(json_object);
        let occurrence = req.query_param("occurrence_id").filter(|o| !o.is_empty());
        match (m.as_str(), segs.as_slice()) {
            ("POST", ["v2", "users", user, "meetings"]) => {
                let mut s =
                    ApprovalSummary::new("Create Zoom meeting").with_kind(SummaryKind::Event);
                push_meeting(&mut s, body.as_ref());
                // Scheduled on someone else's calendar: say whose.
                let host = body
                    .as_ref()
                    .and_then(|b| b.get("schedule_for"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| (*user != "me").then(|| decode_segment(user)));
                if let Some(host) = host {
                    s.push("Host", one_line(&host, MAX_VALUE_LEN));
                }
                Some(s)
            }
            ("PATCH", ["v2", "meetings", id]) => {
                let mut s =
                    target("Update", id, occurrence.as_deref()).with_kind(SummaryKind::Event);
                push_meeting(&mut s, body.as_ref());
                Some(s)
            }
            ("DELETE", ["v2", "meetings", id]) => Some(target("Delete", id, occurrence.as_deref())),
            ("PUT", ["v2", "meetings", id, "status"]) => {
                let verb = match body
                    .as_ref()
                    .and_then(|b| b.get("action"))
                    .and_then(Value::as_str)?
                {
                    "end" => "End",
                    "recover" => "Recover",
                    _ => return None,
                };
                Some(target(verb, id, None))
            }
            _ => None,
        }
    }
}

/// A card about meeting `id`, led by WHICH meeting: the one occurrence a
/// change names, or (with none) the whole meeting, every occurrence of a
/// recurring one included.
fn target(verb: &str, id: &str, occurrence: Option<&str>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(match occurrence {
        Some(_) => format!("{verb} Zoom meeting occurrence"),
        None => format!("{verb} Zoom meeting"),
    });
    s.push("Meeting ID", id);
    if let Some(occurrence) = occurrence {
        s.push("Occurrence", one_line(occurrence, MAX_VALUE_LEN));
    }
    s
}

/// A created or updated meeting's body, as an event: the rows the event
/// preview lays out (`Title`, `Start`), then what it has no slot for.
fn push_meeting(s: &mut ApprovalSummary, body: Option<&Map<String, Value>>) {
    let Some(b) = body else { return };
    let str_of = |k: &str| b.get(k).and_then(Value::as_str).map(str::trim);

    if let Some(topic) = str_of("topic") {
        s.push("Title", topic);
    }
    if let Some(start) = str_of("start_time").filter(|t| !t.is_empty()) {
        s.push("Start", start_with_zone(start, str_of("timezone")));
    }
    if let Some(minutes) = b.get("duration").and_then(Value::as_u64) {
        s.push("Duration", duration(minutes));
    }
    if let Some(kind) = b.get("type").and_then(Value::as_u64).and_then(meeting_type) {
        s.push("Type", kind);
    }
    if let Some(agenda) = str_of("agenda") {
        s.push("Agenda", agenda);
    }
    let settings = b.get("settings").and_then(Value::as_object);
    if let Some(invitees) = settings.and_then(invitees) {
        s.push("Attendees", invitees);
    }
    // A passcode is a secret: the card says one is set, never what it is.
    if str_of("password").is_some_and(|p| !p.is_empty()) {
        s.push("Passcode", "Set");
    }
    if let Some(settings) = settings {
        push_settings(s, settings);
    }
}

/// `start_time` as written. A time without an offset is local to the body's
/// `timezone` (Zoom's rule), so the zone follows it in parentheses, the same
/// shape the event preview reads for Outlook (`… (Pacific Standard Time)`).
fn start_with_zone(start: &str, zone: Option<&str>) -> String {
    let has_offset = start.ends_with('Z')
        || start
            .rsplit_once('T')
            .is_some_and(|(_, t)| t.contains('+') || t.contains('-'));
    match zone.filter(|z| !z.is_empty() && !has_offset) {
        Some(zone) => format!("{start} ({zone})"),
        None => start.to_string(),
    }
}

/// `90` → "1 h 30 min", `45` → "45 min", `120` → "2 h".
fn duration(minutes: u64) -> String {
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// Zoom's numeric meeting types, spelled out. Scheduled (`2`) is the norm
/// and needs no row.
fn meeting_type(t: u64) -> Option<&'static str> {
    match t {
        1 => Some("Instant"),
        3 => Some("Recurring, no fixed time"),
        8 => Some("Recurring"),
        10 => Some("Screen share only"),
        _ => None,
    }
}

/// `settings.meeting_invitees[].email`, comma-joined, capped.
fn invitees(settings: &Map<String, Value>) -> Option<String> {
    let all: Vec<&str> = settings
        .get("meeting_invitees")?
        .as_array()?
        .iter()
        .filter_map(|i| i.get("email")?.as_str())
        .filter(|e| !e.is_empty())
        .collect();
    if all.is_empty() {
        return None;
    }
    let mut out = all
        .iter()
        .take(MAX_INVITEES)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    if all.len() > MAX_INVITEES {
        out.push_str(&format!(" +{} more", all.len() - MAX_INVITEES));
    }
    Some(out)
}

/// The settings an approver weighs (who gets in, and what is recorded), only
/// when the request sets them.
fn push_settings(s: &mut ApprovalSummary, settings: &Map<String, Value>) {
    let flag = |k: &str| settings.get(k).and_then(Value::as_bool);
    if let Some(on) = flag("waiting_room") {
        s.push("Waiting room", on_off(on));
    }
    if let Some(on) = flag("join_before_host") {
        s.push("Join before host", on_off(on));
    }
    if let Some(record) = settings.get("auto_recording").and_then(Value::as_str) {
        let label = match record {
            "local" => "On this computer",
            "cloud" => "To the cloud",
            "none" => "Off",
            _ => return,
        };
        s.push("Auto recording", label);
    }
}

fn on_off(on: bool) -> &'static str {
    if on {
        "On"
    } else {
        "Off"
    }
}

#[cfg(test)]
mod tests {
    use super::super::summarize_request;
    use super::*;

    fn zoom(method: &str, path: &str, body: Option<&str>) -> ApprovalSummary {
        summarize_request(
            "zoom",
            method,
            path,
            Some("application/json"),
            body.map(str::as_bytes),
        )
    }

    fn rows(s: &ApprovalSummary) -> Vec<(&str, &str)> {
        s.details
            .iter()
            .map(|d| (d.label.as_str(), d.value.as_str()))
            .collect()
    }

    #[test]
    fn a_scheduled_meeting_reads_as_an_event() {
        let s = zoom(
            "POST",
            "/v2/users/me/meetings",
            Some(
                r#"{"topic":"Pipeline review","type":2,"start_time":"2026-10-12T15:00:00",
                "timezone":"America/New_York","duration":90,"agenda":"Q4 deals",
                "password":"hunter2","settings":{"waiting_room":true,"join_before_host":false,
                "auto_recording":"cloud","meeting_invitees":[{"email":"alex@example.com"},
                {"email":"sam@example.com"}]}}"#,
            ),
        );
        assert_eq!(s.action, "Create Zoom meeting");
        assert_eq!(s.kind, Some(SummaryKind::Event));
        assert_eq!(
            rows(&s),
            [
                ("Title", "Pipeline review"),
                ("Start", "2026-10-12T15:00:00 (America/New_York)"),
                ("Duration", "1 h 30 min"),
                ("Agenda", "Q4 deals"),
                ("Attendees", "alex@example.com, sam@example.com"),
                ("Passcode", "Set"),
                ("Waiting room", "On"),
                ("Join before host", "Off"),
                ("Auto recording", "To the cloud"),
            ]
        );
        assert!(!s.render_text().contains("hunter2"), "passcode never shown");
    }

    #[test]
    fn a_start_with_its_own_offset_keeps_it_and_drops_the_zone() {
        for start in ["2026-10-12T15:00:00Z", "2026-10-12T15:00:00-04:00"] {
            let body = format!(r#"{{"start_time":"{start}","timezone":"Asia/Tokyo"}}"#);
            let s = zoom("POST", "/v2/users/me/meetings", Some(&body));
            assert_eq!(rows(&s), [("Start", start)]);
        }
    }

    #[test]
    fn durations_and_types_read_in_words() {
        assert_eq!(duration(45), "45 min");
        assert_eq!(duration(120), "2 h");
        assert_eq!(duration(61), "1 h 1 min");
        let s = zoom("POST", "/v2/users/me/meetings", Some(r#"{"type":8}"#));
        assert_eq!(rows(&s), [("Type", "Recurring")]);
    }

    #[test]
    fn invitees_are_capped() {
        let list: Vec<String> = (0..13)
            .map(|i| format!(r#"{{"email":"p{i}@example.com"}}"#))
            .collect();
        let body = format!(
            r#"{{"settings":{{"meeting_invitees":[{}]}}}}"#,
            list.join(",")
        );
        let s = zoom("POST", "/v2/users/me/meetings", Some(&body));
        let attendees = rows(&s)[0].1.to_string();
        assert!(attendees.starts_with("p0@example.com, "));
        assert!(attendees.ends_with("p9@example.com +3 more"));
    }

    #[test]
    fn update_delete_and_end_name_the_meeting() {
        let s = zoom(
            "PATCH",
            "/v2/meetings/81234567890",
            Some(r#"{"topic":"Moved"}"#),
        );
        assert_eq!(s.action, "Update Zoom meeting");
        assert_eq!(
            rows(&s),
            [("Meeting ID", "81234567890"), ("Title", "Moved")]
        );
        let s = zoom(
            "DELETE",
            "/v2/meetings/81234567890?schedule_for_reminder=true",
            None,
        );
        assert_eq!(s.action, "Delete Zoom meeting");
        assert_eq!(rows(&s), [("Meeting ID", "81234567890")]);
        let s = zoom(
            "PUT",
            "/v2/meetings/81234567890/status",
            Some(r#"{"action":"end"}"#),
        );
        assert_eq!(s.action, "End Zoom meeting");
        let s = zoom(
            "PUT",
            "/v2/meetings/81234567890/status",
            Some(r#"{"action":"recover"}"#),
        );
        assert_eq!(s.action, "Recover Zoom meeting");
    }

    /// Without `occurrence_id` Zoom changes or deletes the whole series, so
    /// a card for one occurrence says so, and names it.
    #[test]
    fn one_occurrence_reads_apart_from_the_whole_series() {
        let s = zoom(
            "DELETE",
            "/v2/meetings/81234567890?occurrence_id=1648194360000",
            None,
        );
        assert_eq!(s.action, "Delete Zoom meeting occurrence");
        assert_eq!(
            rows(&s),
            [
                ("Meeting ID", "81234567890"),
                ("Occurrence", "1648194360000")
            ]
        );
        let s = zoom(
            "PATCH",
            "/v2/meetings/81234567890?occurrence_id=1648194360000",
            Some(r#"{"duration":30}"#),
        );
        assert_eq!(s.action, "Update Zoom meeting occurrence");
        assert_eq!(rows(&s)[2], ("Duration", "30 min"));
    }

    /// A meeting scheduled for another user says whose it is.
    #[test]
    fn a_meeting_for_another_user_names_the_host() {
        let s = zoom("POST", "/v2/users/sam%40example.com/meetings", Some("{}"));
        assert_eq!(rows(&s), [("Host", "sam@example.com")]);
        let s = zoom(
            "POST",
            "/v2/users/me/meetings",
            Some(r#"{"topic":"Sync","schedule_for":"dana@example.com"}"#),
        );
        assert_eq!(rows(&s), [("Title", "Sync"), ("Host", "dana@example.com")]);
    }

    #[test]
    fn other_endpoints_fall_back_to_the_generic_card() {
        let s = zoom("POST", "/v2/users/me/webinars", Some(r#"{"topic":"x"}"#));
        assert_eq!(s.action, "POST request");
        // A status change this module can't name reads as what was sent.
        let s = zoom(
            "PUT",
            "/v2/meetings/81234567890/status",
            Some(r#"{"action":"pause"}"#),
        );
        assert_eq!(s.action, "PUT request");
        let s = zoom("POST", "/v2/users/me/meetings", Some("not json"));
        assert_eq!(s.action, "Create Zoom meeting");
        assert!(s.details.is_empty());
    }
}
