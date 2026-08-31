//! GitHub App — token-level granular access.
//!
//! GitHub installation tokens can be minted scoped to specific repositories, so
//! an agent's repo allowlist (`session_policy.repositories`) is enforced
//! upstream by GitHub: we request a token limited to those repos and forward it
//! unchanged. No request-level inspection is needed.

use serde_json::Value;

use super::{ResourceAxis, TokenScoper};

pub(super) struct GithubApp;

/// Repositories are named, not nested: one is inside another only by being the
/// same one. Comparison is case-insensitive — GitHub owner/repo names are, and
/// a policy written through the API in another case must still match.
impl ResourceAxis for GithubApp {
    fn key(&self) -> &'static str {
        "repositories"
    }

    fn normalize(&self, entry: &str) -> String {
        entry.to_ascii_lowercase()
    }

    fn covered_by(&self, entry: &str, boundary: &[String]) -> bool {
        let entry = self.normalize(entry);
        boundary.iter().any(|b| self.normalize(b) == entry)
    }
}

#[async_trait::async_trait]
impl TokenScoper for GithubApp {
    async fn scope(&self, creds: &Value, policy: &Value) -> Option<anyhow::Result<(String, i64)>> {
        let repos = repositories(policy);
        if repos.is_empty() {
            // An ABSENT list means no scoping was requested, so the caller
            // falls through to the normal (unscoped) refresh. An explicitly
            // EMPTY list means the opposite — reach nothing — and must never
            // reach that fall-through: GitHub omits the `repositories` field
            // from the mint request and hands back a token for EVERY repo on
            // the installation. `denies_everything` blocks such a request
            // before injection, so this is defence in depth for any future
            // caller that skips it.
            if super::denies_everything(Some(policy)) {
                return Some(Err(anyhow::anyhow!(
                    "empty repository allowlist denies all access; refusing to mint an unscoped token"
                )));
            }
            return None;
        }
        let pk = creds.get("private_key").and_then(|v| v.as_str());
        let aid = creds.get("app_id").and_then(|v| v.as_str());
        let iid = creds.get("installation_id").and_then(|v| v.as_str());
        let (Some(pk), Some(aid), Some(iid)) = (pk, aid, iid) else {
            return Some(Err(anyhow::anyhow!(
                "GitHub App credentials incomplete, cannot refresh"
            )));
        };
        Some(apps::refresh_github_app_token(pk, aid, iid, Some(&repos)).await)
    }
}

/// The repository allowlist from the policy. Empty = unscoped.
fn repositories(policy: &Value) -> Vec<String> {
    policy
        .get("repositories")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{repositories, GithubApp};
    use crate::granular_access::ResourceAxis;

    #[test]
    fn empty_when_no_repositories() {
        assert!(repositories(&serde_json::json!({})).is_empty());
        assert!(repositories(&serde_json::json!({ "repositories": [] })).is_empty());
    }

    #[test]
    fn extracts_repository_list() {
        let policy = serde_json::json!({ "repositories": ["org/a", "org/b"] });
        assert_eq!(repositories(&policy), vec!["org/a", "org/b"]);
    }

    #[test]
    fn coverage_is_exact_and_case_insensitive() {
        let boundary = vec!["org/a".to_string(), "org/b".to_string()];
        assert!(GithubApp.covered_by("org/a", &boundary));
        assert!(GithubApp.covered_by("ORG/A", &boundary));
        assert!(!GithubApp.covered_by("org/c", &boundary));
        // Repositories do not nest: a name is not "inside" a longer name.
        assert!(!GithubApp.covered_by("org/a-extra", &boundary));
        assert!(!GithubApp.covered_by("org", &boundary));
    }

    #[test]
    fn intersect_keeps_the_common_repositories_sorted_and_deduped() {
        let a = vec!["org/b".to_string(), "org/a".to_string()];
        let b = vec![
            "ORG/A".to_string(),
            "org/c".to_string(),
            "org/a".to_string(),
        ];
        assert_eq!(GithubApp.intersect(&a, &b), vec!["org/a".to_string()]);
        // Disjoint sets overlap in nothing — the deny-all sentinel.
        let disjoint = vec!["org/z".to_string()];
        assert!(GithubApp.intersect(&a, &disjoint).is_empty());
    }
}
