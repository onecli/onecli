//! GitHub organization access for OAuth connections.
//!
//! A GitHub OAuth connection can be perfectly healthy for the user's own
//! repositories and still be refused by one organization, for one of two
//! reasons only that organization can lift:
//!
//! - **Approval**: the organization restricts OAuth apps and has not approved
//!   this one. GitHub answers 403 with a message naming the organization
//!   ("… the `ORG` organization has enabled OAuth App access restrictions …").
//!   The user requests access, an organization owner grants it.
//! - **SSO**: the organization enforces SAML single sign-on and the token was
//!   not authorized for it. GitHub answers 403 with
//!   `X-GitHub-SSO: required; url=https://github.com/orgs/ORG/sso?…`. An OAuth
//!   app's token is only authorized for an SSO organization when the user had
//!   an active SSO session at the time they authorized the app, so the fix is
//!   "sign in to the organization's SSO, then reconnect". Following the URL in
//!   the header alone does not authorize the token already stored.
//!
//! Both are per-organization states of a connection that is otherwise
//! connected, so they are recorded per organization on the connection's
//! metadata (`githubOrgAccess.<org>`) and surfaced on the dashboard. A record
//! is cleared by a reconnect (which replaces the metadata) or once the refused
//! endpoint itself answers (see [`OrgAccessEntry::cleared_by`]). The agent
//! gets one actionable, non-retryable answer instead of GitHub's raw body
//! (whose SSO link changes on every call and invites a retry loop).

use hyper::header::HeaderMap;
use hyper::{Method, StatusCode};

/// The provider whose OAuth token these refusals concern. A GitHub App
/// (`github-app`) installation token is authorized by the installation
/// itself, so neither refusal applies to it.
pub const GITHUB_OAUTH_PROVIDER: &str = "github";

/// The REST API host the refusals are read from.
const GITHUB_API_HOST: &str = "api.github.com";

/// Metadata key the per-organization states live under. Shared with the
/// dashboard (`packages/api/src/lib/github-org-access.ts`).
const METADATA_KEY: &str = "githubOrgAccess";

/// Gateway error code of the guidance answer.
pub const ERROR_CODE: &str = "github_org_access_required";

/// Upper bound on the 403 body read to classify it, and on its decoded size.
/// GitHub's error bodies are a few hundred bytes; anything larger is not one
/// of these refusals.
pub const BODY_LIMIT: usize = 8 * 1024;

/// Path segments kept in a stored endpoint: `repos/ORG/REPO/pulls`.
const ENDPOINT_SEGMENTS: usize = 4;

/// Longest segment kept in a stored endpoint (GitHub repository names are at
/// most 100 characters), so the stored string stays short.
const MAX_SEGMENT_LEN: usize = 100;

/// Why an organization refused the connection's token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The organization has not approved this OAuth app.
    ApprovalRequired,
    /// The token is not authorized for the organization's SAML SSO.
    SsoRequired,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::ApprovalRequired => "approval_required",
            Reason::SsoRequired => "sso_required",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "approval_required" => Some(Reason::ApprovalRequired),
            "sso_required" => Some(Reason::SsoRequired),
            _ => None,
        }
    }
}

/// One organization's refusal, as read from GitHub's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgRefusal {
    /// The organization login, lowercased: GitHub logins are
    /// case-insensitive, and its messages keep the display casing while
    /// request paths use whatever the agent typed.
    pub org: String,
    pub reason: Reason,
}

/// A refusal as stored on the connection: why, and the request that was
/// refused (its endpoint, `None` unless the path addresses the refused
/// organization, and whether it wrote).
#[derive(Debug, Clone, PartialEq, Eq)]
struct OrgAccessEntry {
    reason: Reason,
    endpoint: Option<String>,
    write: bool,
}

impl OrgAccessEntry {
    /// The entry for `refusal` of `method path`. The endpoint is kept only
    /// when the path addresses the refused organization (`/repos/ORG/…`,
    /// `/orgs/ORG/…`): a success elsewhere (`/search`, which silently omits
    /// what the token cannot see) proves nothing about it.
    fn new(refusal: &OrgRefusal, method: &Method, path: &str) -> Self {
        let endpoint = endpoint(path).filter(|e| {
            let mut segments = e.split('/');
            matches!(segments.next(), Some("repos" | "orgs"))
                && segments.next() == Some(refusal.org.as_str())
        });
        Self {
            reason: refusal.reason,
            endpoint,
            write: is_write(method),
        }
    }

    /// Whether a successful `method path` proves the organization lets the
    /// token in again. Neither refusal hides an organization's PUBLIC side:
    /// an unapproved OAuth app still reads (and forks) public repositories,
    /// and an SSO organization still serves them without a session. So an
    /// unrelated success proves nothing, and neither does a read of an
    /// endpoint whose WRITE was refused (it may be publicly readable). Proof
    /// is the refused endpoint answering with at least the refused access.
    /// An entry without an endpoint is only cleared by a reconnect.
    fn cleared_by(&self, method: &Method, path: &str) -> bool {
        self.endpoint.is_some()
            && self.endpoint == endpoint(path)
            && (is_write(method) || !self.write)
    }

    /// The stored JSON shape (`githubOrgAccess.<org>`), also read by the
    /// dashboard.
    fn to_json(&self) -> serde_json::Value {
        let mut entry = serde_json::json!({
            "reason": self.reason.as_str(),
            "write": self.write,
        });
        if let Some(endpoint) = &self.endpoint {
            entry["endpoint"] = serde_json::Value::String(endpoint.clone());
        }
        entry
    }

    /// The entry [`Self::to_json`] stored; `None` for anything malformed.
    fn from_json(value: &serde_json::Value) -> Option<Self> {
        Some(Self {
            reason: Reason::parse(value.get("reason")?.as_str()?)?,
            endpoint: value
                .get("endpoint")
                .and_then(|e| e.as_str())
                .map(str::to_string),
            write: value
                .get("write")
                .and_then(|w| w.as_bool())
                .unwrap_or(false),
        })
    }
}

/// Whether this request is one whose upstream answer is worth classifying:
/// the GitHub OAuth connection injected its token into a REST API call.
pub fn applies(hostname: &str, winning_provider: Option<&str>, injection_count: usize) -> bool {
    injection_count > 0
        && winning_provider == Some(GITHUB_OAUTH_PROVIDER)
        && hostname.eq_ignore_ascii_case(GITHUB_API_HOST)
}

/// GitHub organization logins: alphanumerics and single inner hyphens, at
/// most 39 characters. Anything else read out of a header or a body is
/// rejected, so the value can be embedded in URLs and stored as a JSON key.
fn is_valid_org_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !login.starts_with('-')
        && !login.ends_with('-')
}

/// A validated login, lowercased.
fn org_login(raw: &str) -> Option<String> {
    is_valid_org_login(raw).then(|| raw.to_ascii_lowercase())
}

fn is_write(method: &Method) -> bool {
    !method.is_safe()
}

/// The endpoint a REST path addresses: its first [`ENDPOINT_SEGMENTS`]
/// segments, lowercased (GitHub owner and repository names are
/// case-insensitive), e.g. `repos/acme/api/pulls` for
/// `/repos/Acme/API/pulls/1?state=open`. `None` for a single-segment path
/// (`/graphql`, `/user`), which names no particular resource and so proves
/// nothing about one, and for a segment that is not plain `[A-Za-z0-9._-]`
/// (GitHub's repository-name alphabet), so a stored endpoint is always a
/// short, inert string.
fn endpoint(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let segments: Vec<&str> = path
        .trim_start_matches('/')
        .split('/')
        .take(ENDPOINT_SEGMENTS)
        .take_while(|s| !s.is_empty())
        .collect();
    let plain = |s: &&str| {
        s.len() <= MAX_SEGMENT_LEN
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    (segments.len() >= 2 && segments.iter().all(plain))
        .then(|| segments.join("/").to_ascii_lowercase())
}

/// The organization an `X-GitHub-SSO: required; url=…/orgs/ORG/sso?…` header
/// names. `partial-results` (a listing that silently omitted SSO orgs) is not
/// a refusal and yields nothing.
fn sso_org(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("x-github-sso")?.to_str().ok()?;
    let mut parts = value.split(';').map(str::trim);
    if !parts.next()?.eq_ignore_ascii_case("required") {
        return None;
    }
    let url = parts.find_map(|p| p.strip_prefix("url="))?;
    let after = url.split("/orgs/").nth(1)?;
    org_login(after.split(['/', '?', '#']).next()?)
}

/// The organization an OAuth-app-restriction 403 body names: GitHub's
/// message reads "... the `ORG` organization has enabled OAuth App access
/// restrictions …" (the org quoted in single quotes or backticks).
fn restricted_org(body: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    let message = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("message")?.as_str().map(str::to_string))
        .unwrap_or_else(|| text.to_string());
    let marker = "organization has enabled OAuth App access restrictions";
    let before = message[..message.find(marker)?].trim_end();
    let quote = before.chars().last().filter(|c| *c == '\'' || *c == '`')?;
    let inner = &before[..before.len() - quote.len_utf8()];
    org_login(&inner[inner.rfind(quote)? + quote.len_utf8()..])
}

/// Classify a 403 from the GitHub REST API. The SSO header is checked first:
/// it is authoritative and needs no body. The body (`head`: its start as read
/// off the wire, possibly gzipped; only the first [`BODY_LIMIT`] decoded
/// bytes are looked at) is consulted only when the header is absent.
pub fn classify(status: StatusCode, headers: &HeaderMap, head: &[u8]) -> Option<OrgRefusal> {
    if status != StatusCode::FORBIDDEN {
        return None;
    }
    if let Some(org) = sso_org(headers) {
        return Some(OrgRefusal {
            org,
            reason: Reason::SsoRequired,
        });
    }
    restricted_org(&crate::body::decoded(headers, head, BODY_LIMIT)?).map(|org| OrgRefusal {
        org,
        reason: Reason::ApprovalRequired,
    })
}

/// The `githubOrgAccess` record of connection `connection_id` among `rows`
/// (the cached connect response's connections), when it is the GitHub OAuth
/// connection. Every other connection carries nothing, so the per-request
/// rules never copy metadata no one reads.
pub fn record_for(
    rows: &[db::AppConnectionRow],
    connection_id: Option<&str>,
) -> Option<serde_json::Value> {
    let id = connection_id?;
    let row = rows
        .iter()
        .find(|row| row.id == id && row.provider == GITHUB_OAUTH_PROVIDER)?;
    row.metadata.as_ref()?.get(METADATA_KEY).cloned()
}

/// A change to a connection's `githubOrgAccess` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordWrite {
    /// Store `entry` for `org`.
    Record {
        org: String,
        entry: serde_json::Value,
    },
    /// Drop `org`'s entry while it is still `expected` (the stored value the
    /// proof was checked against).
    Clear {
        org: String,
        expected: serde_json::Value,
    },
}

/// What GitHub's answer to `method path` changes in `record` (the cached
/// `githubOrgAccess` record): the refusal to store, or the entries the
/// success proves stale. Empty when the cache already agrees, so a healthy
/// GitHub call never costs a write.
pub fn record_writes(
    record: Option<&serde_json::Value>,
    refusal: Option<&OrgRefusal>,
    status: StatusCode,
    method: &Method,
    path: &str,
) -> Vec<RecordWrite> {
    if let Some(refusal) = refusal {
        let entry = OrgAccessEntry::new(refusal, method, path).to_json();
        let known = record.and_then(|r| r.get(&refusal.org)) == Some(&entry);
        return if known {
            Vec::new()
        } else {
            vec![RecordWrite::Record {
                org: refusal.org.clone(),
                entry,
            }]
        };
    }
    if !status.is_success() {
        return Vec::new();
    }
    let Some(entries) = record.and_then(|r| r.as_object()) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|(_, value)| {
            OrgAccessEntry::from_json(value).is_some_and(|e| e.cleared_by(method, path))
        })
        .map(|(org, value)| RecordWrite::Clear {
            org: org.clone(),
            expected: value.clone(),
        })
        .collect()
}

/// The agent-facing message. Names the organization, says the request was not
/// retried, and gives the user's next step for this reason.
pub fn message(refusal: &OrgRefusal, connect_url: &str) -> String {
    let org = &refusal.org;
    match refusal.reason {
        Reason::ApprovalRequired => format!(
            "The GitHub organization {org} has not approved OneCLI yet, so GitHub refused \
             this request. This is not something a retry or a new authorization link can \
             fix: the user must request access and an owner of {org} must grant it. Do not \
             retry and do not share GitHub authorization links. Give the user this link, \
             which explains both steps and gives them a message to send their admin: \
             {connect_url}. Retry once the user confirms access was granted."
        ),
        Reason::SsoRequired => format!(
            "The GitHub organization {org} requires SAML single sign-on, and the user's \
             GitHub connection was authorized without an active {org} SSO session, so \
             GitHub refused this request. Following GitHub's SSO link does not fix the \
             saved connection. Do not retry and do not share GitHub authorization links. \
             Give the user this link, which walks them through signing in to {org} SSO \
             and reconnecting GitHub: {connect_url}. Retry once the user confirms they \
             reconnected."
        ),
    }
}

#[cfg(test)]
mod pg_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::{HeaderValue, CONTENT_ENCODING};
    use serde_json::json;
    use std::io::Write;

    fn sso_headers(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            "x-github-sso",
            HeaderValue::from_str(value).expect("header"),
        );
        h
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).expect("gzip");
        encoder.finish().expect("gzip")
    }

    fn gzip_headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        h
    }

    const RESTRICTED_BODY: &str = r#"{"message":"Although you appear to have the correct authorization credentials, the `Acme-Labs` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. For more information on these restrictions, including how to enable this app, visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/","documentation_url":"https://docs.github.com/rest"}"#;

    #[test]
    fn applies_only_to_the_github_oauth_connection_on_the_api_host() {
        assert!(applies("api.github.com", Some("github"), 1));
        assert!(applies("API.GitHub.com", Some("github"), 1));
        assert!(
            !applies("api.github.com", Some("github"), 0),
            "nothing injected"
        );
        assert!(
            !applies("api.github.com", Some("github-app"), 1),
            "app tokens are exempt"
        );
        assert!(!applies("api.github.com", None, 1), "secret-served");
        assert!(!applies("github.com", Some("github"), 1), "web host");
        assert!(!applies("uploads.github.com", Some("github"), 1));
    }

    #[test]
    fn sso_header_names_the_org_lowercased() {
        let h =
            sso_headers("required; url=https://github.com/orgs/Acme/sso?authorization_request=AAZ");
        assert_eq!(
            classify(StatusCode::FORBIDDEN, &h, b"{}"),
            Some(OrgRefusal {
                org: "acme".into(),
                reason: Reason::SsoRequired
            })
        );
    }

    #[test]
    fn sso_header_wins_over_the_body() {
        let h = sso_headers("required; url=https://github.com/orgs/acme/sso?x=1");
        let got = classify(StatusCode::FORBIDDEN, &h, RESTRICTED_BODY.as_bytes()).expect("refusal");
        assert_eq!(got.reason, Reason::SsoRequired);
        assert_eq!(got.org, "acme");
    }

    #[test]
    fn partial_results_is_not_a_refusal() {
        let h = sso_headers("partial-results; organizations=21955855,20582480");
        assert_eq!(classify(StatusCode::FORBIDDEN, &h, b"{}"), None);
    }

    #[test]
    fn restriction_body_names_the_org_lowercased() {
        let got = classify(
            StatusCode::FORBIDDEN,
            &HeaderMap::new(),
            RESTRICTED_BODY.as_bytes(),
        )
        .expect("refusal");
        assert_eq!(
            got,
            OrgRefusal {
                org: "acme-labs".into(),
                reason: Reason::ApprovalRequired
            }
        );
    }

    #[test]
    fn restriction_body_with_single_quotes() {
        let body = r#"{"message":"Although you appear to have the correct authorization credentials, the 'acme' organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited."}"#;
        let got =
            classify(StatusCode::FORBIDDEN, &HeaderMap::new(), body.as_bytes()).expect("refusal");
        assert_eq!(got.org, "acme");
    }

    /// GitHub gzips its 403 whenever the client accepts gzip, which every
    /// common HTTP client does by default.
    #[test]
    fn gzipped_restriction_body_is_read() {
        let got = classify(
            StatusCode::FORBIDDEN,
            &gzip_headers(),
            &gzip(RESTRICTED_BODY.as_bytes()),
        )
        .expect("refusal");
        assert_eq!(got.org, "acme-labs");
        assert_eq!(got.reason, Reason::ApprovalRequired);
    }

    #[test]
    fn undecodable_bodies_are_not_refusals() {
        let mut br = HeaderMap::new();
        br.insert(CONTENT_ENCODING, HeaderValue::from_static("br"));
        assert_eq!(
            classify(StatusCode::FORBIDDEN, &br, RESTRICTED_BODY.as_bytes()),
            None,
            "an encoding GitHub does not serve"
        );
        assert_eq!(
            classify(StatusCode::FORBIDDEN, &gzip_headers(), b"not gzip"),
            None,
            "a corrupt gzip body"
        );
    }

    #[test]
    fn other_403s_and_statuses_are_left_alone() {
        let empty = HeaderMap::new();
        // Rate limit / permission 403s.
        assert_eq!(
            classify(
                StatusCode::FORBIDDEN,
                &empty,
                br#"{"message":"API rate limit exceeded for user ID 1."}"#
            ),
            None
        );
        assert_eq!(
            classify(
                StatusCode::FORBIDDEN,
                &empty,
                br#"{"message":"Resource not accessible by integration"}"#
            ),
            None
        );
        // Same signals on a non-403 are ignored.
        let h = sso_headers("required; url=https://github.com/orgs/acme/sso");
        assert_eq!(classify(StatusCode::OK, &h, b""), None);
        assert_eq!(classify(StatusCode::NOT_FOUND, &h, b""), None);
        // Not JSON, not UTF-8.
        assert_eq!(classify(StatusCode::FORBIDDEN, &empty, &[0xff, 0xfe]), None);
    }

    #[test]
    fn hostile_org_names_are_rejected() {
        for bad in [
            "required; url=https://github.com/orgs/a%2Fb/sso",
            "required; url=https://github.com/orgs/-acme/sso",
            "required; url=https://github.com/orgs//sso",
            "required; url=https://github.com/orgs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sso",
            "required; url=https://github.com/sso",
            "required",
        ] {
            assert_eq!(
                classify(StatusCode::FORBIDDEN, &sso_headers(bad), b""),
                None,
                "{bad}"
            );
        }
        let body = r#"{"message":"the `ev il<script>` organization has enabled OAuth App access restrictions"}"#;
        assert_eq!(
            classify(StatusCode::FORBIDDEN, &HeaderMap::new(), body.as_bytes()),
            None
        );
    }

    #[test]
    fn endpoint_normalizes_the_first_four_segments() {
        assert_eq!(
            endpoint("/repos/Acme/API/pulls/1?state=open"),
            Some("repos/acme/api/pulls".into())
        );
        assert_eq!(endpoint("/repos/acme/api"), Some("repos/acme/api".into()));
        assert_eq!(endpoint("/orgs/acme/"), Some("orgs/acme".into()));
        assert_eq!(endpoint("/user/repos"), Some("user/repos".into()));
        assert_eq!(endpoint("/graphql"), None, "names no resource");
        assert_eq!(endpoint("/"), None);
        assert_eq!(endpoint("/repos/a%2Fb/x"), None, "not a plain segment");
        assert_eq!(
            endpoint(&format!("/repos/{}", "a".repeat(MAX_SEGMENT_LEN + 1))),
            None
        );
    }

    /// The entry `acme` refusing `method path` for `reason` would record.
    fn refused(reason: Reason, method: Method, path: &str) -> OrgAccessEntry {
        let refusal = OrgRefusal {
            org: "acme".into(),
            reason,
        };
        OrgAccessEntry::new(&refusal, &method, path)
    }

    #[test]
    fn only_the_refused_endpoint_answering_clears_a_refusal() {
        let refused_read = refused(
            Reason::ApprovalRequired,
            Method::GET,
            "/repos/acme/api/pulls/1",
        );
        // The organization's public side answers either way: no proof.
        assert!(!refused_read.cleared_by(&Method::GET, "/orgs/acme"));
        assert!(!refused_read.cleared_by(&Method::GET, "/orgs/acme/repos"));
        assert!(!refused_read.cleared_by(&Method::GET, "/repos/acme/api/contents/README.md"));
        assert!(!refused_read.cleared_by(&Method::POST, "/repos/acme/api/forks"));
        // The refused endpoint now answers: proof.
        assert!(refused_read.cleared_by(&Method::GET, "/repos/acme/api/pulls/2"));
        assert!(refused_read.cleared_by(&Method::GET, "/repos/ACME/Api/pulls"));
        assert!(refused_read.cleared_by(&Method::POST, "/repos/acme/api/pulls"));

        // A refused write is only cleared by a write: the endpoint itself can
        // be publicly readable.
        let refused_write = refused(Reason::SsoRequired, Method::POST, "/repos/acme/api/issues");
        assert!(!refused_write.cleared_by(&Method::GET, "/repos/acme/api/issues"));
        assert!(refused_write.cleared_by(&Method::PATCH, "/repos/acme/api/issues/3"));

        // A path that does not address the refused org keeps no endpoint, so
        // only a reconnect clears it.
        for path in [
            "/graphql",
            "/search/issues?q=org:acme",
            "/repos/other/api",
            "/repos/a%2Fb",
        ] {
            let opaque = refused(Reason::ApprovalRequired, Method::GET, path);
            assert_eq!(opaque.endpoint, None, "{path}");
            assert!(!opaque.cleared_by(&Method::GET, path), "{path}");
        }
    }

    #[test]
    fn entries_round_trip_and_malformed_ones_are_skipped() {
        let entry = refused(
            Reason::ApprovalRequired,
            Method::POST,
            "/repos/acme/api/pulls",
        );
        assert_eq!(
            entry.to_json(),
            json!({ "reason": "approval_required", "write": true, "endpoint": "repos/acme/api/pulls" })
        );
        assert_eq!(OrgAccessEntry::from_json(&entry.to_json()), Some(entry));
        assert_eq!(
            OrgAccessEntry::from_json(&json!({ "reason": "sso_required" })),
            Some(OrgAccessEntry {
                reason: Reason::SsoRequired,
                endpoint: None,
                write: false
            })
        );
        assert_eq!(
            OrgAccessEntry::from_json(&json!({ "reason": "other" })),
            None
        );
        assert_eq!(OrgAccessEntry::from_json(&json!("x")), None);
    }

    fn row(id: &str, provider: &str, metadata: serde_json::Value) -> db::AppConnectionRow {
        db::AppConnectionRow {
            id: id.into(),
            provider: provider.into(),
            scope: "workspace".into(),
            credentials: None,
            label: None,
            metadata: Some(metadata),
            session_policy: None,
        }
    }

    #[test]
    fn record_for_keeps_only_the_github_oauth_record() {
        let md = json!({
            "username": "octo",
            "githubOrgAccess": { "acme": { "reason": "approval_required" } }
        });
        let rows = [
            row("gh", "github", md.clone()),
            row("app", "github-app", md),
        ];
        assert_eq!(
            record_for(&rows, Some("gh")),
            Some(json!({ "acme": { "reason": "approval_required" } }))
        );
        assert_eq!(record_for(&rows, Some("app")), None, "not the OAuth app");
        assert_eq!(record_for(&rows, Some("gone")), None);
        assert_eq!(record_for(&rows, None), None);
        assert_eq!(
            record_for(&[row("gh", "github", json!({}))], Some("gh")),
            None
        );
    }

    #[test]
    fn record_writes_store_new_refusals_and_skip_known_ones() {
        let refusal = OrgRefusal {
            org: "acme".into(),
            reason: Reason::ApprovalRequired,
        };
        let path = "/repos/acme/api/pulls/1";
        let entry = refused(Reason::ApprovalRequired, Method::GET, path).to_json();
        let write = |record: Option<&serde_json::Value>| {
            record_writes(
                record,
                Some(&refusal),
                StatusCode::FORBIDDEN,
                &Method::GET,
                path,
            )
        };
        assert_eq!(
            write(None),
            vec![RecordWrite::Record {
                org: "acme".into(),
                entry: entry.clone()
            }]
        );
        assert_eq!(write(Some(&json!({ "acme": entry }))), vec![]);
        // Same org, another endpoint: the latest refused request is kept.
        assert_eq!(
            write(Some(&json!({ "acme": { "reason": "approval_required" } }))).len(),
            1
        );
    }

    #[test]
    fn record_writes_clear_only_proven_entries() {
        let api = refused(
            Reason::ApprovalRequired,
            Method::GET,
            "/repos/acme/api/pulls",
        )
        .to_json();
        let beta =
            json!({ "reason": "sso_required", "write": false, "endpoint": "orgs/beta/members" });
        let record = json!({ "acme": api, "beta": beta });
        let clears = |status, method: Method, path| {
            record_writes(Some(&record), None, status, &method, path)
        };
        assert_eq!(
            clears(StatusCode::OK, Method::GET, "/repos/acme/api/pulls/9"),
            vec![RecordWrite::Clear {
                org: "acme".into(),
                expected: api.clone()
            }]
        );
        assert_eq!(
            clears(StatusCode::OK, Method::GET, "/orgs/acme/repos"),
            vec![]
        );
        assert_eq!(
            clears(
                StatusCode::NOT_FOUND,
                Method::GET,
                "/repos/acme/api/pulls/9"
            ),
            vec![],
            "not a success"
        );
        assert_eq!(
            record_writes(
                None,
                None,
                StatusCode::OK,
                &Method::GET,
                "/repos/acme/api/pulls"
            ),
            vec![],
            "nothing recorded: the hot path does nothing"
        );
    }

    #[test]
    fn message_names_org_link_and_forbids_retry() {
        for reason in [Reason::ApprovalRequired, Reason::SsoRequired] {
            let m = message(
                &OrgRefusal {
                    org: "acme".into(),
                    reason,
                },
                "https://app.example.com/connections/apps/github?org_access=acme",
            );
            assert!(m.contains("acme"));
            assert!(m.contains("org_access=acme"));
            assert!(m.contains("Do not retry"));
        }
    }
}
