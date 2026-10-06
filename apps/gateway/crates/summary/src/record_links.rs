//! The existing record a held request's path names, linked on its card.
//!
//! A change to an existing record names it in the path (`PATCH
//! /repos/acme/web/issues/42`, `DELETE /drive/v3/files/1AbC…`). The card
//! leads with a link to that record's page, so the approver can open it
//! before deciding. Records a summarizer names by id in the body are linked
//! through the provider's [`RecordResolver`](super::RecordResolver) instead.
//!
//! The gateway builds every link itself, never from request text:
//!
//! - a template answers only for its app's real API host, and links only to
//!   the app's own web domain, over `https://`;
//! - every path segment it uses must match a strict per-app id shape, so no
//!   segment can carry a `/`, `?`, `#`, `@`, `%` or a scheme into the URL;
//! - a path with a dot segment (`..`, `%2e%2e`) or a `\` gets no link: the
//!   request goes out on the resolved path, which may name another record;
//! - anything it does not recognize gets no link (no link beats a wrong one).
//!
//! Apps whose record page needs data the request does not carry have no
//! template: HubSpot (the portal id), Linear (the team key), Attio (the
//! workspace slug) and Jira (the site behind Atlassian's `cloudId` gateway).

use super::{ApprovalDetail, ApprovalSummary};

impl ApprovalSummary {
    /// Lead the card with a link to the existing record the request's path
    /// changes, when `provider` has a template for it. `host` is the held
    /// request's host without its port; `path` may carry a query (ignored).
    /// Runs before [`finalize_title`](Self::finalize_title), which reads the
    /// record rows' positions.
    pub fn link_path_record(&mut self, provider: &str, host: &str, method: &str, path: &str) {
        let Some(row) = path_record(provider, host, method, path) else {
            return;
        };
        self.details.insert(0, row);
        // Every row moved down one: each record keeps naming its own row.
        for r in &mut self.refs {
            r.detail_index += 1;
        }
    }
}

/// A per-app template: the path's segments to the record's linked row.
type Template = fn(&[&str]) -> Option<ApprovalDetail>;

fn path_record(provider: &str, host: &str, method: &str, path: &str) -> Option<ApprovalDetail> {
    // A read changes nothing, so there is nothing to check first.
    if method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD") {
        return None;
    }
    let (api_host, template): (&str, Template) = match provider {
        "github" | "github-app" => ("api.github.com", github),
        "notion" => ("api.notion.com", notion),
        "trello" => ("api.trello.com", trello),
        "todoist" => ("api.todoist.com", todoist),
        "google-docs" => ("docs.googleapis.com", google_docs),
        "google-sheets" => ("sheets.googleapis.com", google_sheets),
        "google-slides" => ("slides.googleapis.com", google_slides),
        "google-drive" => ("www.googleapis.com", google_drive),
        _ => return None,
    };
    let base = path.split(['?', '#']).next().unwrap_or(path);
    if !host.eq_ignore_ascii_case(api_host) || base.contains('\\') {
        return None;
    }
    let segs: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    if segs.iter().any(|s| is_dot_segment(s)) {
        return None;
    }
    template(&segs)
}

/// The URL Standard's single- and double-dot segments, which the outgoing
/// URL resolves (as it reads a `\` as a `/`).
fn is_dot_segment(s: &str) -> bool {
    [".", "%2e", "..", ".%2e", "%2e.", "%2e%2e"]
        .iter()
        .any(|dot| s.eq_ignore_ascii_case(dot))
}

fn linked(label: &str, value: String, url: String) -> ApprovalDetail {
    ApprovalDetail {
        label: label.to_string(),
        value,
        url: Some(url),
    }
}

/// A GitHub owner or repository name.
fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn is_number(s: &str) -> bool {
    !s.is_empty() && s.len() <= 12 && s.bytes().all(|b| b.is_ascii_digit())
}

/// An opaque id (Trello, Todoist, Google): letters, digits, `-`, `_`. At
/// least 6 long, so a fixed endpoint in an id's place (Drive's
/// `files/trash`, Todoist's `tasks/quick`) never reads as a record.
fn is_token(s: &str) -> bool {
    (6..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// `/repos/{owner}/{repo}/issues/{n}[/…]` and `/pulls/{n}[/…]`.
fn github(segs: &[&str]) -> Option<ApprovalDetail> {
    let ["repos", owner, repo, kind, n, ..] = segs else {
        return None;
    };
    let (label, page) = match *kind {
        "issues" => ("Issue", "issues"),
        "pulls" => ("Pull request", "pull"),
        _ => return None,
    };
    (is_name(owner) && is_name(repo) && is_number(n)).then(|| {
        linked(
            label,
            format!("{owner}/{repo}#{n}"),
            format!("https://github.com/{owner}/{repo}/{page}/{n}"),
        )
    })
}

/// `/v1/pages/{id}[/…]` and `/v1/blocks/{id}[/…]`: a 32-hex id, dashed or not.
fn notion(segs: &[&str]) -> Option<ApprovalDetail> {
    let ["v1", kind @ ("pages" | "blocks"), id, ..] = segs else {
        return None;
    };
    let hex: String = id.chars().filter(|c| *c != '-').collect();
    if id.len() > 36 || hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let label = if *kind == "pages" { "Page" } else { "Block" };
    Some(linked(
        label,
        (*id).to_string(),
        format!("https://www.notion.so/{hex}"),
    ))
}

/// `/1/cards/{id}[/…]`: the card's id or its short link.
fn trello(segs: &[&str]) -> Option<ApprovalDetail> {
    let ["1", "cards", id, ..] = segs else {
        return None;
    };
    is_token(id).then(|| {
        linked(
            "Card",
            (*id).to_string(),
            format!("https://trello.com/c/{id}"),
        )
    })
}

/// `/api/v1/tasks/{id}[/…]`, Todoist's unified API (REST v2 is retired).
fn todoist(segs: &[&str]) -> Option<ApprovalDetail> {
    let ["api", "v1", "tasks", id, ..] = segs else {
        return None;
    };
    is_token(id).then(|| {
        linked(
            "Task",
            (*id).to_string(),
            format!("https://app.todoist.com/app/task/{id}"),
        )
    })
}

/// `/v1/documents/{id}[…]`.
fn google_docs(segs: &[&str]) -> Option<ApprovalDetail> {
    google_editor(segs, ("v1", "documents"), "Document", "document")
}

/// `/v4/spreadsheets/{id}[…]`.
fn google_sheets(segs: &[&str]) -> Option<ApprovalDetail> {
    google_editor(segs, ("v4", "spreadsheets"), "Spreadsheet", "spreadsheets")
}

/// `/v1/presentations/{id}[…]`.
fn google_slides(segs: &[&str]) -> Option<ApprovalDetail> {
    google_editor(
        segs,
        ("v1", "presentations"),
        "Presentation",
        "presentation",
    )
}

/// A Docs, Sheets or Slides file: the id is the third segment, sometimes
/// with a method suffix (`{id}:batchUpdate`).
fn google_editor(
    segs: &[&str],
    api: (&str, &str),
    label: &str,
    editor: &str,
) -> Option<ApprovalDetail> {
    let [version, collection, id, ..] = segs else {
        return None;
    };
    if (*version, *collection) != api {
        return None;
    }
    let id = id.split_once(':').map_or(*id, |(id, _)| id);
    is_token(id).then(|| {
        linked(
            label,
            id.to_string(),
            format!("https://docs.google.com/{editor}/d/{id}/edit"),
        )
    })
}

/// `/drive/v3/files/{id}[/…]` and the upload form `/upload/drive/v3/…` (v2
/// alike). Drive's generic opener redirects to the right editor or viewer
/// for the item's kind.
fn google_drive(segs: &[&str]) -> Option<ApprovalDetail> {
    let (["drive", "v3" | "v2", "files", id, ..]
    | ["upload", "drive", "v3" | "v2", "files", id, ..]) = segs
    else {
        return None;
    };
    is_token(id).then(|| {
        linked(
            "File",
            (*id).to_string(),
            format!("https://drive.google.com/open?id={id}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Target;

    fn link(provider: &str, host: &str, method: &str, path: &str) -> Option<ApprovalDetail> {
        path_record(provider, host, method, path)
    }

    fn url(provider: &str, host: &str, method: &str, path: &str) -> Option<String> {
        link(provider, host, method, path).and_then(|d| d.url)
    }

    #[test]
    fn a_change_to_an_existing_record_links_its_page() {
        let page = "0123456789abcdef0123456789abcdef";
        let dashed = "01234567-89ab-cdef-0123-456789abcdef";
        for (provider, host, method, path, label, value, want) in [
            (
                "github",
                "api.github.com",
                "PATCH",
                "/repos/acme/web.app/issues/42",
                "Issue",
                "acme/web.app#42",
                "https://github.com/acme/web.app/issues/42",
            ),
            (
                "github-app",
                "api.github.com",
                "POST",
                "/repos/acme/web/issues/42/comments",
                "Issue",
                "acme/web#42",
                "https://github.com/acme/web/issues/42",
            ),
            (
                "github",
                "api.github.com",
                "PUT",
                "/repos/acme/web/pulls/7/merge?x=1",
                "Pull request",
                "acme/web#7",
                "https://github.com/acme/web/pull/7",
            ),
            (
                "notion",
                "api.notion.com",
                "PATCH",
                &format!("/v1/pages/{page}"),
                "Page",
                page,
                &format!("https://www.notion.so/{page}"),
            ),
            (
                "notion",
                "api.notion.com",
                "PATCH",
                &format!("/v1/blocks/{dashed}/children"),
                "Block",
                dashed,
                &format!("https://www.notion.so/{page}"),
            ),
            (
                "trello",
                "api.trello.com",
                "DELETE",
                "/1/cards/5f1a2b3c4d5e6f7a8b9c0d1e",
                "Card",
                "5f1a2b3c4d5e6f7a8b9c0d1e",
                "https://trello.com/c/5f1a2b3c4d5e6f7a8b9c0d1e",
            ),
            (
                "todoist",
                "api.todoist.com",
                "POST",
                "/api/v1/tasks/6Xm2Pq9RtV4wZc8K/close",
                "Task",
                "6Xm2Pq9RtV4wZc8K",
                "https://app.todoist.com/app/task/6Xm2Pq9RtV4wZc8K",
            ),
            (
                "google-docs",
                "docs.googleapis.com",
                "POST",
                "/v1/documents/1AbC_dEf-123456:batchUpdate",
                "Document",
                "1AbC_dEf-123456",
                "https://docs.google.com/document/d/1AbC_dEf-123456/edit",
            ),
            (
                "google-sheets",
                "sheets.googleapis.com",
                "POST",
                "/v4/spreadsheets/1SheetId_42/values/A1:append",
                "Spreadsheet",
                "1SheetId_42",
                "https://docs.google.com/spreadsheets/d/1SheetId_42/edit",
            ),
            (
                "google-sheets",
                "sheets.googleapis.com",
                "PUT",
                "/v4/spreadsheets/1SheetId_42/values/Sheet1%21A1%3AB2",
                "Spreadsheet",
                "1SheetId_42",
                "https://docs.google.com/spreadsheets/d/1SheetId_42/edit",
            ),
            (
                "google-slides",
                "slides.googleapis.com",
                "POST",
                "/v1/presentations/1SlideId_42:batchUpdate",
                "Presentation",
                "1SlideId_42",
                "https://docs.google.com/presentation/d/1SlideId_42/edit",
            ),
            (
                "google-drive",
                "www.googleapis.com",
                "DELETE",
                "/drive/v3/files/1AbCdEf98765",
                "File",
                "1AbCdEf98765",
                "https://drive.google.com/open?id=1AbCdEf98765",
            ),
            (
                "google-drive",
                "www.googleapis.com",
                "PATCH",
                "/upload/drive/v3/files/1AbCdEf98765?uploadType=media",
                "File",
                "1AbCdEf98765",
                "https://drive.google.com/open?id=1AbCdEf98765",
            ),
        ] {
            assert_eq!(
                link(provider, host, method, path),
                Some(ApprovalDetail {
                    label: label.into(),
                    value: value.into(),
                    url: Some(want.into()),
                }),
                "{provider} {method} {path}"
            );
        }
    }

    #[test]
    fn a_read_a_create_or_an_endpoint_names_no_record() {
        for (provider, host, method, path) in [
            (
                "github",
                "api.github.com",
                "GET",
                "/repos/acme/web/issues/42",
            ),
            (
                "github",
                "api.github.com",
                "HEAD",
                "/repos/acme/web/issues/42",
            ),
            ("github", "api.github.com", "POST", "/repos/acme/web/issues"),
            (
                "github",
                "api.github.com",
                "PATCH",
                "/repos/acme/web/issues/comments/9",
            ),
            ("notion", "api.notion.com", "POST", "/v1/pages"),
            ("trello", "api.trello.com", "POST", "/1/cards"),
            ("todoist", "api.todoist.com", "POST", "/api/v1/tasks"),
            ("todoist", "api.todoist.com", "POST", "/api/v1/tasks/quick"),
            // A retired REST v2 path: no longer reaches a task.
            (
                "todoist",
                "api.todoist.com",
                "POST",
                "/rest/v2/tasks/8123456789",
            ),
            (
                "google-docs",
                "docs.googleapis.com",
                "POST",
                "/v1/documents",
            ),
            (
                "google-drive",
                "www.googleapis.com",
                "POST",
                "/drive/v3/files",
            ),
            (
                "google-drive",
                "www.googleapis.com",
                "DELETE",
                "/drive/v3/files/trash",
            ),
        ] {
            assert_eq!(url(provider, host, method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn nothing_in_a_segment_can_redirect_the_link() {
        for path in [
            "/repos/../evil/issues/1",
            "/repos/acme/web/issues/1@evil.com",
            "/repos/acme/web%2F..%2Fx/issues/1",
            "/repos/acme/web/issues/1%23x",
            "/repos/acme/https:/issues/1",
            // The request goes out to issue 2 of c/d: never link a/b#1.
            "/repos/a/b/issues/1/../../../../repos/c/d/issues/2",
            "/repos/a/b/issues/1/%2e%2e/%2E%2e/.%2e/%2e./repos/c/d/issues/2",
            "/repos/a/b/issues/1\\..\\..\\..\\..\\repos\\c\\d\\issues\\2",
            "/repos/a/b/issues/1/./comments",
            "/repos/a/b/issues/1/%2E/comments",
        ] {
            assert_eq!(
                url("github", "api.github.com", "PATCH", path),
                None,
                "{path}"
            );
        }
        // A fragment or query never reaches the link.
        assert_eq!(
            url("github", "api.github.com", "PATCH", "/repos/a/b/issues/1#x").as_deref(),
            Some("https://github.com/a/b/issues/1")
        );
        assert_eq!(
            url("notion", "api.notion.com", "PATCH", "/v1/pages/not-hex"),
            None
        );
        assert_eq!(
            url("trello", "api.trello.com", "PUT", "/1/cards/abc@evil.com"),
            None
        );
        assert_eq!(
            url(
                "google-docs",
                "docs.googleapis.com",
                "POST",
                "/v1/documents/..%2Fx:batchUpdate"
            ),
            None
        );
    }

    #[test]
    fn a_template_answers_only_for_its_own_api_host() {
        assert_eq!(
            url("github", "evil.com", "PATCH", "/repos/a/b/issues/1"),
            None
        );
        assert_eq!(
            url("github", "github.com", "PATCH", "/repos/a/b/issues/1"),
            None
        );
        assert_eq!(
            url(
                "google-docs",
                "evil.com",
                "POST",
                "/v1/documents/1AbCdEf98765"
            ),
            None
        );
        // Another app's path on this app's host is not this app's record.
        assert_eq!(
            url(
                "google-docs",
                "docs.googleapis.com",
                "POST",
                "/v4/spreadsheets/1AbCdEf98765:batchUpdate"
            ),
            None
        );
        // Host names are case-insensitive.
        assert_eq!(
            url("github", "API.GitHub.com", "PATCH", "/repos/a/b/issues/1").as_deref(),
            Some("https://github.com/a/b/issues/1")
        );
    }

    #[test]
    fn apps_without_a_template_get_no_link() {
        assert_eq!(
            url(
                "hubspot",
                "api.hubapi.com",
                "PATCH",
                "/crm/v3/objects/contacts/1"
            ),
            None
        );
    }

    #[test]
    fn the_link_leads_and_record_rows_keep_their_rows() {
        let id = "003fn00000Fa7bpAAB";
        let mut s = ApprovalSummary::new("Update Contact");
        s.push("Email", "a@b.test");
        s.push_record("Contact", "Contact", id);
        s.target = Some(Target::of(id, " ", None));
        s.link_path_record("github", "api.github.com", "PATCH", "/repos/a/b/issues/1");
        s.link_refs(|id| Some(format!("https://org.test/{id}")));
        s.finalize_title();
        assert_eq!(s.details[0].label, "Issue");
        assert_eq!(s.details[2].value, format!("Contact · {id}"));
        assert_eq!(
            s.details[2].url.as_deref(),
            Some(&*format!("https://org.test/{id}"))
        );
        let subject = s.subject.unwrap();
        assert_eq!(subject.row, 2);
        assert_eq!(subject.url, s.details[2].url);
    }

    #[test]
    fn no_template_leaves_the_card_untouched() {
        let mut s = ApprovalSummary::new("PATCH request");
        s.push("Endpoint", "/x");
        let before = s.clone();
        s.link_path_record("hubspot", "api.hubapi.com", "PATCH", "/x");
        assert_eq!(s, before);
    }
}
