//! Google Drive: manual-approval summaries for sharing and deletion.
//!
//! Sharing is the change an approver most needs to read right: WHO gains or
//! loses access to WHICH file. A share names the person in its body (email,
//! domain, or "anyone with the link"), its role in words, and the message
//! Google emails them; removing one names only a permission id, which the
//! gateway resolves to the person through this module's [`RecordResolver`],
//! alongside the file's name. Deleting a file skips the trash, so its card
//! says "Permanently". Registered as the `"google-drive"` summarizer in
//! [`super::summarizer`].

use serde::Deserialize;
use serde_json::{Map, Value};

use super::record_links::is_token;
use super::records::{Named, Target};
use super::{
    json_object, ApprovalSummary, RecordResolver, RequestSummarizer, SummaryRequest,
    MAX_SNIPPET_LEN,
};

pub(super) struct GoogleDrive;

const FILE: &str = "File";
/// A permission on a file: its id is `{file id}/{permission id}`, the only
/// way a lookup can reach it.
const PERMISSION: &str = "Permission";

impl RequestSummarizer for GoogleDrive {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let segs: Vec<&str> = req
            .base_path()
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let m = req.method_upper();
        let body = req.body.and_then(json_object);
        let body = body.as_ref();
        match (m.as_str(), segs.as_slice()) {
            ("POST", ["drive", "v3", "files", file, "permissions"]) => {
                let mut s = file_card("Share", file);
                push_grantee(&mut s, body);
                // What Google emails the person, in full like an email body.
                if let Some(message) = req.query_param("emailMessage") {
                    s.push_clamped("Message", message, MAX_SNIPPET_LEN);
                }
                Some(s)
            }
            ("PATCH", ["drive", "v3", "files", file, "permissions", perm]) => {
                let mut s = file_card("Change access to", file);
                push_person(&mut s, file, perm);
                if let Some(role) = body.and_then(|b| b.get("role")).and_then(Value::as_str) {
                    s.push("New role", role_label(role));
                }
                Some(s)
            }
            ("DELETE", ["drive", "v3", "files", file, "permissions", perm]) => {
                let mut s = file_card("Remove access to", file);
                push_person(&mut s, file, perm);
                Some(s)
            }
            // Not a file: every trashed file, permanently.
            ("DELETE", ["drive", "v3", "files", "trash"]) => {
                let mut s = ApprovalSummary::new("Empty Drive trash");
                if let Some(drive) = req.query_param("driveId").filter(|d| is_token(d)) {
                    s.push("Shared drive", drive);
                }
                Some(s)
            }
            ("DELETE", ["drive", "v3", "files", file]) => {
                Some(file_card("Permanently delete", file))
            }
            _ => None,
        }
    }
}

/// A card about file `file`: its row (named and linked by the gateway),
/// folded into the title once named ("Remove access to file Plan.docx").
fn file_card(action: &str, file: &str) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(action);
    if is_token(file) {
        s.push_named(FILE, FILE, file, file, Named::WithId);
        s.target = Some(Target::of(file, " ", Some("file".into())));
    } else {
        // The title must still read as a sentence.
        s.action = format!("{action} file");
    }
    s
}

/// Who a new share grants access to, from its body.
fn push_grantee(s: &mut ApprovalSummary, body: Option<&Map<String, Value>>) {
    let Some(b) = body else { return };
    let get = |k: &str| b.get(k).and_then(Value::as_str);
    let who = match get("type") {
        Some("anyone") => Some("Anyone with the link".to_string()),
        Some("domain") => get("domain").map(|d| format!("Anyone at {d}")),
        _ => get("emailAddress").map(str::to_string),
    };
    if let Some(who) = who {
        s.push("With", who);
    }
    if let Some(role) = get("role") {
        s.push("Role", role_label(role));
    }
}

/// The person a permission id stands for: named by the gateway as who it
/// is (name and email); until then, the bare permission id.
fn push_person(s: &mut ApprovalSummary, file: &str, perm: &str) {
    if is_token(file) && is_perm_id(perm) {
        let id = format!("{file}/{perm}");
        s.push_named(
            "Who",
            PERMISSION,
            &id,
            format!("Permission {perm}"),
            Named::Alone,
        );
    } else {
        s.push("Permission ID", perm);
    }
}

/// Drive's roles in the words its share dialog uses.
fn role_label(role: &str) -> &str {
    match role {
        "owner" => "Owner",
        "organizer" => "Manager",
        "fileOrganizer" => "Content manager",
        "writer" => "Editor",
        "commenter" => "Commenter",
        "reader" => "Viewer",
        other => other,
    }
}

/// A Drive permission id, in the shapes Drive issues: digits for a person or
/// group (a trailing `k` for a domain), or the link grants. Strict, so a
/// file id can never pass for one.
fn is_perm_id(s: &str) -> bool {
    if matches!(s, "anyoneWithLink" | "anyone") {
        return true;
    }
    let digits = s.strip_suffix('k').unwrap_or(s);
    (1..=32).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
}

// ── Naming the file and the person ───────────────────────────────────────

impl RecordResolver for GoogleDrive {
    fn object_of(&self, id: &str) -> Option<&'static str> {
        match id.split_once('/') {
            Some((file, perm)) => (is_token(file) && is_perm_id(perm)).then_some(PERMISSION),
            None => is_token(id).then_some(FILE),
        }
    }

    /// One read for the first id (a card names one file and at most one
    /// permission), with every segment re-checked, so the path is fully
    /// server-built. Shared drives need `supportsAllDrives`.
    fn names_read(&self, object: &str, ids: &[&str]) -> String {
        let id = ids
            .iter()
            .copied()
            .find(|id| self.object_of(id) == Some(object))
            .unwrap_or("-");
        match (object, id.split_once('/')) {
            (PERMISSION, Some((file, perm))) => format!(
                "/drive/v3/files/{file}/permissions/{perm}\
                 ?supportsAllDrives=true&fields=id,type,emailAddress,domain,displayName"
            ),
            _ => format!("/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name"),
        }
    }

    /// A file answers `{id, name}`; a permission answers who it is, keyed by
    /// its id alone, which the gateway's canonical form matches (see
    /// [`canonical_id`](Self::canonical_id)). Each read only as the object
    /// asked for, so neither answer can name the other.
    fn parse_names(&self, object: &str, body: &[u8]) -> Vec<(String, String)> {
        #[derive(Deserialize)]
        struct File {
            id: String,
            name: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Grantee {
            id: String,
            #[serde(rename = "type")]
            kind: String,
            email_address: Option<String>,
            domain: Option<String>,
            display_name: Option<String>,
        }
        match object {
            FILE => serde_json::from_slice::<File>(body)
                .map(|f| vec![(f.id, f.name)])
                .unwrap_or_default(),
            PERMISSION => {
                let Ok(g) = serde_json::from_slice::<Grantee>(body) else {
                    return Vec::new();
                };
                let who = match g.kind.as_str() {
                    "anyone" => Some("Anyone with the link".to_string()),
                    "domain" => g.domain.map(|d| format!("Anyone at {d}")),
                    _ => match (g.display_name, g.email_address) {
                        (Some(n), Some(e)) if n != e => Some(format!("{n} <{e}>")),
                        (_, Some(e)) => Some(e),
                        (Some(n), None) => Some(n),
                        (None, None) => None,
                    },
                };
                // Who only, never the role: a permission id names the same
                // person on every file (so the cache may share it), but their
                // role differs.
                who.map(|who| vec![(g.id, who)]).unwrap_or_default()
            }
            _ => Vec::new(),
        }
    }

    fn record_url(&self, _host: &str, id: &str) -> Option<String> {
        // A permission has no page of its own; the file does.
        (self.object_of(id) == Some(FILE)).then(|| format!("https://drive.google.com/open?id={id}"))
    }

    /// A permission is asked for as `{file}/{perm}` and answered by `perm`
    /// alone: both read as the permission id.
    fn canonical_id<'a>(&self, id: &'a str) -> &'a str {
        id.split_once('/').map_or(id, |(_, perm)| perm)
    }
}

#[cfg(test)]
mod tests {
    use super::super::summarize_request;
    use super::*;

    const FILE_ID: &str = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const PERM_ID: &str = "01234567890123456789";

    fn drive(method: &str, path: &str, body: Option<&str>) -> ApprovalSummary {
        summarize_request(
            "google-drive",
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

    /// The file keeps its id once named (two files of one name stay apart);
    /// the person reads as who they are, their email already unique.
    #[test]
    fn removing_access_names_the_file_and_the_person_once_resolved() {
        let mut s = drive(
            "DELETE",
            &format!("/drive/v3/files/{FILE_ID}/permissions/{PERM_ID}?supportsAllDrives=true"),
            None,
        );
        assert_eq!(s.action, "Remove access to");
        assert_eq!(
            rows(&s),
            [
                ("File", FILE_ID),
                ("Who", &*format!("Permission {PERM_ID}"))
            ]
        );
        let perm_ref = format!("{FILE_ID}/{PERM_ID}");
        assert_eq!(s.ref_ids().collect::<Vec<_>>(), [FILE_ID, &perm_ref]);

        let r = GoogleDrive;
        s.name_refs(|id| match r.canonical_id(id) {
            id if id == FILE_ID => Some("Plan.docx"),
            id if id == PERM_ID => Some("Dana Reyes <dana@example.com>"),
            _ => None,
        });
        s.finalize_title();
        assert_eq!(s.action, "Remove access to file Plan.docx");
        assert_eq!(
            rows(&s),
            [
                ("File", &*format!("Plan.docx ({FILE_ID})")),
                ("Who", "Dana Reyes <dana@example.com>")
            ]
        );
    }

    #[test]
    fn sharing_says_with_whom_the_role_and_the_message() {
        let path = format!("/drive/v3/files/{FILE_ID}/permissions");
        let s = drive(
            "POST",
            &format!(
                "{path}?sendNotificationEmail=true&emailMessage=Please%20review%20by%20Friday"
            ),
            Some(r#"{"type":"user","role":"writer","emailAddress":"sam@example.com"}"#),
        );
        assert_eq!(s.action, "Share");
        assert_eq!(
            rows(&s),
            [
                ("File", FILE_ID),
                ("With", "sam@example.com"),
                ("Role", "Editor"),
                ("Message", "Please review by Friday")
            ]
        );
        let s = drive("POST", &path, Some(r#"{"type":"anyone","role":"reader"}"#));
        assert_eq!(
            rows(&s)[1..],
            [("With", "Anyone with the link"), ("Role", "Viewer")]
        );
        let s = drive(
            "POST",
            &path,
            Some(r#"{"type":"domain","domain":"example.com","role":"commenter"}"#),
        );
        assert_eq!(rows(&s)[1], ("With", "Anyone at example.com"));
    }

    /// `files.delete` skips the trash (and takes a folder's contents with
    /// it), so the card says "Permanently".
    #[test]
    fn changing_a_role_and_deleting_a_file() {
        let s = drive(
            "PATCH",
            &format!("/drive/v3/files/{FILE_ID}/permissions/{PERM_ID}"),
            Some(r#"{"role":"reader"}"#),
        );
        assert_eq!(s.action, "Change access to");
        assert_eq!(rows(&s)[2], ("New role", "Viewer"));
        let mut s = drive("DELETE", &format!("/drive/v3/files/{FILE_ID}"), None);
        s.finalize_title();
        assert_eq!(s.action, format!("Permanently delete file {FILE_ID}"));
    }

    /// `files/trash` is Drive's empty-trash endpoint, never a file id.
    #[test]
    fn emptying_the_trash_is_no_file_delete() {
        let s = drive("DELETE", "/drive/v3/files/trash", None);
        assert_eq!(s.action, "Empty Drive trash");
        assert_eq!(s.ref_ids().count(), 0);
        let s = drive("DELETE", "/drive/v3/files/trash?driveId=0AbCdEfGhIjK", None);
        assert_eq!(rows(&s), [("Shared drive", "0AbCdEfGhIjK")]);
    }

    #[test]
    fn unsafe_ids_are_never_records_and_other_calls_fall_back() {
        let s = drive("DELETE", "/drive/v3/files/a%2Fb/permissions/1", None);
        assert_eq!(s.action, "Remove access to file");
        assert_eq!(s.ref_ids().count(), 0);
        let s = drive("PATCH", &format!("/drive/v3/files/{FILE_ID}"), Some("{}"));
        assert_eq!(s.action, "PATCH request");
    }

    #[test]
    fn the_name_reads_are_server_built() {
        let r = GoogleDrive;
        let perm = format!("{FILE_ID}/{PERM_ID}");
        assert_eq!(r.object_of(FILE_ID), Some(FILE));
        assert_eq!(r.object_of(&perm), Some(PERMISSION));
        assert_eq!(r.object_of("x/../y"), None);
        assert_eq!(r.object_of(&format!("{FILE_ID}/a?b")), None);
        // A file id in a permission's place is no permission.
        assert_eq!(r.object_of(&format!("{FILE_ID}/{FILE_ID}")), None);
        for perm in ["anyoneWithLink", "09574847381747869339k", PERM_ID] {
            assert_eq!(r.object_of(&format!("{FILE_ID}/{perm}")), Some(PERMISSION));
        }
        assert_eq!(
            r.names_read(FILE, &[FILE_ID]),
            format!("/drive/v3/files/{FILE_ID}?supportsAllDrives=true&fields=id,name")
        );
        assert_eq!(
            r.names_read(PERMISSION, &[&perm]),
            format!(
                "/drive/v3/files/{FILE_ID}/permissions/{PERM_ID}?supportsAllDrives=true\
                 &fields=id,type,emailAddress,domain,displayName"
            )
        );
        assert_eq!(r.record_url("www.googleapis.com", &perm), None);
        assert_eq!(
            r.record_url("www.googleapis.com", FILE_ID).as_deref(),
            Some(&*format!("https://drive.google.com/open?id={FILE_ID}"))
        );
    }

    #[test]
    fn answers_parse_into_names_only_as_the_object_asked() {
        let r = GoogleDrive;
        let file = format!(r#"{{"id":"{FILE_ID}","name":"Plan.docx"}}"#);
        assert_eq!(
            r.parse_names(FILE, file.as_bytes()),
            [(FILE_ID.to_string(), "Plan.docx".to_string())]
        );
        // A file answer read as a permission names nobody, and the reverse.
        assert!(r.parse_names(PERMISSION, file.as_bytes()).is_empty());
        let person = r#"{"id":"7","type":"user","emailAddress":"a@example.com","displayName":"Alex Kim","role":"writer"}"#;
        assert!(r.parse_names(FILE, person.as_bytes()).is_empty());
        for (answer, id, who) in [
            (person, "7", "Alex Kim <a@example.com>"),
            (
                r#"{"id":"7","type":"user","emailAddress":"a@example.com","role":"reader"}"#,
                "7",
                "a@example.com",
            ),
            (
                r#"{"id":"anyoneWithLink","type":"anyone","role":"reader"}"#,
                "anyoneWithLink",
                "Anyone with the link",
            ),
            (
                r#"{"id":"7k","type":"domain","domain":"example.com","role":"reader"}"#,
                "7k",
                "Anyone at example.com",
            ),
        ] {
            assert_eq!(
                r.parse_names(PERMISSION, answer.as_bytes()),
                [(id.to_string(), who.to_string())]
            );
        }
        assert!(r
            .parse_names(PERMISSION, br#"{"id":"7","type":"user"}"#)
            .is_empty());
        assert!(r.parse_names(FILE, b"<html>").is_empty());
    }
}
