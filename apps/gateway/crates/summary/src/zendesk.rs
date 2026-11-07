//! Zendesk action names and consequences on top of the shared, redacted body renderer.

use serde_json::Value;

use super::{
    clamp, decode_segment, generic, parse_json, ApprovalSummary, RequestSummarizer, SummaryRequest,
    MAX_VALUE_LEN,
};

pub(super) struct Zendesk;

/// Normalize only the API suffix, not arbitrary occurrences of `.json`.
fn segments(path: &str) -> Option<Vec<String>> {
    let rest = path.strip_prefix("/api/v2/")?;
    let mut segs: Vec<String> = rest
        .split('/')
        .filter(|s| !s.is_empty())
        .map(decode_segment)
        .collect();
    if let Some(last) = segs.last_mut() {
        if let Some(stem) = last.strip_suffix(".json") {
            *last = stem.to_string();
        }
    }
    Some(segs)
}

// Ticket and user IDs are numeric. Collection actions must never become record IDs.
fn is_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Clone, Copy)]
enum Visibility {
    Public,
    Internal,
    Unverified,
}

/// Only infer visibility from a nonempty comment and a valid boolean flag.
fn visibility(ticket: &Value) -> Option<Visibility> {
    let comment = ticket.get("comment")?.as_object()?;
    if !["body", "html_body"].iter().any(|key| {
        comment
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    }) {
        return comment
            .contains_key("public")
            .then_some(Visibility::Unverified);
    }
    match comment.get("public") {
        None | Some(Value::Bool(true)) => Some(Visibility::Public),
        Some(Value::Bool(false)) => Some(Visibility::Internal),
        Some(_) => Some(Visibility::Unverified),
    }
}

fn ticket_action(id: &str, ticket: Option<&Value>) -> String {
    let status = ticket.and_then(|t| t.get("status")).and_then(Value::as_str);
    let visibility = ticket.and_then(visibility);
    let verb = match (visibility, status) {
        (Some(Visibility::Public), Some("solved")) => "Reply to and solve",
        (Some(Visibility::Public), _) => "Reply to",
        (Some(Visibility::Internal), Some("solved")) => "Add internal note to and solve",
        (Some(Visibility::Internal), _) => "Add internal note to",
        (_, Some("solved")) => "Solve",
        (_, Some("closed")) => "Close",
        _ => "Update",
    };
    format!("{verb} ticket #{id}")
}

impl RequestSummarizer for Zendesk {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let segs = segments(req.base_path())?;
        let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
        let method = req.method_upper();
        let body = req.body.and_then(parse_json);
        let ticket = body.as_ref().and_then(|b| b.get("ticket"));
        let action = match (method.as_str(), segs.as_slice()) {
            ("POST", ["tickets"]) => "Create ticket".into(),
            ("POST", ["tickets", "create_many"]) => "Create several tickets".into(),
            ("PUT", ["tickets", "update_many"]) => "Update several tickets".into(),
            ("DELETE", ["tickets", "destroy_many"]) => "Delete several tickets".into(),
            ("PUT", ["tickets", "mark_many_as_spam"]) => "Mark several tickets as spam".into(),
            ("PUT", ["tickets", id]) if is_id(id) => ticket_action(id, ticket),
            ("DELETE", ["tickets", id]) if is_id(id) => format!("Delete ticket #{id}"),
            ("PUT", ["tickets", id, "mark_as_spam"]) if is_id(id) => {
                format!("Mark ticket #{id} as spam")
            }
            ("POST", ["tickets", id, "merge"]) if is_id(id) => {
                format!("Merge into ticket #{id}")
            }
            ("GET", ["tickets"]) => "List tickets".into(),
            ("GET", ["tickets", id]) if is_id(id) => format!("Read ticket #{id}"),
            ("GET", ["tickets", id, "comments"]) if is_id(id) => {
                format!("Read the conversation on ticket #{id}")
            }
            ("GET", ["search"]) => "Search Zendesk".into(),
            ("POST", ["users"]) => "Create user".into(),
            ("PUT", ["users", id]) if is_id(id) => format!("Update user #{id}"),
            ("DELETE", ["users", id]) if is_id(id) => format!("Delete user #{id}"),
            ("POST", ["help_center", .., "sections", _, "articles"]) => {
                "Create Help Center article".into()
            }
            _ => return None,
        };
        // Keep every body/query field, change hint, bound and redaction from generic.
        let mut summary = generic::summarize(req);
        let generic_details = std::mem::take(&mut summary.details);
        summary.action = clamp(&action, MAX_VALUE_LEN);
        if method == "PUT" && matches!(segs.last(), Some(&"mark_as_spam" | &"mark_many_as_spam")) {
            summary.push(
                "Consequences",
                "Deletes tickets and suspends their requesters",
            );
        }
        if method == "POST" && segs.last() == Some(&"merge") {
            summary.push(
                "Consequences",
                "Closes source tickets. Merging cannot be undone",
            );
        }
        if matches!(method.as_str(), "POST" | "PUT") && segs.first() == Some(&"tickets") {
            // One bounded annotation covers mixed batches without claiming a count.
            let mut public = false;
            let mut internal = false;
            let mut unverified = false;
            let tickets = body
                .as_ref()
                .and_then(|b| b.get("tickets"))
                .and_then(Value::as_array);
            for ticket in ticket.into_iter().chain(tickets.into_iter().flatten()) {
                match visibility(ticket) {
                    Some(Visibility::Public) => public = true,
                    Some(Visibility::Internal) => internal = true,
                    Some(_) => unverified = true,
                    None => {}
                }
            }
            if public || internal || unverified {
                let value = if unverified {
                    "Includes comments with unverified visibility"
                } else if public && internal {
                    "Public replies (customer-visible) and internal notes (agents only)"
                } else if public {
                    "Public, the customer sees it"
                } else {
                    "Internal, agents only"
                };
                summary.push("Visibility", value);
            }
        }
        if method == "POST" && segs.first() == Some(&"help_center") {
            if let Some(article) = body
                .as_ref()
                .and_then(|b| b.get("article"))
                .and_then(Value::as_object)
            {
                summary.push(
                    "Publication",
                    match article.get("draft") {
                        None | Some(Value::Bool(false)) => "Published",
                        Some(Value::Bool(true)) => "Draft",
                        Some(_) => "Unverified publication status",
                    },
                );
                summary.push("Visibility", "Follows article and section access settings");
            }
        }
        // Safety annotations must survive render_text's total budget. Preserve all
        // generic rows after them and move the record-row range along with its rows.
        let annotation_count = summary.details.len();
        summary.details.extend(generic_details);
        if let Some(range) = &mut summary.fallback {
            range.start += annotation_count;
            range.end += annotation_count;
        }
        for record in &mut summary.refs {
            record.detail_index += annotation_count;
        }
        Some(summary)
    }
}

#[cfg(test)]
mod tests {
    use crate::{summarize_request, ApprovalSummary};

    fn card(method: &str, path: &str, body: &str) -> ApprovalSummary {
        summarize_request(
            "zendesk",
            method,
            path,
            Some("application/json"),
            (!body.is_empty()).then_some(body.as_bytes()),
        )
    }

    fn contains(summary: &ApprovalSummary, expected: &str) {
        assert!(
            summary.details.iter().any(|d| d.value.contains(expected)),
            "{summary:?} missing {expected}"
        );
    }

    #[test]
    fn single_replies_and_solving_keep_nested_fields() {
        let s = card(
            "PUT",
            "/api/v2/tickets/123.json",
            r#"{"ticket":{"comment":{"body":"Refund issued","public":true},"status":"solved","custom_fields":[{"id":9,"value":"reviewed"}]}}"#,
        );
        assert_eq!(s.action, "Reply to and solve ticket #123");
        contains(&s, "Refund issued");
        contains(&s, "reviewed");
        contains(&s, "Public, the customer sees it");
        let s = card(
            "PUT",
            "/api/v2/tickets/7",
            r#"{"ticket":{"comment":{"body":"Billing review","public":false},"status":"solved"}}"#,
        );
        assert_eq!(s.action, "Add internal note to and solve ticket #7");
        contains(&s, "Billing review");
        contains(&s, "Internal, agents only");
        assert_eq!(
            card(
                "PUT",
                "/api/v2/tickets/7",
                r#"{"ticket":{"status":"solved"}}"#
            )
            .action,
            "Solve ticket #7"
        );
    }

    #[test]
    fn bulk_comments_and_mixed_batches_are_preserved() {
        for public in [true, false] {
            let s = card(
                "PUT",
                "/api/v2/tickets/update_many.json?ids=1,2",
                &format!(
                    r#"{{"ticket":{{"comment":{{"body":"Bulk message","public":{public}}}}}}}"#
                ),
            );
            assert_eq!(s.action, "Update several tickets");
            contains(&s, "Bulk message");
            contains(
                &s,
                if public {
                    "Public, the customer sees it"
                } else {
                    "Internal, agents only"
                },
            );
        }
        for (method, route) in [("PUT", "update_many"), ("POST", "create_many")] {
            let s = card(
                method,
                &format!("/api/v2/tickets/{route}"),
                r#"{"tickets":[{"id":1,"comment":{"body":"Customer message","public":true}},{"id":2,"comment":{"body":"Agent note","public":false}}]}"#,
            );
            contains(&s, "Customer message");
            contains(&s, "Agent note");
            contains(&s, "Public replies (customer-visible) and internal notes");
            assert!(!s.action.contains('#'));
        }
    }

    #[test]
    fn merge_is_post_and_keeps_both_comments() {
        let body = r#"{"ids":[6,7],"source_comment":"Source note","target_comment":"Target reply","target_comment_is_public":true,"source_comment_is_public":false}"#;
        let s = card("POST", "/api/v2/tickets/5/merge.json", body);
        assert_eq!(s.action, "Merge into ticket #5");
        contains(&s, "Source note");
        contains(&s, "Target reply");
        contains(&s, "cannot be undone");
        assert_eq!(
            card("PUT", "/api/v2/tickets/5/merge.json", body),
            card_for_generic("PUT", "/api/v2/tickets/5/merge.json", body)
        );
    }

    #[test]
    fn spam_explains_both_side_effects_and_bulk_is_not_an_id() {
        for path in [
            "/api/v2/tickets/9/mark_as_spam.json",
            "/api/v2/tickets/mark_many_as_spam.json?ids=1,2",
        ] {
            let s = card("PUT", path, "{}");
            contains(&s, "Deletes tickets and suspends their requesters");
            assert!(!s.action.contains("#mark_many"));
        }
        assert_eq!(
            card("DELETE", "/api/v2/tickets/destroy_many", "").action,
            "Delete several tickets"
        );
    }

    #[test]
    fn user_security_and_unknown_fields_are_not_projected_away() {
        let s = card(
            "PUT",
            "/api/v2/users/42.json",
            r#"{"user":{"role":"admin","suspended":false,"verified":true,"custom_role_id":8,"user_fields":{"permission":"elevated"},"new_field":"retained","password":"never-show-this"}}"#,
        );
        contains(&s, "admin");
        contains(&s, "false");
        contains(&s, "true");
        contains(&s, "elevated");
        contains(&s, "retained");
        assert!(!s.render_text().contains("never-show-this"));
    }

    #[test]
    fn truncated_and_invalid_bodies_do_not_invent_changes_or_counts() {
        for body in [
            r#"{"tickets":[{"comment":{"body":"secret","public":false}}"#,
            "not json",
        ] {
            let s = card("PUT", "/api/v2/tickets/update_many", body);
            assert_eq!(s.action, "Update several tickets");
            contains(&s, "JSON");
            assert!(!s.render_text().contains("secret"));
            assert!(!s
                .details
                .iter()
                .any(|d| d.label == "Visibility" || d.label == "More"));
        }
    }

    fn card_for_generic(method: &str, path: &str, body: &str) -> ApprovalSummary {
        summarize_request(
            "unknown",
            method,
            path,
            Some("application/json"),
            (!body.is_empty()).then_some(body.as_bytes()),
        )
    }

    #[test]
    fn default_visibility_html_and_invalid_flags_are_conservative() {
        let s = card(
            "PUT",
            "/api/v2/tickets/1",
            r#"{"ticket":{"comment":{"html_body":"<p>Reply</p>"}}}"#,
        );
        assert_eq!(s.action, "Reply to ticket #1");
        contains(&s, "Public, the customer sees it");
        for comment in [
            r#"{"body":"Note","public":"false"}"#,
            r#"{"public":false}"#,
            "{}",
        ] {
            let s = card(
                "PUT",
                "/api/v2/tickets/1",
                &format!(r#"{{"ticket":{{"comment":{comment}}}}}"#),
            );
            assert_eq!(s.action, "Update ticket #1");
            assert!(!s
                .details
                .iter()
                .any(|d| d.label == "Visibility" && d.value == "Internal, agents only"));
        }
    }

    #[test]
    fn known_routes_preserve_all_generic_rows_and_bounds() {
        for (method, path, body) in [
            (
                "POST",
                "/api/v2/tickets.json?async=true",
                r#"{"ticket":{"subject":"Sample","requester":{"email":"person@example.test","name":"Example"},"unknown":{"nested":"retained"}}}"#,
            ),
            (
                "POST",
                "/api/v2/help_center/en-us/sections/360/articles.json",
                r#"{"article":{"title":"Guide","body":"Instructions","draft":false,"unknown":"retained"}}"#,
            ),
            (
                "PUT",
                "/api/v2/users/42.json",
                r#"{"user":{"suspended":false,"role":"admin","custom_role_id":8}}"#,
            ),
            (
                "PUT",
                "/api/v2/tickets/update_many",
                r#"{"tickets":[{"id":1,"unknown":"kept"},{"id":2,"status":"solved"}]}"#,
            ),
        ] {
            let s = card(method, path, body);
            let generic = card_for_generic(method, path, body);
            assert!(s.details.ends_with(&generic.details));
        }
        let body = serde_json::json!({"ticket": {"comment": {"body": "x".repeat(9000)}, "password": "hidden"}}).to_string();
        let s = card("PUT", "/api/v2/tickets/1?access_token=hidden", &body);
        assert!(s.details.ends_with(
            &card_for_generic("PUT", "/api/v2/tickets/1?access_token=hidden", &body).details
        ));
        assert!(!s.render_text().contains("hidden"));
        assert!(s.render_text().chars().count() <= crate::MAX_RENDER_LEN);
        let s = card(
            "PUT",
            &format!("/api/v2/tickets/{}", "1".repeat(2000)),
            "{}",
        );
        assert!(s.action.chars().count() <= crate::MAX_VALUE_LEN);
    }

    #[test]
    fn safety_annotations_survive_long_body_rendering() {
        let long = "A long prose sentence. ".repeat(400);
        for (method, path, body, warning) in [
            (
                "PUT",
                "/api/v2/tickets/1",
                serde_json::json!({"ticket":{"comment":{"body":long,"public":false},"description":long}}),
                "Internal, agents only",
            ),
            (
                "PUT",
                "/api/v2/tickets/mark_many_as_spam?ids=1,2",
                serde_json::json!({"description":long,"body":long}),
                "Deletes tickets and suspends their requesters",
            ),
            (
                "POST",
                "/api/v2/tickets/5/merge",
                serde_json::json!({"ids":[6,7],"source_comment":long,"target_comment":long}),
                "Merging cannot be undone",
            ),
        ] {
            let body = body.to_string();
            let s = card(method, path, &body);
            let generic = card_for_generic(method, path, &body);
            assert!(s.details.ends_with(&generic.details));
            assert!(s.render_text().contains(warning));
            assert!(s.render_text().chars().count() <= crate::MAX_RENDER_LEN);
            let offset = s.details.len() - generic.details.len();
            assert!(offset > 0);
            if let (Some(actual), Some(original)) = (&s.fallback, &generic.fallback) {
                assert_eq!(actual.start, original.start + offset);
                assert_eq!(actual.end, original.end + offset);
            }
        }
    }

    #[test]
    fn articles_default_to_published_without_claiming_unrestricted_access() {
        let path = "/api/v2/help_center/en-us/sections/360/articles.json";
        for (draft, publication) in [
            (None, "Published"),
            (Some(false), "Published"),
            (Some(true), "Draft"),
        ] {
            let mut article =
                serde_json::json!({"title":"Guide","body":"Instructions","user_segment_id":123});
            if let Some(draft) = draft {
                article["draft"] = serde_json::json!(draft);
            }
            let body = serde_json::json!({"article":article}).to_string();
            let s = card("POST", path, &body);
            assert_eq!(s.details[0].label, "Publication");
            assert_eq!(s.details[0].value, publication);
            assert_eq!(
                s.details[1].value,
                "Follows article and section access settings"
            );
            assert!(s
                .details
                .ends_with(&card_for_generic("POST", path, &body).details));
            assert!(!s.render_text().contains("everyone"));
        }
        let s = card("POST", path, r#"{"article":{"draft":"false"}}"#);
        contains(&s, "Unverified publication status");
        let s = card("POST", path, r#"{"article":{"draft":false"#);
        assert!(!s.details.iter().any(|d| d.label == "Publication"));
    }

    #[test]
    fn enrichment_preserves_internal_and_spam_warnings_and_merge_is_not_read() {
        for (path, body, current, warning) in [
            (
                "/api/v2/tickets/1",
                r#"{"ticket":{"comment":{"body":"Internal escalation","public":false},"status":"pending"}}"#,
                r#"{"ticket":{"comment":{"body":"Prior note","public":false},"status":"open"}}"#,
                "Internal, agents only",
            ),
            (
                "/api/v2/tickets/9/mark_as_spam",
                r#"{"reason":"spam"}"#,
                r#"{"reason":"unclassified"}"#,
                "Deletes tickets and suspends their requesters",
            ),
            (
                "/api/v2/tickets/mark_many_as_spam",
                r#"{"reason":"spam"}"#,
                r#"{"reason":"unclassified"}"#,
                "Deletes tickets and suspends their requesters",
            ),
        ] {
            let mut s = card("PUT", path, body);
            assert!(s.change_hint().is_some());
            s.apply_current(body.as_bytes(), current.as_bytes());
            assert!(s.render_text().contains(warning), "{s:?}");
            assert!(
                s.render_text().contains('→'),
                "comparison must actually run: {s:?}"
            );
            assert_eq!(s.details[0].value, warning);
            if let Some(range) = &s.fallback {
                for row in &s.details[range.clone()] {
                    assert_ne!(row.label, "Visibility");
                    assert_ne!(row.label, "Consequences");
                }
            }
        }
        // A POST merge has no current-state read. Its warning survives the real
        // enrichment API as a no-op, not by inventing a GET for this action.
        let body = r#"{"ids":[6,7],"source_comment":"Source note","target_comment":"Target note"}"#;
        let mut s = card("POST", "/api/v2/tickets/5/merge", body);
        assert!(s.change_hint().is_none());
        let before = s.clone();
        s.apply_current(body.as_bytes(), b"{}");
        assert_eq!(s, before);
        assert!(s.render_text().contains("Merging cannot be undone"));
    }

    #[test]
    fn unsupported_patch_methods_use_generic() {
        for path in ["/api/v2/tickets/1", "/api/v2/users/2"] {
            let body = r#"{"ticket":{"comment":{"body":"Note","public":false}},"user":{"suspended":false}}"#;
            assert_eq!(
                card("PATCH", path, body),
                card_for_generic("PATCH", path, body)
            );
        }
    }

    #[test]
    fn unknown_routes_use_current_generic_fallback() {
        for path in [
            "/api/v2/macros.json",
            "/hc/en-us",
            "/api/v2/tickets/show_many.json?ids=1,2",
        ] {
            assert_eq!(card("GET", path, ""), card_for_generic("GET", path, ""));
        }
    }
}
