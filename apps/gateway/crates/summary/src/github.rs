//! GitHub REST: manual-approval summaries for the writes agents make most:
//! branches (`git/refs`), file commits (`contents/{path}`), pull requests,
//! issues and comments. The repository leads as `owner/repo`; an issue or
//! pull request it names is linked by `record_links.rs`.
//!
//! Registered as `"github"` and `"github-app"` in [`super::summarizer`].

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

use super::{
    decode_segment, json_object, one_line, ApprovalSummary, RequestSummarizer, SummaryRequest,
    MAX_VALUE_LEN,
};

pub(super) struct GitHub;

impl RequestSummarizer for GitHub {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let segs: Vec<&str> = req
            .base_path()
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let ["repos", owner, repo, rest @ ..] = segs.as_slice() else {
            return None;
        };
        let m = req.method_upper();
        let body = req.body.and_then(json_object);
        let body = body.as_ref();
        let text = |key: &str| {
            body.and_then(|b| b.get(key))
                .and_then(Value::as_str)
                .map(|v| one_line(v, MAX_VALUE_LEN))
                .filter(|v| !v.is_empty())
        };
        // These are ordinary resource writes. Reuse the full nested-body reader,
        // including its title naming and read-back hint, instead of selecting a
        // few fields and silently dropping labels, assignees or long prose.
        if matches!(
            (m.as_str(), rest),
            ("POST", ["issues" | "pulls"])
                | ("PATCH", ["issues" | "pulls", _])
                | ("POST", ["issues" | "pulls", _, "comments"])
                | ("PUT", ["pulls", _, "merge"])
        ) {
            let mut s = super::generic::summarize(req);
            if !s.details.iter().any(|row| row.label == "Endpoint") {
                // A GraphQL envelope is not this REST resource's body shape.
                return None;
            }
            if let Some(range) = s.fallback.clone() {
                for row in &mut s.details[range] {
                    if row.label == "Pull" {
                        row.label = "Pull request".into();
                    }
                }
            }
            if matches!(rest, [_, _, "comments"]) {
                s.action = "Comment".into();
            } else if matches!(rest, ["pulls", _, "merge"]) {
                s.action = "Merge pull request".into();
            } else if rest[0] == "pulls" {
                s.action = if m == "POST" {
                    "Open pull request"
                } else {
                    "Update pull request"
                }
                .into();
                if m == "POST" {
                    if let (Some(head), Some(base)) = (text("head"), text("base")) {
                        s.push("Merge", format!("{head} into {base}"));
                    }
                }
            }
            s.details.insert(
                1,
                super::ApprovalDetail {
                    label: "Repository".into(),
                    value: one_line(&format!("{owner}/{repo}"), MAX_VALUE_LEN),
                    url: None,
                },
            );
            // Keep repository and URL-derived record identities through the
            // comparison pass, alongside the endpoint. No body row is retained
            // here: those must be replaced by their before/after values.
            if let Some(range) = s.fallback.as_mut() {
                range.end += 1;
            }
            return Some(s);
        }
        let mut s = match (m.as_str(), rest) {
            ("POST", ["git", "refs"]) => {
                let r = text("ref").unwrap_or_default();
                let (kind, label, name) = classify_ref(&r);
                let mut s = ApprovalSummary::new(format!("Create {kind}"));
                s.push(label, name);
                if let Some(sha) = text("sha") {
                    s.push("From commit", short_sha(&sha));
                }
                s
            }
            ("PATCH", ["git", "refs", r @ ..]) => {
                let forced = body
                    .and_then(|b| b.get("force"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let (kind, label, name) = classify_ref(&decode_segment(&r.join("/")));
                let verb = if forced { "Force-update" } else { "Update" };
                let mut s = ApprovalSummary::new(format!("{verb} {kind}"));
                s.push(label, name);
                if let Some(sha) = text("sha") {
                    s.push("To commit", short_sha(&sha));
                }
                s
            }
            ("DELETE", ["git", "refs", r @ ..]) => {
                let (kind, label, name) = classify_ref(&decode_segment(&r.join("/")));
                let mut s = ApprovalSummary::new(format!("Delete {kind}"));
                s.push(label, name);
                s
            }
            ("PUT", ["contents", path @ ..]) if !path.is_empty() => {
                // A `sha` is the blob it replaces: an update, else a new file.
                let verb = if text("sha").is_some() {
                    "Update file"
                } else {
                    "Create file"
                };
                let mut s = ApprovalSummary::new(verb);
                s.push("File", file_path(path));
                push_commit(&mut s, &text);
                if let Some(len) = body
                    .and_then(|b| b.get("content"))
                    .and_then(Value::as_str)
                    .and_then(|content| STANDARD.decode(content).ok())
                    .map(|bytes| bytes.len())
                {
                    s.push("Size", super::human_size(len));
                }
                s
            }
            ("DELETE", ["contents", path @ ..]) if !path.is_empty() => {
                let mut s = ApprovalSummary::new("Delete file");
                s.push("File", file_path(path));
                push_commit(&mut s, &text);
                s
            }
            _ => return None,
        };
        s.details.insert(
            0,
            super::ApprovalDetail {
                label: "Repository".into(),
                value: one_line(&format!("{owner}/{repo}"), MAX_VALUE_LEN),
                url: None,
            },
        );
        s.push("Endpoint", req.base_path());
        Some(s)
    }
}

/// Only known namespaces are described as branches or tags.
fn classify_ref(reference: &str) -> (&'static str, &'static str, String) {
    let name = reference.strip_prefix("refs/").unwrap_or(reference);
    let (kind, label, value) =
        if let Some(branch) = name.strip_prefix("heads/").filter(|s| !s.is_empty()) {
            ("branch", "Branch", branch)
        } else if let Some(tag) = name.strip_prefix("tags/").filter(|s| !s.is_empty()) {
            ("tag", "Tag", tag)
        } else {
            ("reference", "Reference", reference)
        };
    (kind, label, one_line(value, MAX_VALUE_LEN))
}

fn file_path(path: &[&str]) -> String {
    one_line(&decode_segment(&path.join("/")), MAX_VALUE_LEN)
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// The commit message and branch a file write lands with.
fn push_commit(s: &mut ApprovalSummary, text: &dyn Fn(&str) -> Option<String>) {
    if let Some(msg) = text("message") {
        s.push("Commit message", msg);
    }
    if let Some(branch) = text("branch") {
        s.push("Branch", branch);
    }
}

#[cfg(test)]
mod tests {
    use crate::{summarize_request, ApprovalSummary};

    fn gh(method: &str, path: &str, body: &str) -> ApprovalSummary {
        summarize_request(
            "github-app",
            method,
            path,
            Some("application/json"),
            (!body.is_empty()).then_some(body.as_bytes()),
        )
    }

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    #[test]
    fn branches_read_as_branches() {
        let s = gh(
            "POST",
            "/repos/acme/web/git/refs",
            r#"{"ref":"refs/heads/test-card","sha":"aa218f56b14c9653891f9e74264a383fa43fefbd"}"#,
        );
        assert_eq!(s.action, "Create branch");
        assert_eq!(detail(&s, "Repository"), Some("acme/web"));
        assert_eq!(detail(&s, "Branch"), Some("test-card"));
        assert_eq!(detail(&s, "From commit"), Some("aa218f5"));
        let s = gh(
            "PATCH",
            "/repos/acme/web/git/refs/heads/main",
            r#"{"sha":"bb","force":true}"#,
        );
        assert_eq!(s.action, "Force-update branch");
        assert_eq!(detail(&s, "Branch"), Some("main"));
        assert_eq!(
            gh("DELETE", "/repos/acme/web/git/refs/heads/x", "").action,
            "Delete branch"
        );
    }

    #[test]
    fn file_commits_name_the_file_and_message() {
        let s = gh(
            "PUT",
            "/repos/acme/docs/contents/todos/open.md",
            r#"{"message":"update todos","content":"aGVsbG8gd29ybGQh","sha":"abc","branch":"main"}"#,
        );
        assert_eq!(s.action, "Update file");
        assert_eq!(detail(&s, "File"), Some("todos/open.md"));
        assert_eq!(detail(&s, "Commit message"), Some("update todos"));
        assert_eq!(detail(&s, "Size"), Some("12 B"));
        let s = gh(
            "PUT",
            "/repos/a/b/contents/new.txt",
            r#"{"message":"m","content":""}"#,
        );
        assert_eq!(s.action, "Create file");
    }

    #[test]
    fn reference_namespaces_are_not_assumed_to_be_branches() {
        for (reference, kind, label, name) in [
            ("tags/release/v1", "tag", "Tag", "release/v1"),
            ("tags%2Frelease%2Fv1", "tag", "Tag", "release/v1"),
            ("notes/commits", "reference", "Reference", "notes/commits"),
            ("heads/", "reference", "Reference", "heads"),
        ] {
            for (method, verb, body) in [
                ("PATCH", "Update", r#"{"sha":"abc"}"#),
                ("PATCH", "Force-update", r#"{"sha":"abc","force":true}"#),
                ("DELETE", "Delete", ""),
            ] {
                let s = gh(
                    method,
                    &format!("/repos/acme/docs/git/refs/{reference}"),
                    body,
                );
                assert_eq!(s.action, format!("{verb} {kind}"));
                assert_eq!(detail(&s, label), Some(name));
                assert_eq!(detail(&s, "Branch"), None);
            }
        }
        for reference in ["refs/notes/commits", "unexpected", ""] {
            let s = gh(
                "POST",
                "/repos/acme/docs/git/refs",
                &serde_json::json!({"ref":reference}).to_string(),
            );
            assert_eq!(s.action, "Create reference");
            assert_eq!(detail(&s, "Branch"), None);
        }
    }

    #[test]
    fn content_size_is_exact_and_invalid_content_has_no_size() {
        for (content, size) in [
            ("", Some("0 B")),
            ("YQ==", Some("1 B")),
            ("YWI=", Some("2 B")),
            ("YWJj", Some("3 B")),
            ("Y===", None),
            ("!!!!", None),
            ("YQ", None),
        ] {
            let s = gh(
                "PUT",
                "/repos/acme/docs/contents/file",
                &serde_json::json!({"content":content}).to_string(),
            );
            assert_eq!(detail(&s, "Size"), size);
            assert!(s.details.iter().all(|d| d.label != "Content"));
        }
    }

    #[test]
    fn existing_targets_and_review_context_are_explicit() {
        for (method, path, label) in [
            ("PATCH", "issues/42", "Issue"),
            ("PATCH", "pulls/42", "Pull request"),
            ("POST", "issues/42/comments", "Issue"),
            ("POST", "pulls/42/comments", "Pull request"),
            ("PUT", "pulls/42/merge", "Pull request"),
        ] {
            let s = gh(method, &format!("/repos/acme/docs/{path}"), "{}");
            assert_eq!(detail(&s, label), Some("42"));
        }
        let s = gh(
            "POST",
            "/repos/acme/docs/pulls/42/comments",
            r#"{"path":"src/lib.rs","line":12,"start_line":10,"side":"RIGHT","start_side":"RIGHT","commit_id":"synthetic-sha","subject_type":"line","in_reply_to":99}"#,
        );
        assert_eq!(detail(&s, "Path"), Some("src/lib.rs"));
        assert_eq!(detail(&s, "Line"), Some("12"));
        assert_eq!(detail(&s, "In reply to"), Some("99"));
        assert_eq!(detail(&s, "Start line"), Some("10"));
        assert_eq!(detail(&s, "Side"), Some("RIGHT"));
        assert_eq!(detail(&s, "Start side"), Some("RIGHT"));
        assert_eq!(detail(&s, "Commit id"), Some("synthetic-sha"));
        assert_eq!(detail(&s, "Subject type"), Some("line"));
        let s = gh(
            "PUT",
            "/repos/acme/docs/pulls/42/merge",
            r#"{"sha":"expected-sha","commit_title":"Merge fix","commit_message":"Reviewed change","merge_method":"squash"}"#,
        );
        assert_eq!(detail(&s, "Sha"), Some("expected-sha"));
        assert_eq!(detail(&s, "Commit title"), Some("Merge fix"));
        assert_eq!(detail(&s, "Commit message"), Some("Reviewed change"));
        let s = gh(
            "POST",
            "/repos/acme/docs/pulls/42/comments",
            r#"{"line":-1,"in_reply_to":"99"}"#,
        );
        assert_eq!(detail(&s, "Line"), Some("-1"));
        assert_eq!(detail(&s, "In reply to"), Some("99"));
        assert!(gh("GET", "/repos/acme/docs/pulls/42/comments", "").is_generic());
    }

    #[test]
    fn resource_comparisons_keep_identity_and_endpoint_before_and_after_linking() {
        for resource in ["issues", "pulls"] {
            let path = format!("/repos/acme/docs/{resource}/42");
            let body = br#"{"title":"New title","labels":["bug","p1"]}"#;
            let mut s = gh("PATCH", &path, std::str::from_utf8(body).unwrap());
            assert_eq!(s.change_hint().unwrap().read_path, path);
            assert_eq!(detail(&s, "Endpoint"), Some(path.as_str()));
            s.apply_current(body, br#"{"title":"Old title","labels":[{"name":"bug"}]}"#);
            assert_eq!(detail(&s, "Repository"), Some("acme/docs"));
            assert_eq!(
                detail(
                    &s,
                    if resource == "issues" {
                        "Issue"
                    } else {
                        "Pull request"
                    }
                ),
                Some("42")
            );
            assert_eq!(detail(&s, "Title"), Some("Old title → New title"));
            assert_eq!(detail(&s, "Labels"), Some("bug → bug, p1"));
            s.link_path_record("github-app", "api.github.com", "PATCH", &path);
            assert_eq!(detail(&s, "Endpoint"), Some(path.as_str()));
            assert!(s
                .details
                .iter()
                .any(|row| row.url.is_some() && row.value == "acme/docs#42"));
            assert_eq!(detail(&s, "Title"), Some("Old title → New title"));
        }
        for (method, suffix) in [
            ("PATCH", "git/refs/tags/v1"),
            ("PUT", "contents/file"),
            ("PUT", "pulls/42/merge"),
            ("POST", "issues/42/comments"),
        ] {
            let path = format!("/repos/acme/docs/{suffix}");
            let mut s = gh(method, &path, "{}");
            assert_eq!(detail(&s, "Endpoint"), Some(path.as_str()));
            s.link_path_record("github-app", "api.github.com", method, &path);
            if suffix.contains("42") {
                assert_eq!(
                    s.details
                        .iter()
                        .filter(|row| matches!(row.label.as_str(), "Issue" | "Pull request"))
                        .count(),
                    1
                );
                assert_eq!(detail(&s, "Endpoint"), Some(path.as_str()));
            }
        }
    }

    #[test]
    fn pull_requests_and_comments() {
        let s = gh(
            "POST",
            "/repos/a/b/pulls",
            r#"{"title":"Fix","head":"fix","base":"main","body":"Details"}"#,
        );
        assert_eq!(s.action, "Open pull request");
        assert_eq!(detail(&s, "Merge"), Some("fix into main"));
        assert_eq!(detail(&s, "Body"), Some("Details"));
        let s = gh(
            "POST",
            "/repos/a/b/pulls/1711/comments",
            r#"{"body":"LGTM"}"#,
        );
        assert_eq!(s.action, "Comment");
        assert!(gh("GET", "/repos/a/b/pulls", "").is_generic());
    }
}
