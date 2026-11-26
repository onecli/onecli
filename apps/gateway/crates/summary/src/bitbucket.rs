//! Bitbucket Cloud (REST API 2.0): approval cards in Bitbucket's terms on
//! top of the shared, redacted body reader. Every repository request reads
//! its path as Repository `workspace/repo` (plus Pull request or Branch)
//! instead of the generic reading ("Repository: acme"); the requests agents
//! make most also get Bitbucket's title ("Open pull request", "Merge pull
//! request #7"), and the sensitive reads a default grant holds say why they
//! ask. Every body field, the masking, the before/after read of an edit and
//! the endpoint row stay the generic reader's (see `generic.rs`).
//!
//! Registered as `"bitbucket"` in [`super::summarizer`]. Git over HTTPS on
//! bitbucket.org is read by `git.rs`, for every host.

use serde_json::Value;

use super::{
    decode_segment, generic, json_object, one_line, ApprovalDetail, ApprovalSummary,
    RequestSummarizer, SummaryRequest, MAX_VALUE_LEN,
};

pub(super) struct Bitbucket;

impl RequestSummarizer for Bitbucket {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let segs: Vec<String> = req
            .base_path()
            .split('/')
            .filter(|s| !s.is_empty())
            .map(decode_segment)
            .collect();
        let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
        let ["2.0", "repositories", workspace, repo, rest @ ..] = segs.as_slice() else {
            return None;
        };
        let method = req.method_upper();
        // Every repository request reads its path in Bitbucket's terms; the
        // routes named here also get Bitbucket's title (and "Why it asks").
        let named = card(&method, rest);

        let mut s = generic::summarize(req);
        if let Some((action, _)) = &named {
            s.action = one_line(action, MAX_VALUE_LEN);
        }
        // The generic reader names records from the path by its grammar
        // ("Repository: acme", "Pullrequest: 7"): replace those rows with what
        // the path means. They stay ahead of the body rows, and through a
        // before/after comparison, like the generic ones did.
        let mut path_rows = vec![row("Repository", &format!("{workspace}/{repo}"))];
        match rest {
            ["pullrequests", id, ..] if is_id(id) => path_rows.push(row("Pull request", id)),
            ["refs", "branches", name @ ..] if !name.is_empty() => {
                path_rows.push(row("Branch", &name.join("/")));
            }
            // The record's id as the generic reader named it ("Branch
            // restriction: 3"), without its repository reading.
            _ => path_rows.extend(
                s.fallback
                    .clone()
                    .and_then(|rows| s.details.get(rows))
                    .into_iter()
                    .flatten()
                    .filter(|d| d.label != "Repository")
                    .cloned(),
            ),
        }
        if let Some((_, Some(why))) = named {
            path_rows.push(row("Why it asks", why));
        }
        if method == "POST" && rest == ["pullrequests"] {
            if let Some(merge) = pull_request_merge(req) {
                path_rows.push(row("Merge", &merge));
            }
        }
        // A GraphQL-shaped body has no path rows (the generic reader marks
        // none, before any Endpoint row): keep the generic card as is.
        let generic_rows = s.fallback.take().filter(|rows| rows.start > 0)?;
        let start = generic_rows.start;
        let end = start + path_rows.len();
        s.details.splice(generic_rows, path_rows);
        // Marked as the path's rows, as the generic ones were. The body rows
        // stay the shared reader's, so card-kind telemetry counts this card
        // with the generic ones (as HeyReach's titled routes are).
        s.fallback = Some(start..end);
        Some(s)
    }
}

fn row(label: &str, value: &str) -> ApprovalDetail {
    ApprovalDetail {
        label: label.into(),
        value: one_line(value, MAX_VALUE_LEN),
        url: None,
    }
}

/// Pull request ids are numbers. Anything else in that slot is never put in
/// a title, where agent-chosen path text could read as a different action.
fn is_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
}

/// The title, and why a read a default grant holds asks first, for the
/// requests agents make in a repository. `None` keeps the generic title.
fn card(method: &str, rest: &[&str]) -> Option<(String, Option<&'static str>)> {
    let action = match (method, rest) {
        ("POST", ["pullrequests"]) => "Open pull request".into(),
        ("PUT", ["pullrequests", id]) if is_id(id) => format!("Edit pull request #{id}"),
        ("POST", ["pullrequests", id, "comments"]) if is_id(id) => {
            format!("Comment on pull request #{id}")
        }
        ("POST", ["pullrequests", id, "approve"]) if is_id(id) => {
            format!("Approve pull request #{id}")
        }
        ("DELETE", ["pullrequests", id, "approve"]) if is_id(id) => {
            format!("Withdraw approval of pull request #{id}")
        }
        ("POST", ["pullrequests", id, "merge"]) if is_id(id) => {
            format!("Merge pull request #{id}")
        }
        ("POST", ["pullrequests", id, "decline"]) if is_id(id) => {
            format!("Decline pull request #{id}")
        }
        ("POST", ["refs", "branches"]) => "Create branch".into(),
        ("DELETE", ["refs", "branches", name @ ..]) if !name.is_empty() => {
            format!("Delete branch {}", name.join("/"))
        }
        ("POST", []) => "Create repository".into(),
        ("DELETE", []) => "Delete repository".into(),
        ("GET", ["pipelines_config", "variables", ..]) => {
            return Some((
                "Read Pipelines variables".into(),
                Some("Unsecured variables are returned in clear text"),
            ));
        }
        ("GET", ["deployments_config", "environments", _, "variables", ..]) => {
            return Some((
                "Read deployment variables".into(),
                Some("Unsecured variables are returned in clear text"),
            ));
        }
        ("GET", ["deploy-keys", ..]) => {
            return Some((
                "Read deploy keys".into(),
                Some("Deploy keys grant access to the repository"),
            ));
        }
        ("GET", ["hooks", ..]) => {
            return Some((
                "Read webhooks".into(),
                Some("Webhook URLs can embed credentials"),
            ));
        }
        _ => return None,
    };
    Some((action, None))
}

/// "feature into main" for a new pull request. Bitbucket merges into the
/// repository's main branch when the body names no destination.
fn pull_request_merge(req: &SummaryRequest<'_>) -> Option<String> {
    let body = req.body.and_then(json_object)?;
    let branch = |side: &str| {
        body.get(side)?
            .get("branch")?
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
    };
    let source = branch("source")?;
    let destination = branch("destination").unwrap_or("the main branch");
    Some(format!("{source} into {destination}"))
}

#[cfg(test)]
mod tests {
    use crate::{summarize_request, ApprovalSummary};

    fn card(method: &str, path: &str, body: &str) -> ApprovalSummary {
        summarize_request(
            "bitbucket",
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

    fn labels(s: &ApprovalSummary) -> Vec<&str> {
        s.details.iter().map(|d| d.label.as_str()).collect()
    }

    const R: &str = "/2.0/repositories/acme/web";

    #[test]
    fn open_pull_request_names_repository_and_branches_and_keeps_every_field() {
        let s = card(
            "POST",
            &format!("{R}/pullrequests"),
            r#"{"title":"Add hello","description":"Adds a greeting","source":{"branch":{"name":"feature-x"}},"destination":{"branch":{"name":"main"}},"close_source_branch":true}"#,
        );
        assert_eq!(s.action, "Open pull request");
        assert_eq!(
            labels(&s)[..3],
            ["Endpoint", "Repository", "Merge"],
            "{s:?}"
        );
        assert_eq!(detail(&s, "Repository"), Some("acme/web"));
        assert_eq!(detail(&s, "Merge"), Some("feature-x into main"));
        assert_eq!(detail(&s, "Title"), Some("Add hello"));
        assert_eq!(detail(&s, "Description"), Some("Adds a greeting"));
        assert_eq!(detail(&s, "Close source branch"), Some("true"));
        assert_eq!(labels(&s).iter().filter(|l| **l == "Repository").count(), 1);
    }

    #[test]
    fn a_pull_request_without_destination_merges_into_the_main_branch() {
        let s = card(
            "POST",
            &format!("{R}/pullrequests"),
            r#"{"title":"T","source":{"branch":{"name":"feature-x"}}}"#,
        );
        assert_eq!(detail(&s, "Merge"), Some("feature-x into the main branch"));
        let s = card("POST", &format!("{R}/pullrequests"), r#"{"title":"T"}"#);
        assert_eq!(detail(&s, "Merge"), None);
    }

    #[test]
    fn pull_request_actions_are_named() {
        for (method, suffix, body, action) in [
            (
                "PUT",
                "pullrequests/7",
                r#"{"title":"New"}"#,
                "Edit pull request #7",
            ),
            (
                "POST",
                "pullrequests/7/comments",
                r#"{"content":{"raw":"looks good"}}"#,
                "Comment on pull request #7",
            ),
            (
                "POST",
                "pullrequests/7/approve",
                "",
                "Approve pull request #7",
            ),
            (
                "DELETE",
                "pullrequests/7/approve",
                "",
                "Withdraw approval of pull request #7",
            ),
            (
                "POST",
                "pullrequests/7/merge",
                r#"{"merge_strategy":"squash"}"#,
                "Merge pull request #7",
            ),
            (
                "POST",
                "pullrequests/7/decline",
                "",
                "Decline pull request #7",
            ),
            (
                "POST",
                "refs/branches",
                r#"{"name":"feature-x","target":{"hash":"abc"}}"#,
                "Create branch",
            ),
            (
                "DELETE",
                "refs/branches/feature/x",
                "",
                "Delete branch feature/x",
            ),
            ("POST", "", r#"{"scm":"git"}"#, "Create repository"),
            ("DELETE", "", "", "Delete repository"),
        ] {
            let path = if suffix.is_empty() {
                R.to_string()
            } else {
                format!("{R}/{suffix}")
            };
            let s = card(method, &path, body);
            assert_eq!(s.action, action, "{method} {path}");
            assert_eq!(
                detail(&s, "Repository"),
                Some("acme/web"),
                "{method} {path}"
            );
            assert_eq!(
                detail(&s, "Endpoint"),
                Some(path.as_str()),
                "{method} {path}"
            );
            if suffix.starts_with("pullrequests/") {
                assert_eq!(detail(&s, "Pull request"), Some("7"), "{method} {path}");
            }
            // The path reads once, in Bitbucket's words.
            assert_eq!(detail(&s, "Pullrequest"), None, "{method} {path}");
            assert_eq!(
                labels(&s).iter().filter(|l| **l == "Repository").count(),
                1,
                "{method} {path}"
            );
        }
        let s = card("DELETE", &format!("{R}/refs/branches/feature/x"), "");
        assert_eq!(detail(&s, "Branch"), Some("feature/x"));
        let s = card(
            "POST",
            &format!("{R}/pullrequests/7/comments"),
            r#"{"content":{"raw":"looks good"},"inline":{"path":"src/lib.rs","to":3}}"#,
        );
        assert!(s.details.iter().any(|d| d.value == "looks good"));
        assert!(s.details.iter().any(|d| d.value == "src/lib.rs"));
    }

    #[test]
    fn an_edit_reads_back_its_pull_request_for_before_and_after() {
        let path = format!("{R}/pullrequests/7");
        let body = br#"{"title":"New title"}"#;
        let mut s = card("PUT", &path, std::str::from_utf8(body).unwrap());
        assert_eq!(
            s.change_hint().map(|h| h.read_path.as_str()),
            Some(path.as_str())
        );
        s.apply_current(body, br#"{"title":"Old title","id":7}"#);
        assert_eq!(s.action, "Edit pull request #7");
        assert_eq!(detail(&s, "Repository"), Some("acme/web"));
        assert_eq!(detail(&s, "Pull request"), Some("7"));
        assert_eq!(detail(&s, "Title"), Some("Old title → New title"));
    }

    #[test]
    fn sensitive_reads_say_what_and_why() {
        for (suffix, action, why) in [
            (
                "pipelines_config/variables",
                "Read Pipelines variables",
                "Unsecured variables are returned in clear text",
            ),
            (
                "deployments_config/environments/%7Be1%7D/variables",
                "Read deployment variables",
                "Unsecured variables are returned in clear text",
            ),
            (
                "deploy-keys",
                "Read deploy keys",
                "Deploy keys grant access to the repository",
            ),
            (
                "hooks",
                "Read webhooks",
                "Webhook URLs can embed credentials",
            ),
        ] {
            let s = card("GET", &format!("{R}/{suffix}"), "");
            assert_eq!(s.action, action);
            assert_eq!(detail(&s, "Repository"), Some("acme/web"));
            assert_eq!(detail(&s, "Why it asks"), Some(why));
        }
    }

    #[test]
    fn a_secret_in_the_body_is_masked() {
        let s = card(
            "POST",
            &format!("{R}/pullrequests"),
            r#"{"title":"T","source":{"branch":{"name":"x"}},"token":"bbtok-123"}"#,
        );
        assert!(!s.render_text().contains("bbtok-123"));
    }

    #[test]
    fn path_text_never_rewrites_the_title() {
        // A non-numeric pull request id is no pull request: the generic title.
        let path = format!("{R}/pullrequests/7%20and%20delete%20repository/merge");
        let s = card("POST", &path, "");
        assert!(!s.action.contains("delete repository"), "{}", s.action);
        assert_eq!(detail(&s, "Pull request"), None);
        assert_eq!(detail(&s, "Repository"), Some("acme/web"));
        // A branch name reads on one line.
        let s = card("DELETE", &format!("{R}/refs/branches/a%0Ab"), "");
        assert_eq!(s.action, "Delete branch a b");
        assert_eq!(detail(&s, "Branch"), Some("a b"));
    }

    #[test]
    fn requests_it_does_not_name_keep_the_generic_title_and_body() {
        for (method, path, body) in [
            (
                "PUT",
                format!("{R}/branch-restrictions/3"),
                r#"{"kind":"push"}"#,
            ),
            ("GET", format!("{R}/pullrequests"), ""),
            (
                "POST",
                format!("{R}/pipelines"),
                r#"{"target":{"ref_name":"main"}}"#,
            ),
        ] {
            let s = card(method, &path, body);
            let generic = crate::generic::summarize(&crate::SummaryRequest {
                method,
                path: &path,
                content_type: Some("application/json"),
                body: (!body.is_empty()).then_some(body.as_bytes()),
            });
            assert_eq!(s.action, generic.action, "{method} {path}");
            // The path still reads in Bitbucket's terms, never as the
            // generic reader's half repository ("Repository: acme").
            assert_eq!(
                detail(&s, "Repository"),
                Some("acme/web"),
                "{method} {path}"
            );
            assert_eq!(labels(&s).iter().filter(|l| **l == "Repository").count(), 1);
            assert_eq!(detail(&s, "Why it asks"), None);
            // Every row the generic card shows beyond its path reading is
            // still there.
            let path_rows = generic.fallback.clone().unwrap_or(0..0);
            for (i, row) in generic.details.iter().enumerate() {
                if !path_rows.contains(&i) {
                    assert!(s.details.contains(row), "{method} {path}: lost {row:?}");
                }
            }
        }
        // A record the path names keeps its row beside the repository.
        let s = card("PUT", &format!("{R}/branch-restrictions/3"), "{}");
        assert_eq!(detail(&s, "Branch restriction"), Some("3"));
        // Outside a repository, the generic card is used unchanged.
        let path = "/2.0/user/workspaces";
        assert_eq!(
            card("GET", path, ""),
            crate::generic::summarize(&crate::SummaryRequest {
                method: "GET",
                path,
                content_type: Some("application/json"),
                body: None,
            })
        );
    }
}
