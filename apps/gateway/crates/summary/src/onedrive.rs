//! OneDrive / Word (Microsoft Graph `me/drive`): manual-approval summaries.
//!
//! The common writes are a new item in a folder (`POST
//! items/{folder}/children`, a folder when the body carries `folder`) and a
//! file upload by path (`PUT items/{folder}:/Name.docx:/content`). The card
//! names the item and the folder it goes in; the folder row is a record the
//! gateway names through this module's [`RecordResolver`].
//!
//! Registered as `"microsoft-word"` in [`super::summarizer`] and
//! [`super::record_resolver`].

use serde::Deserialize;

use super::records::{Named, Target};
use super::{
    decode_segment, human_size, json_object, one_line, ApprovalSummary, RecordResolver,
    RequestSummarizer, SummaryRequest, BODY_PEEK, MAX_VALUE_LEN,
};

pub(super) struct OneDrive;

const ITEM: &str = "Item";

impl RequestSummarizer for OneDrive {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let base = req.base_path();
        let rest = base.strip_prefix("/v1.0/me/drive/")?;
        let m = req.method_upper();
        // `items/{id}:/a/b.docx:/content` or `root:/a/b.docx:/content`: an
        // upload by path under a folder.
        if let Some((parent, path)) = upload_target(rest) {
            if m != "PUT" {
                return None;
            }
            let path = decode_segment(path);
            let (dirs, name) = path.rsplit_once('/').unwrap_or(("", &path));
            let mut s = ApprovalSummary::new("Upload file");
            s.push("File", one_line(name, MAX_VALUE_LEN));
            push_upload_size(&mut s, req);
            push_folder(&mut s, parent, dirs);
            if let Some(behavior) = req.query_param("@microsoft.graph.conflictBehavior") {
                if matches!(behavior.as_str(), "fail" | "replace" | "rename") {
                    s.push("If file exists", behavior);
                }
            }
            return Some(s);
        }
        let segs: Vec<&str> = rest.split('/').collect();
        if segs.iter().any(|segment| segment.is_empty()) {
            return None;
        }
        match (m.as_str(), segs.as_slice()) {
            ("POST", ["items", parent, "children"]) => Some(new_item(req, parent)),
            ("POST", ["root", "children"]) => Some(new_item(req, "root")),
            ("DELETE", ["items", id]) => Some(item_card("Delete", id)),
            ("PATCH", ["items", id]) => Some(update_item(req, id)),
            ("PATCH", ["root"]) => Some(update_item(req, "root")),
            ("PUT", ["items", id, "content"]) if is_item_id(id) => {
                let mut s = item_card("Replace file content of", id);
                push_upload_size(&mut s, req);
                Some(s)
            }
            ("POST", ["items", id, "createLink"]) => Some(share_link(req, id)),
            ("GET", ["root"]) => Some(ApprovalSummary::new("Read OneDrive")),
            ("GET", ["root", "children"]) => Some(ApprovalSummary::new("List OneDrive files")),
            ("GET", ["items", id, "children"]) => {
                let mut s = ApprovalSummary::new("List files in folder");
                push_item(&mut s, "Folder", id);
                Some(s)
            }
            ("GET", ["items", id]) => Some(item_card("Read", id)),
            _ => None,
        }
    }
}

fn share_link(req: &SummaryRequest<'_>, id: &str) -> ApprovalSummary {
    let mut s = item_card("Create share link to", id);
    if let Some(body) = req.body.and_then(json_object) {
        for (key, label) in [
            ("type", "Link type"),
            ("scope", "Link scope"),
            ("expirationDateTime", "Expiration"),
        ] {
            if let Some(value) = body.get(key).and_then(|v| v.as_str()) {
                s.push(label, one_line(value, MAX_VALUE_LEN));
            }
        }
        if body.contains_key("password") {
            s.push("Password", "Provided (hidden)");
        }
        if let Some(retain) = body
            .get("retainInheritedPermissions")
            .and_then(|v| v.as_bool())
        {
            s.push(
                "Existing permissions",
                if retain {
                    "Retained"
                } else {
                    "Removed on first share"
                },
            );
        }
    }
    s
}

fn update_item(req: &SummaryRequest<'_>, id: &str) -> ApprovalSummary {
    let mut s = item_card("Update", id);
    if let Some(body) = req.body.and_then(json_object) {
        if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
            s.push("New name", one_line(name, MAX_VALUE_LEN));
        }
        if let Some(parent) = body.get("parentReference") {
            // A destination may be in another drive. Do not resolve its id
            // against /me/drive, which could name an unrelated item.
            s.push("Move", "Change parent folder");
            for (key, label) in [
                ("id", "Destination folder ID"),
                ("driveId", "Destination drive ID"),
                ("path", "Destination path"),
            ] {
                if let Some(value) = parent.get(key).and_then(|v| v.as_str()) {
                    s.push(label, one_line(value, MAX_VALUE_LEN));
                }
            }
        }
        let other = body
            .keys()
            .filter(|key| !matches!(key.as_str(), "name" | "parentReference"))
            .count();
        if other > 0 {
            // Unknown metadata can contain credentials or URLs. Signal its
            // presence without copying arbitrary keys or values onto the card.
            s.push(
                "Other changes",
                format!("{other} additional properties (values hidden)"),
            );
        }
    }
    s
}

/// A new item in a folder: a folder when the body says `folder`, else a
/// file.
fn new_item(req: &SummaryRequest<'_>, parent: &str) -> ApprovalSummary {
    let body = req.body.and_then(json_object);
    let is_folder = body.as_ref().is_some_and(|b| b.contains_key("folder"));
    let (kind, label) = if is_folder {
        ("folder", "Folder")
    } else {
        ("file", "File")
    };
    let mut s = ApprovalSummary::new(format!("Create {kind}"));
    if let Some(name) = body.as_ref().and_then(|b| b.get("name")?.as_str()) {
        s.push(label, one_line(name, MAX_VALUE_LEN));
    }
    push_folder(&mut s, parent, "");
    s
}

/// `(parent, path)` for an upload by path: `items/{id}:/{path}:/content` or
/// `root:/{path}:/content`.
fn upload_target(rest: &str) -> Option<(&str, &str)> {
    let rest = rest.strip_suffix(":/content")?;
    let (head, path) = rest.split_once(":/")?;
    let parent = match head.strip_prefix("items/") {
        Some(id) => id,
        None if head == "root" => "root",
        None => return None,
    };
    if (parent != "root" && !is_item_id(parent))
        || path.is_empty()
        || path.split('/').any(|segment| {
            let decoded = decode_segment(segment);
            decoded.is_empty()
                || matches!(decoded.as_str(), "." | "..")
                || decoded.contains(['/', '\\', ':'])
        })
    {
        return None;
    }
    Some((parent, path))
}

/// The folder an item goes in: the drive's root by name, a folder id as a
/// record the gateway may name, plus any subfolders the upload path adds.
fn push_folder(s: &mut ApprovalSummary, parent: &str, dirs: &str) {
    let dirs = one_line(dirs.trim_matches('/'), MAX_VALUE_LEN);
    if parent == "root" {
        s.push(
            "In folder",
            if dirs.is_empty() {
                "OneDrive (top level)".to_string()
            } else {
                dirs
            },
        );
        return;
    }
    push_item(s, "In folder", parent);
    if !dirs.is_empty() {
        s.push("Subfolder", dirs);
    }
}

/// A row naming an item by id, registered so the gateway can name it. An
/// id that isn't a Graph item id is shown, never looked up.
fn push_item(s: &mut ApprovalSummary, label: &str, id: &str) {
    if is_item_id(id) {
        s.push_named(label, ITEM, id, id, Named::WithId);
    } else if id == "root" {
        s.push(label, "OneDrive (top level)");
    } else {
        s.push(label, one_line(id, MAX_VALUE_LEN));
    }
}

/// A Graph drive item id: `01GIGY3F…` (business) or `8A2F…!123`
/// (personal). Letters, digits and `!` only, with a digit, so a word in an
/// id's place (`undefined`, `root`) never reads as one, and nothing in it
/// can reach the read's path as anything but the id.
fn is_item_id(s: &str) -> bool {
    (10..=64).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'!')
        && s.bytes().any(|b| b.is_ascii_digit())
}

/// "Delete Q4.docx", titled by the item's name once the gateway reads it.
fn item_card(verb: &str, id: &str) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(verb);
    push_item(&mut s, "Item", id);
    if is_item_id(id) {
        s.target = Some(Target::of(id, " ", None));
    } else {
        s.action = format!("{verb} item");
    }
    s
}

fn push_upload_size(s: &mut ApprovalSummary, req: &SummaryRequest<'_>) {
    if let Some(size) = req.body.map(<[u8]>::len).filter(|n| *n > 0) {
        let size_text = human_size(size);
        s.push(
            "Size",
            if size >= BODY_PEEK {
                format!("At least {size_text} (body preview)")
            } else {
                size_text
            },
        );
    }
}

impl RecordResolver for OneDrive {
    fn object_of(&self, id: &str) -> Option<&'static str> {
        is_item_id(id).then_some(ITEM)
    }

    /// One read for the first id (destinations are not resolved), the id
    /// re-checked, so the path is fully server-built.
    fn names_read(&self, _object: &str, ids: &[&str]) -> String {
        let id = ids.iter().copied().find(|id| is_item_id(id)).unwrap_or("-");
        format!("/v1.0/me/drive/items/{id}?$select=id,name")
    }

    fn parse_names(&self, _object: &str, body: &[u8]) -> Vec<(String, String)> {
        #[derive(Deserialize)]
        struct Item {
            id: String,
            name: String,
        }
        serde_json::from_slice::<Item>(body)
            .map(|i| {
                if is_item_id(&i.id) && !i.name.trim().is_empty() {
                    vec![(i.id, one_line(&i.name, MAX_VALUE_LEN))]
                } else {
                    Vec::new()
                }
            })
            .unwrap_or_default()
    }

    /// Graph's item ids carry no page of their own a link can be built from
    /// safely (`webUrl` is server data, not ours), so items stay unlinked.
    fn record_url(&self, _host: &str, _id: &str) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{is_item_id, upload_target, OneDrive, ITEM};
    use crate::RecordResolver;
    use crate::{summarize_request, ApprovalSummary};

    fn word(method: &str, path: &str, body: Option<&str>) -> ApprovalSummary {
        summarize_request(
            "microsoft-word",
            method,
            path,
            Some("application/json"),
            body.map(str::as_bytes),
        )
    }

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    const FOLDER: &str = "01TESTFOLDER0000000000000000000000";

    #[test]
    fn existing_item_upload_is_explicit_and_preview_size_is_a_lower_bound() {
        let s = word(
            "PUT",
            &format!("/v1.0/me/drive/items/{FOLDER}/content"),
            Some("data"),
        );
        assert_eq!(s.action, "Replace file content of");
        assert_eq!(detail(&s, "Item"), Some(FOLDER));
        assert_eq!(detail(&s, "Size"), Some("4 B"));
        let body = "x".repeat(crate::BODY_PEEK);
        for path in [
            format!("/v1.0/me/drive/items/{FOLDER}/content"),
            "/v1.0/me/drive/root:/test.txt:/content".to_string(),
        ] {
            let s = word("PUT", &path, Some(&body));
            assert_eq!(detail(&s, "Size"), Some("At least 16 KB (body preview)"));
        }
        assert!(word(
            "PUT",
            "/v1.0/me/drive/items/undefined/content",
            Some("data")
        )
        .is_generic());
    }

    #[test]
    fn sharing_exposes_access_and_expiration_but_not_password() {
        let s = word(
            "POST",
            &format!("/v1.0/me/drive/items/{FOLDER}/createLink"),
            Some(
                r#"{"type":"edit","scope":"anonymous","expirationDateTime":"2027-01-01T00:00:00Z","password":"never-show-this","retainInheritedPermissions":false}"#,
            ),
        );
        assert_eq!(detail(&s, "Link type"), Some("edit"));
        assert_eq!(detail(&s, "Link scope"), Some("anonymous"));
        assert_eq!(detail(&s, "Expiration"), Some("2027-01-01T00:00:00Z"));
        assert_eq!(detail(&s, "Password"), Some("Provided (hidden)"));
        assert_eq!(
            detail(&s, "Existing permissions"),
            Some("Removed on first share")
        );
        assert!(!format!("{s:?}").contains("never-show-this"));
    }

    #[test]
    fn moves_and_other_changes_are_not_hidden_or_resolved_in_the_wrong_drive() {
        let s = word(
            "PATCH",
            &format!("/v1.0/me/drive/items/{FOLDER}"),
            Some(
                r#"{"name":"Renamed.docx","parentReference":{"id":"8A2F123456!123","driveId":"another-drive","path":"/drive/root:/Reports"},"description":"secret-description","fileSystemInfo":{"createdDateTime":"2020-01-01T00:00:00Z"}}"#,
            ),
        );
        assert_eq!(detail(&s, "New name"), Some("Renamed.docx"));
        assert_eq!(detail(&s, "Destination folder ID"), Some("8A2F123456!123"));
        assert_eq!(detail(&s, "Destination drive ID"), Some("another-drive"));
        assert_eq!(detail(&s, "Destination path"), Some("/drive/root:/Reports"));
        assert_eq!(
            detail(&s, "Other changes"),
            Some("2 additional properties (values hidden)")
        );
        assert_eq!(s.ref_ids().collect::<Vec<_>>(), [FOLDER]);
        assert!(!format!("{s:?}").contains("secret-description"));
        assert_eq!(
            detail(&word("PATCH", "/v1.0/me/drive/root", Some("{}")), "Item"),
            Some("OneDrive (top level)")
        );
    }

    #[test]
    fn named_items_keep_their_identity() {
        let mut s = word("DELETE", &format!("/v1.0/me/drive/items/{FOLDER}"), None);
        s.name_refs(|_| Some("Plan.docx"));
        assert_eq!(
            detail(&s, "Item"),
            Some(format!("Plan.docx ({FOLDER})").as_str())
        );
    }

    #[test]
    fn resolver_requests_parses_and_links_are_safe() {
        assert_eq!(
            OneDrive.names_read(ITEM, &["../bad", FOLDER]),
            format!("/v1.0/me/drive/items/{FOLDER}?$select=id,name")
        );
        assert_eq!(
            OneDrive.names_read(ITEM, &["../bad"]),
            "/v1.0/me/drive/items/-?$select=id,name"
        );
        let body =
            format!(r#"{{"id":"{FOLDER}","name":"Plan.docx","webUrl":"https://evil.invalid"}}"#);
        assert_eq!(
            OneDrive.parse_names(ITEM, body.as_bytes()),
            vec![(FOLDER.to_string(), "Plan.docx".to_string())]
        );
        for body in [
            "not json",
            "{}",
            r#"{"id":"../bad","name":"Plan"}"#,
            r#"{"id":"8A2F123456!123","name":" "}"#,
        ] {
            assert!(OneDrive.parse_names(ITEM, body.as_bytes()).is_empty());
        }
        for id in [FOLDER, "../bad", "undefined"] {
            assert_eq!(OneDrive.record_url("evil.invalid", id), None);
        }
    }

    #[test]
    fn route_and_id_boundaries_are_strict() {
        assert!(is_item_id("8A2F123456!123"));
        for id in [
            "undefined",
            "root",
            "123",
            "0123456789/evil",
            "0123456789%2f",
            "0123456789?x",
            "0123456789#x",
            "0123456789\\evil",
        ] {
            assert!(!is_item_id(id));
            assert_eq!(OneDrive.object_of(id), None);
        }
        for path in [
            "root:/:/content",
            "items/evil/path:/a:/content",
            "root:/../a:/content",
            "root:/%2e%2e/a:/content",
            "root:/a%2fb:/content",
            "root:/a//b:/content",
        ] {
            assert!(upload_target(path).is_none(), "{path}");
        }
        for path in [
            "/v1.0/me/drive/items//children",
            "/v1.0/me/drive//root",
            "/v1.0/me/drive/root/children/",
            "/v1.0/users/me/drive/root",
            "/v1.0/me/drive/items/1234567890/createLink/extra",
        ] {
            assert!(word("POST", path, None).is_generic(), "{path}");
        }
    }

    #[test]
    fn a_new_item_names_itself_and_its_folder() {
        let path = format!("/v1.0/me/drive/items/{FOLDER}/children");
        let s = word("POST", &path, Some(r#"{"name":"Q4 Reports","folder":{}}"#));
        assert_eq!(s.action, "Create folder");
        assert_eq!(detail(&s, "Folder"), Some("Q4 Reports"));
        assert_eq!(detail(&s, "In folder"), Some(FOLDER));
        assert_eq!(s.ref_ids().collect::<Vec<_>>(), [FOLDER]);
        let s = word("POST", &path, Some(r#"{"name":"notes.txt","file":{}}"#));
        assert_eq!(s.action, "Create file");
        assert_eq!(detail(&s, "File"), Some("notes.txt"));
    }

    #[test]
    fn an_upload_by_path_names_the_file_and_where_it_lands() {
        let s = word(
            "PUT",
            &format!("/v1.0/me/drive/items/{FOLDER}:/2026-09_Expense%20Report.docx:/content"),
            Some("xxxx"),
        );
        assert_eq!(s.action, "Upload file");
        assert_eq!(detail(&s, "File"), Some("2026-09_Expense Report.docx"));
        assert_eq!(detail(&s, "Size"), Some("4 B"));
        assert_eq!(detail(&s, "In folder"), Some(FOLDER));
        let s = word(
            "PUT",
            "/v1.0/me/drive/root:/Documents/Agent/R.docx:/content",
            None,
        );
        assert_eq!(detail(&s, "In folder"), Some("Documents/Agent"));
        let s = word(
            "PUT",
            "/v1.0/me/drive/root:/R.docx:/content?%40microsoft.graph.conflictBehavior=rename",
            None,
        );
        assert_eq!(s.action, "Upload file");
        assert_eq!(detail(&s, "If file exists"), Some("rename"));
        let s = word("PUT", "/v1.0/me/drive/root:/R.docx:/content", None);
        assert_eq!(detail(&s, "If file exists"), None);
    }

    #[test]
    fn unsafe_ids_are_never_looked_up() {
        let s = word("POST", "/v1.0/me/drive/items/undefined/createLink", None);
        assert_eq!(s.action, "Create share link to item");
        assert_eq!(s.ref_ids().count(), 0);
        assert!(word("GET", "/v1.0/me/drive/root", None).action == "Read OneDrive");
        assert!(word("GET", "/v1.0/sites", None).is_generic());
    }
}
