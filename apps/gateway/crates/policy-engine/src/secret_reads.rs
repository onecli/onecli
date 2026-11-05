//! Requests the gateway holds for approval whatever the policy allows: their
//! answer hands the agent a live secret, so no grant may let one through
//! unseen. The live seam (`enforce.rs`) applies this after the rules decide
//! and before any rate counter: an allow becomes an approval, a block stays a
//! block, and a rule that already asks keeps its own approval.
//!
//! Only a credentialed request is held. Without one, the agent's own token
//! makes the call, and it returns only what that token already reads.
//!
//! It sits outside the rule engine (`evaluate.rs`) and its TypeScript twin on
//! purpose: the rules' meaning is unchanged, so the shared corpus still holds,
//! and the dashboard's reflections only ever probe catalog tool paths, none of
//! them under such a segment.
//!
//! GitHub's secret scanning alerts carry the leaked secret itself (the
//! alert's `secret` field in the REST reference, on the repository,
//! organization and enterprise lists, one alert, and the enterprise's public
//! monitoring alerts). A grant that reads a repository (`/repos/*/*` covers
//! deeper paths) or allows "All other reads" would otherwise return them.
//! Everything under a `secret-scanning` segment is held, for every method,
//! so a new GitHub endpoint there is covered before anyone lists it.
//! GitHub's GraphQL API exposes no secret scanning alerts, webhook configs
//! return their secret masked, and Actions variables are not secrets, so
//! none of those is held.
//!
//! The match is looser than GitHub's router on purpose. GitHub routes paths
//! case-insensitively and serves the `/repositories/{id}` and
//! `/organizations/{id}` aliases, and the upstream URL parser reads `\` as
//! `/` and resolves `..`. So any segment equal to `secret-scanning`,
//! ignoring ASCII case, after percent-decoding, holds the request. A
//! repository or owner named exactly `secret-scanning` asks too: the safe
//! side.

use common::util::strip_port;

/// A host whose requests under `segment` return secrets.
struct SecretRead {
    host: &'static str,
    segment: &'static str,
    /// The approval card's "Why it asks" row.
    why: &'static str,
}

const SECRET_READS: &[SecretRead] = &[SecretRead {
    host: "api.github.com",
    segment: "secret-scanning",
    why: "Secret scanning alerts include the leaked secret in clear text",
}];

/// Why this request is held whatever the rules say, or `None` when the rules
/// decide alone. `path` may carry a query string; `has_injections` is whether
/// the gateway adds a credential to the request.
#[must_use]
pub fn secret_read(host: &str, path: &str, has_injections: bool) -> Option<&'static str> {
    if !has_injections {
        return None;
    }
    let host = strip_port(host).trim_end_matches('.');
    let read = SECRET_READS
        .iter()
        .find(|read| host.eq_ignore_ascii_case(read.host))?;
    // Every credentialed request gets here: decode the path only on a listed host.
    let path = path.split('?').next().unwrap_or(path);
    percent_encoding::percent_decode_str(path)
        .decode_utf8_lossy()
        .split(['/', '\\'])
        .any(|segment| segment.eq_ignore_ascii_case(read.segment))
        .then_some(read.why)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GH: &str = "api.github.com";

    fn held(host: &str, path: &str) -> bool {
        secret_read(host, path, true).is_some()
    }

    #[test]
    fn every_documented_alert_endpoint_is_held() {
        for path in [
            "/repos/acme/web/secret-scanning/alerts",
            "/repos/acme/web/secret-scanning/alerts/7",
            "/repos/acme/web/secret-scanning/alerts/7/locations",
            "/orgs/acme/secret-scanning/alerts?state=open&per_page=100",
            "/enterprises/acme/secret-scanning/alerts",
            "/enterprises/acme/secret-scanning/public-monitoring-alerts",
            "/enterprises/acme/secret-scanning/public-monitoring-alerts/3",
            // GitHub's id aliases route to the same lists.
            "/repositories/42/secret-scanning/alerts",
            "/organizations/9919/secret-scanning/alerts",
        ] {
            assert!(held(GH, path), "{path}");
        }
    }

    #[test]
    fn spellings_github_or_the_upstream_parser_reads_the_same_are_held() {
        for path in [
            // GitHub routes paths case-insensitively.
            "/REPOS/acme/web/SECRET-SCANNING/ALERTS",
            "/orgs/acme/Secret-Scanning/alerts",
            // The upstream URL parser reads `\` as `/` and resolves `..`.
            "/repos/acme/web\\secret-scanning\\alerts",
            "/repos/acme/web/x/../secret-scanning/alerts",
            "/repos/acme/web/%2e%2e/web/secret-scanning/alerts",
            // Percent-encoded, in whole or in part.
            "/repos/acme/web/secret%2Dscanning/alerts",
            "/repos/acme/web/%73ecret-scanning/alerts",
            "/repos/acme/web/secret-scanning%2Falerts",
        ] {
            assert!(held(GH, path), "{path}");
        }
    }

    #[test]
    fn the_host_is_read_like_a_host() {
        let path = "/repos/acme/web/secret-scanning/alerts";
        for host in ["API.GitHub.com", "api.github.com:443", "api.github.com."] {
            assert!(held(host, path), "{host}");
        }
        for host in ["github.com", "api.github.com.evil.com", "api.bitbucket.org"] {
            assert!(!held(host, path), "{host}");
        }
    }

    #[test]
    fn other_reads_and_lookalike_names_are_left_to_the_rules() {
        for path in [
            "/repos/acme/web",
            "/repos/acme/web/contents/README.md",
            "/installation/repositories",
            // A repository whose name only contains the words.
            "/repos/acme/secret-scanning-demo/pulls",
            "/repos/acme/web/secretscanning/alerts",
            "/repos/acme/web/secret_scanning/alerts",
            // Only the path is read, never the query.
            "/search/code?q=secret-scanning",
            "/repos/acme/web/issues?labels=/secret-scanning/",
        ] {
            assert!(!held(GH, path), "{path}");
        }
    }

    #[test]
    fn an_uncredentialed_request_is_left_to_the_rules() {
        assert_eq!(
            secret_read(GH, "/orgs/acme/secret-scanning/alerts", false),
            None
        );
    }

    #[test]
    fn the_reviewer_is_told_why() {
        assert_eq!(
            secret_read(GH, "/orgs/acme/secret-scanning/alerts", true),
            Some("Secret scanning alerts include the leaked secret in clear text")
        );
    }
}
