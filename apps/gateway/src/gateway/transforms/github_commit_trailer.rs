//! Inject agent identity into GitHub commit bodies.
//!
//! When the gateway creates commits on behalf of an agent using a GitHub App
//! installation token, the commit has no natural author identity. This module
//! prefixes the agent name onto the commit message and appends an
//! `On-Behalf-Of` trailer for traceability.
//!
//! Invoked via the `BodyTransform::GitHubCommitTrailer` dispatch in `forward.rs`.
//! All GitHub-specific logic (host, method, path checks) is encapsulated here.

use hyper::Method;
use tracing::debug;

/// Agent identity to inject into commit messages.
struct AgentCommitIdentity<'a> {
    agent_name: &'a str,
    project_id: &'a str,
}

/// Attempt to inject a commit identity trailer into the request body.
///
/// Checks internally whether this is a GitHub commit-creating endpoint.
/// Returns the body unchanged if no modification is needed.
pub(crate) async fn try_inject_trailer(
    host: &str,
    method: &Method,
    path: &str,
    body: reqwest::Body,
    agent_name: &str,
    project_id: &str,
) -> anyhow::Result<reqwest::Body> {
    if !is_commit_request(host, method, path) {
        return Ok(body);
    }

    let identity = AgentCommitIdentity {
        agent_name,
        project_id,
    };

    let bytes = super::super::body::buffer_body(body).await?;
    match inject_commit_trailer(&bytes, &identity) {
        Some(modified) => Ok(reqwest::Body::from(modified)),
        None => Ok(reqwest::Body::from(bytes)),
    }
}

/// Check if this request targets a GitHub commit-creating endpoint.
fn is_commit_request(host: &str, method: &Method, path: &str) -> bool {
    let hostname = host.split(':').next().unwrap_or(host);
    if hostname != "api.github.com" {
        return false;
    }

    if !matches!(method, &Method::PUT | &Method::POST) {
        return false;
    }

    is_commit_endpoint(method, path)
}

/// Prefixes the agent name and appends an `On-Behalf-Of` trailer to the
/// commit message. Returns `None` if no modification was needed.
fn inject_commit_trailer(body: &[u8], identity: &AgentCommitIdentity) -> Option<Vec<u8>> {
    let mut json: serde_json::Value = serde_json::from_slice(body).ok()?;
    let obj = json.as_object_mut()?;

    let message = obj
        .get_mut("message")
        .and_then(|v| v.as_str().map(String::from))?;
    let prefix = format!("[{}] ", identity.agent_name);
    let trailer = format!(
        "\n\nOn-Behalf-Of: {}[onecli] ({})",
        identity.agent_name, identity.project_id
    );
    if message.contains("On-Behalf-Of:") {
        return None;
    }

    let new_message = if message.starts_with(&prefix) {
        format!("{message}{trailer}")
    } else {
        format!("{prefix}{message}{trailer}")
    };
    obj.insert(
        "message".to_string(),
        serde_json::Value::String(new_message),
    );

    debug!(
        agent = identity.agent_name,
        "injected On-Behalf-Of trailer into commit message"
    );
    serde_json::to_vec(&json).ok()
}

/// Returns true if the path matches a GitHub commit-creating endpoint
/// that uses a `message` field for the commit message.
///
/// Note: merge endpoints (POST /merges, PUT /pulls/:number/merge) are
/// excluded because they use `commit_message`/`commit_title` with
/// different semantics (appended to auto-generated messages).
fn is_commit_endpoint(method: &Method, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);

    // PUT /repos/:owner/:repo/contents/:path
    if method == Method::PUT && is_contents_path(path) {
        return true;
    }

    // POST /repos/:owner/:repo/git/commits
    if method == Method::POST && is_git_commits_path(path) {
        return true;
    }

    false
}

fn is_contents_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    segments.len() >= 5 && segments[0] == "repos" && segments[3] == "contents"
}

fn is_git_commits_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    segments.len() == 5
        && segments[0] == "repos"
        && segments[3] == "git"
        && segments[4] == "commits"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_contents_put() {
        assert!(is_commit_request(
            "api.github.com",
            &Method::PUT,
            "/repos/owner/repo/contents/path/to/file.md",
        ));
    }

    #[test]
    fn detects_git_commits_post() {
        assert!(is_commit_request(
            "api.github.com",
            &Method::POST,
            "/repos/owner/repo/git/commits",
        ));
    }

    #[test]
    fn skips_merge_endpoints() {
        assert!(!is_commit_request(
            "api.github.com",
            &Method::POST,
            "/repos/owner/repo/merges",
        ));
        assert!(!is_commit_request(
            "api.github.com",
            &Method::PUT,
            "/repos/owner/repo/pulls/42/merge",
        ));
    }

    #[test]
    fn skips_non_commit_endpoints() {
        assert!(!is_commit_request(
            "api.github.com",
            &Method::POST,
            "/repos/owner/repo/issues",
        ));
    }

    #[test]
    fn skips_get_requests() {
        assert!(!is_commit_request(
            "api.github.com",
            &Method::GET,
            "/repos/owner/repo/contents/file.md",
        ));
    }

    #[test]
    fn skips_non_github_host() {
        assert!(!is_commit_request(
            "api.gitlab.com",
            &Method::PUT,
            "/repos/owner/repo/contents/file.md",
        ));
    }

    #[test]
    fn injects_trailer() {
        let body = serde_json::json!({
            "message": "Create file",
            "content": "SGVsbG8=",
        });
        let identity = AgentCommitIdentity {
            agent_name: "deploy-bot",
            project_id: "proj_abc123",
        };

        let result = inject_commit_trailer(body.to_string().as_bytes(), &identity).unwrap();
        let modified: serde_json::Value = serde_json::from_slice(&result).unwrap();

        let msg = modified["message"].as_str().unwrap();
        assert!(msg.starts_with("[deploy-bot] Create file"));
        assert!(msg.contains("On-Behalf-Of: deploy-bot[onecli] (proj_abc123)"));
    }

    #[test]
    fn does_not_duplicate_trailer() {
        let body = serde_json::json!({
            "message": "Create file\n\nOn-Behalf-Of: someone",
            "content": "SGVsbG8=",
        });
        let identity = AgentCommitIdentity {
            agent_name: "deploy-bot",
            project_id: "proj_abc123",
        };

        let result = inject_commit_trailer(body.to_string().as_bytes(), &identity);
        assert!(result.is_none());
    }

    #[test]
    fn handles_path_with_query_string() {
        assert!(is_commit_request(
            "api.github.com",
            &Method::PUT,
            "/repos/owner/repo/contents/file.md?ref=main",
        ));
    }
}
