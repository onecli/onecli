//! Per-agent granular access — cloud-only.
//!
//! A connection's `session_policy` can restrict what an agent reaches *within* a
//! provider — specific GitHub repos, specific Dropbox folders, etc. Each
//! provider enforces this in exactly one of two ways:
//!
//! * **Token-level** ([`TokenScoper`]) — mint a credential the provider itself
//!   restricts (e.g. a GitHub repo-scoped installation token). Enforcement is
//!   upstream and transparent to the request path.
//! * **Request-level** ([`RequestGuard`]) — inspect each request against the
//!   policy and allow/deny at the gateway (e.g. a Dropbox or Google Drive
//!   folder allowlist). Used when the provider's credential cannot be scoped.
//!   A guard may do I/O (Drive verifies a file's live parent chain upstream).
//!
//! To add a provider: implement the matching trait in a submodule and register
//! it in `request_guard` (request-level, keyed by the provider serving the
//! host + path — shared hosts like `www.googleapis.com` carry several) or `token_scoper` (token-level, keyed by credential type).
//!
//! A third seam, [`ResourceAxis`], is keyed by the policy's own shape rather
//! than by host or credential type, so scope composition works where neither is
//! in hand (`policy_engine::inject_select`). It defines what "one resource is
//! inside another" means per axis, which is what lets an ORG policy act as a
//! boundary the WORKSPACE selection narrows within.

mod dropbox;
mod github;
mod google_drive;

use serde_json::Value;
use tracing::warn;

/// A blocked request, surfaced to the agent and the activity feed.
#[derive(Debug)]
pub struct Denial {
    /// Specific cause, e.g. "path outside allowed folders: /Finance/secret".
    pub reason: String,
    /// The scope the agent *is* allowed (e.g. the folder allowlist), included
    /// in the agent-facing error so the model can self-correct.
    pub allowed: Vec<String>,
    /// Stable label for telemetry / the red "Blocked" activity row.
    pub rule_name: &'static str,
    /// Provider-specific guidance appended to the agent-facing message — how
    /// the scope works and how to make a request that fits it. `None` keeps the
    /// generic wording.
    pub hint: Option<&'static str>,
}

/// Request-level enforcement: inspect one request against the provider's own
/// allowlist. May do I/O, but every failure to verify must resolve to a denial
/// (fail closed).
///
/// A guard is also the [`ResourceAxis`] its allowlist is written on. The
/// dispatcher reads the policy against that axis before any guard runs, so a
/// guard only ever sees its own non-empty, normalized entries — and a policy
/// written on ANOTHER axis (a Drive scope on a Dropbox connection, say) is
/// refused there, once for every provider, instead of reading as
/// "unrestricted".
#[async_trait::async_trait]
pub trait RequestGuard: ResourceAxis {
    /// Stable label for telemetry / the red "Blocked" activity row.
    fn rule_name(&self) -> &'static str;
    /// Provider-specific guidance for [`Denial::hint`].
    fn hint(&self) -> Option<&'static str> {
        None
    }
    /// Whether the request body must be buffered to evaluate this request.
    fn needs_body(&self, host: &str, method: &str, path: &str) -> bool;
    /// `Some(reason)` blocks the request; `None` allows it. `allowed` is
    /// non-empty and normalized. `path` carries the query string; `headers`
    /// are post-injection (the credential is present).
    async fn check(
        &self,
        allowed: &[String],
        host: &str,
        method: &str,
        path: &str,
        headers: &hyper::HeaderMap,
        body: Option<&[u8]>,
    ) -> Option<String>;
}

/// Token-level enforcement: mint a scoped credential at refresh time.
#[async_trait::async_trait]
pub trait TokenScoper: Sync {
    /// Mint a scoped credential for `policy`. `None` means the policy requests
    /// no scoping, so the caller falls through to the normal (unscoped) refresh.
    async fn scope(&self, creds: &Value, policy: &Value) -> Option<anyhow::Result<(String, i64)>>;
}

/// One resource dimension of a session policy (`repositories`, `folders`, …):
/// how its entries are named and when one contains another. Scope composition
/// is defined here so every provider — present and future — inherits it.
pub trait ResourceAxis: Sync {
    /// The policy object's single key.
    fn key(&self) -> &'static str;

    /// Whether `entry` is entirely inside `boundary` — equality for flat axes
    /// (repository names), containment for hierarchical ones (folder paths).
    fn covered_by(&self, entry: &str, boundary: &[String]) -> bool;

    /// Canonical form for comparison and for the stable serialization below.
    fn normalize(&self, entry: &str) -> String;

    /// The overlap of two allowlists on this axis.
    ///
    /// SYMMETRIC by construction: an entry survives when it is inside the other
    /// side, whichever side it came from — so a boundary of `/clients/acme`
    /// against a selection of `/clients` yields `/clients/acme` (the narrower
    /// of the nested pair) rather than nothing. Taking only "selection entries
    /// inside the boundary" would deny-all that case, which is a real overlap.
    fn intersect(&self, a: &[String], b: &[String]) -> Vec<String> {
        let mut out: Vec<String> = a
            .iter()
            .filter(|entry| self.covered_by(entry, b))
            .chain(b.iter().filter(|entry| self.covered_by(entry, a)))
            .map(|entry| self.normalize(entry))
            .collect();
        // Deterministic: the merged policy is part of the injection cache key,
        // so an unstable order would multiply cache misses.
        out.sort();
        out.dedup();
        out
    }
}

static DROPBOX: dropbox::Dropbox = dropbox::Dropbox;
static GITHUB: github::GithubApp = github::GithubApp;
static GOOGLE_DRIVE: google_drive::GoogleDrive = google_drive::GoogleDrive;
static AXES: &[&'static dyn ResourceAxis] = &[&GITHUB, &DROPBOX, &GOOGLE_DRIVE];

/// Request-level guard for a provider (resolved from the request host + path),
/// if it enforces granular access that way.
fn request_guard(provider: &str) -> Option<&'static dyn RequestGuard> {
    match provider {
        "dropbox" => Some(&DROPBOX),
        "google-drive" => Some(&GOOGLE_DRIVE),
        _ => None,
    }
}

/// Token-level scoper for a credential type (the refresh call site), if it
/// enforces granular access that way.
fn token_scoper(cred_type: &str) -> Option<&'static dyn TokenScoper> {
    match cred_type {
        "github_app" => Some(&GITHUB),
        _ => None,
    }
}

/// Resolve the request-level guard for the provider serving `host` + `path`.
/// Path-aware because shared hosts (`www.googleapis.com`) carry several
/// providers — a host-only lookup there names whichever registered first
/// (Gmail), and Drive's guard would never run. Returns the port-stripped host
/// (which the guards compare against) alongside the guard.
fn guard_for_request<'a>(
    host: &'a str,
    path: &str,
) -> Option<(&'a str, &'static dyn RequestGuard)> {
    let host = common::util::strip_port(host);
    let (provider, _) = apps::provider_for_host_and_path(host, path)?;
    Some((host, request_guard(provider)?))
}

/// Whether the request body must be buffered for request-level enforcement.
/// `false` when there's no policy, the provider has no request-level guard, or
/// the guard has no allowlist to check the body against.
pub fn needs_request_body(policy: Option<&Value>, host: &str, method: &str, path: &str) -> bool {
    let Some(policy) = policy else { return false };
    let Some((host, guard)) = guard_for_request(host, path) else {
        return false;
    };
    matches!(guard_scope(policy, guard), GuardScope::Allowed(_))
        && guard.needs_body(host, method, path)
}

/// Enforce request-level granular access. `None` = allowed (no policy, no
/// request-level guard for this provider, or the request is in scope).
pub async fn enforce_request(
    policy: Option<&Value>,
    host: &str,
    method: &str,
    path: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Option<Denial> {
    let policy = policy?;
    let (host, guard) = guard_for_request(host, path)?;
    let (reason, allowed, hint) = match guard_scope(policy, guard) {
        GuardScope::Unrestricted => return None,
        GuardScope::Unenforceable(reason) => (reason, Vec::new(), None),
        GuardScope::Allowed(allowed) => {
            let reason = guard
                .check(&allowed, host, method, path, headers, body)
                .await?;
            (reason, allowed, guard.hint())
        }
    };
    Some(Denial {
        reason,
        allowed,
        rule_name: guard.rule_name(),
        hint,
    })
}

/// What a request guard has to enforce under a policy.
enum GuardScope {
    /// Not a resource policy (absent axis, `{}`, a behavioral array), or one
    /// whose entries all name the provider's root: nothing to restrict.
    Unrestricted,
    /// The guard's own non-empty, normalized allowlist.
    Allowed(Vec<String>),
    /// A policy the guard can't enforce — written on ANOTHER provider's axis,
    /// or not a list. Reading it as unrestricted would silently drop the
    /// restriction, so every request is refused instead.
    Unenforceable(String),
}

fn guard_scope(policy: &Value, guard: &dyn RequestGuard) -> GuardScope {
    let Some(axis) = axis_of(policy) else {
        return GuardScope::Unrestricted;
    };
    if axis.key() != guard.key() {
        return GuardScope::Unenforceable(format!(
            "`{}` scoping does not apply to this app",
            axis.key()
        ));
    }
    let Some(entries) = raw_entries(policy, axis) else {
        return GuardScope::Unenforceable(format!("`{}` must be a list", axis.key()));
    };
    let allowed: Vec<String> = entries
        .iter()
        .map(|e| guard.normalize(e))
        .filter(|e| !e.is_empty())
        .collect();
    if allowed.is_empty() {
        GuardScope::Unrestricted
    } else {
        GuardScope::Allowed(allowed)
    }
}

/// The axis a policy is written on, by its single key. `None` = not a
/// recognized resource policy (absent, `{}`, behavioral array, unknown key).
fn axis_of(policy: &Value) -> Option<&'static dyn ResourceAxis> {
    let obj = policy.as_object()?;
    AXES.iter()
        .copied()
        .find(|axis| obj.contains_key(axis.key()))
}

/// The raw (un-normalized, unfiltered) entry list a policy carries on its axis.
/// Raw on purpose: normalization drops entries like `"/"`, and a policy that
/// listed only those still means "restrict", not "unrestricted".
fn raw_entries<'a>(policy: &'a Value, axis: &dyn ResourceAxis) -> Option<Vec<&'a str>> {
    Some(
        policy
            .get(axis.key())?
            .as_array()?
            .iter()
            .filter_map(|v| v.as_str())
            .collect(),
    )
}

/// Whether a policy restricts its credential to NOTHING — an explicitly empty
/// allowlist. It is the sentinel for an empty scope intersection, and it is
/// also how a hand-written `{"repositories": []}` is refused: without it, an
/// empty list reads as "no scoping requested" and mints an UNSCOPED credential.
pub fn denies_everything(policy: Option<&Value>) -> bool {
    let Some(policy) = policy else { return false };
    let Some(axis) = axis_of(policy) else {
        return false;
    };
    raw_entries(policy, axis).is_some_and(|entries| entries.is_empty())
}

/// Compose two session policies into the one the gateway enforces: the overlap
/// of what each allows. `None` on either side means "unrestricted at that
/// scope", so the other side stands alone.
///
/// An ORG policy is a boundary and a WORKSPACE policy a selection within it, but
/// the operation itself is symmetric — order is irrelevant, and composing three
/// scopes is just two applications.
pub fn intersect_policies(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    let (Some(a), Some(b)) = (a, b) else {
        return a.or(b).cloned();
    };
    let (Some(axis_a), Some(axis_b)) = (axis_of(a), axis_of(b)) else {
        // One side isn't a resource policy (jsonb null, a behavioral array, an
        // empty object): it restricts nothing, so the other side stands.
        return match (axis_of(a), axis_of(b)) {
            (Some(_), None) => Some(a.clone()),
            (None, Some(_)) => Some(b.clone()),
            _ => None,
        };
    };
    if axis_a.key() != axis_b.key() {
        // Different dimensions can't overlap (one provider, one axis) — a
        // misconfiguration, and the safe reading is "nothing is in both".
        warn!(
            axis_a = axis_a.key(),
            axis_b = axis_b.key(),
            "session policies on different resource axes; denying all access"
        );
        return Some(serde_json::json!({ axis_a.key(): [] }));
    }
    let entries_a: Vec<String> = raw_entries(a, axis_a)
        .unwrap_or_default()
        .iter()
        .map(|e| axis_a.normalize(e))
        .collect();
    let entries_b: Vec<String> = raw_entries(b, axis_b)
        .unwrap_or_default()
        .iter()
        .map(|e| axis_b.normalize(e))
        .collect();
    Some(serde_json::json!({ axis_a.key(): axis_a.intersect(&entries_a, &entries_b) }))
}

/// Whether a provider enforces its resource scope by inspecting each REQUEST
/// (rather than by carrying the scope in the credential). Where it does, the
/// plain stored credential is the correct one and the guard does the limiting.
pub fn has_request_guard(provider: &str) -> bool {
    request_guard(provider).is_some()
}

/// Whether a credential type is scoped at the TOKEN level — i.e. a restrictive
/// policy makes each request mint a fresh, never-persisted credential from the
/// provider. Callers use this to defer that mint until the request is allowed.
pub fn has_token_scoper(cred_type: &str) -> bool {
    token_scoper(cred_type).is_some()
}

/// Mint a scoped credential for token-level providers. `None` = no granular
/// scoping applies; the caller should fall through to the normal refresh.
pub async fn scope_token(
    cred_type: &str,
    creds: &Value,
    policy: Option<&Value>,
) -> Option<anyhow::Result<(String, i64)>> {
    let policy = policy?;
    let scoper = token_scoper(cred_type)?;
    scoper.scope(creds, policy).await
}

#[cfg(test)]
mod tests {
    use super::{denies_everything, enforce_request, intersect_policies, needs_request_body};
    use serde_json::json;

    fn folder_policy() -> serde_json::Value {
        serde_json::json!({ "folders": ["/Marketing"] })
    }

    #[test]
    fn denies_everything_is_true_only_for_an_explicitly_empty_allowlist() {
        assert!(denies_everything(Some(&json!({ "repositories": [] }))));
        assert!(denies_everything(Some(&json!({ "folders": [] }))));
        assert!(!denies_everything(Some(
            &json!({ "repositories": ["org/a"] })
        )));
        // A root folder is the WIDEST scope, not an empty one — the check must
        // read the raw entries, because normalization drops "/".
        assert!(!denies_everything(Some(&json!({ "folders": ["/"] }))));
        // Absent / null / empty-object / behavioral: not a restriction at all.
        assert!(!denies_everything(None));
        assert!(!denies_everything(Some(&json!(null))));
        assert!(!denies_everything(Some(&json!({}))));
        assert!(!denies_everything(Some(&json!([
            { "type": "body_contains", "value": "x" }
        ]))));
    }

    #[test]
    fn intersect_policies_composes_scopes() {
        // The reported case: org boundary of two repos, workspace picks one.
        assert_eq!(
            intersect_policies(
                Some(&json!({ "repositories": ["buckle/electron", "buckle/api"] })),
                Some(&json!({ "repositories": ["buckle/api"] })),
            ),
            Some(json!({ "repositories": ["buckle/api"] }))
        );
        // Either side absent → the other stands alone.
        let solo = json!({ "folders": ["/clients"] });
        assert_eq!(intersect_policies(Some(&solo), None), Some(solo.clone()));
        assert_eq!(intersect_policies(None, Some(&solo)), Some(solo.clone()));
        assert_eq!(intersect_policies(None, None), None);
        // Non-policy shapes restrict nothing.
        assert_eq!(
            intersect_policies(Some(&json!({})), Some(&solo)),
            Some(solo.clone())
        );
        assert_eq!(
            intersect_policies(Some(&json!([{ "type": "body_contains" }])), Some(&solo)),
            Some(solo)
        );
        // Disjoint → the deny-all sentinel.
        let disjoint = intersect_policies(
            Some(&json!({ "repositories": ["org/a"] })),
            Some(&json!({ "repositories": ["org/z"] })),
        );
        assert_eq!(disjoint, Some(json!({ "repositories": [] })));
        assert!(denies_everything(disjoint.as_ref()));
        // Mismatched axes cannot overlap → deny-all, on the first axis.
        let mismatch = intersect_policies(
            Some(&json!({ "repositories": ["org/a"] })),
            Some(&json!({ "folders": ["/x"] })),
        );
        assert!(denies_everything(mismatch.as_ref()));
        // Output is sorted + deduped (it feeds the injection cache key).
        assert_eq!(
            intersect_policies(
                Some(&json!({ "repositories": ["org/b", "org/a", "ORG/A"] })),
                Some(&json!({ "repositories": ["org/a", "org/b"] })),
            ),
            Some(json!({ "repositories": ["org/a", "org/b"] }))
        );
    }

    #[tokio::test]
    async fn enforce_request_dispatches_to_dropbox_guard() {
        let policy = folder_policy();
        let headers = hyper::HeaderMap::new();
        // In-scope path → allowed.
        assert!(enforce_request(
            Some(&policy),
            "api.dropboxapi.com",
            "POST",
            "/2/files/get_metadata",
            &headers,
            Some(br#"{"path":"/Marketing/x"}"#),
        )
        .await
        .is_none());
        // Out-of-scope path → blocked, with the provider's rule label.
        let denial = enforce_request(
            Some(&policy),
            "api.dropboxapi.com",
            "POST",
            "/2/files/get_metadata",
            &headers,
            Some(br#"{"path":"/Finance/x"}"#),
        )
        .await
        .expect("out-of-scope path must be denied");
        assert_eq!(denial.rule_name, "Dropbox folder policy");
        assert_eq!(denial.allowed, vec!["/marketing".to_string()]);
    }

    #[tokio::test]
    async fn enforce_request_ignores_providers_without_a_request_guard() {
        // GitHub enforces at the token level, so there is no request-level guard
        // and the gateway never blocks its requests here.
        let policy = serde_json::json!({ "repositories": ["org/a"] });
        assert!(enforce_request(
            Some(&policy),
            "api.github.com",
            "POST",
            "/repos/org/a/contents/x",
            &hyper::HeaderMap::new(),
            None,
        )
        .await
        .is_none());
    }

    #[tokio::test]
    async fn drive_guard_is_resolved_by_path_on_the_shared_google_host() {
        let policy = json!({ "driveFolders": ["folderA"] });
        let no_auth = hyper::HeaderMap::new();
        // Drive paths reach the Drive guard: with no injected credential the
        // ancestry can't be verified, so it fails closed (no network needed).
        let denial = enforce_request(
            Some(&policy),
            "www.googleapis.com:443",
            "GET",
            "/drive/v3/files/abc",
            &no_auth,
            None,
        )
        .await
        .expect("drive request without a credential must be denied");
        assert_eq!(denial.rule_name, "Google Drive folder policy");
        // Unsupported Drive surfaces are refused before any lookup.
        assert!(enforce_request(
            Some(&policy),
            "www.googleapis.com",
            "POST",
            "/batch/drive/v3",
            &no_auth,
            Some(b""),
        )
        .await
        .is_some());
        // Another provider on the same host is not Drive's to judge (and a
        // host-only lookup would have resolved Gmail for every path).
        assert!(enforce_request(
            Some(&policy),
            "www.googleapis.com",
            "GET",
            "/gmail/v1/users/me/messages",
            &no_auth,
            None,
        )
        .await
        .is_none());
        assert!(needs_request_body(
            Some(&policy),
            "www.googleapis.com",
            "POST",
            "/upload/drive/v3/files?uploadType=multipart"
        ));
        assert!(!needs_request_body(
            Some(&policy),
            "www.googleapis.com",
            "POST",
            "/gmail/v1/users/me/messages/send"
        ));
    }

    /// A policy written on ANOTHER provider's axis can't be enforced by a
    /// request guard, so it must not read as "unrestricted" — for every guarded
    /// provider alike. (Dropbox once let a `driveFolders` policy through.)
    #[tokio::test]
    async fn every_request_guard_refuses_a_policy_on_another_axis() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("authorization", "Bearer t".parse().unwrap());
        let cases = [
            // (foreign policy, host, path, body)
            (
                json!({ "folders": ["/x"] }),
                "www.googleapis.com",
                "/drive/v3/about",
                None,
            ),
            (
                json!({ "repositories": ["o/r"] }),
                "www.googleapis.com",
                "/drive/v3/about",
                None,
            ),
            (
                json!({ "driveFolders": ["A"] }),
                "api.dropboxapi.com",
                "/2/files/get_metadata",
                Some(br#"{"path":"/x"}"#.as_slice()),
            ),
            (
                json!({ "repositories": ["o/r"] }),
                "api.dropboxapi.com",
                "/2/files/get_metadata",
                Some(br#"{"path":"/x"}"#.as_slice()),
            ),
        ];
        for (policy, host, path, body) in cases {
            let denial = enforce_request(Some(&policy), host, "POST", path, &headers, body)
                .await
                .unwrap_or_else(|| panic!("{policy} on {host} must deny"));
            let key = policy.as_object().unwrap().keys().next().unwrap();
            assert!(denial.reason.contains(key.as_str()), "{}", denial.reason);
            assert!(denial.allowed.is_empty());
            // Nothing to check a body against → no buffering for it either.
            assert!(!needs_request_body(Some(&policy), host, "POST", path));
        }
        // A non-list value on the guard's own axis is not a scope either.
        assert!(enforce_request(
            Some(&json!({ "folders": "/x" })),
            "api.dropboxapi.com",
            "POST",
            "/2/files/get_metadata",
            &headers,
            Some(br#"{"path":"/x"}"#),
        )
        .await
        .is_some());
        // A non-resource object (no axis) and a root-only allowlist restrict
        // nothing.
        for policy in [json!({}), json!({ "folders": ["/"] })] {
            assert!(enforce_request(
                Some(&policy),
                "api.dropboxapi.com",
                "POST",
                "/2/files/get_metadata",
                &headers,
                Some(br#"{"path":"/x"}"#),
            )
            .await
            .is_none());
        }
    }

    #[test]
    fn drive_policies_compose_on_their_own_axis() {
        assert_eq!(
            intersect_policies(
                Some(&json!({ "driveFolders": ["A"] })),
                Some(&json!({ "driveFolders": ["A/B", "C"] })),
            ),
            Some(json!({ "driveFolders": ["A/B"] }))
        );
        assert!(denies_everything(Some(&json!({ "driveFolders": [] }))));
        // Drive and Dropbox axes never overlap.
        assert!(denies_everything(
            intersect_policies(
                Some(&json!({ "driveFolders": ["A"] })),
                Some(&json!({ "folders": ["/A"] })),
            )
            .as_ref()
        ));
    }

    #[tokio::test]
    async fn enforce_request_allows_when_no_policy() {
        assert!(enforce_request(
            None,
            "api.dropboxapi.com",
            "POST",
            "/2/files/get_metadata",
            &hyper::HeaderMap::new(),
            Some(br#"{"path":"/Finance/x"}"#),
        )
        .await
        .is_none());
    }

    #[test]
    fn needs_request_body_only_for_dropbox_rpc_host_with_policy() {
        let policy = folder_policy();
        // RPC host carries the path in the body → buffer it.
        assert!(needs_request_body(
            Some(&policy),
            "api.dropboxapi.com",
            "POST",
            "/2/files/get_metadata"
        ));
        // Content host carries the path in a header → no buffering.
        assert!(!needs_request_body(
            Some(&policy),
            "content.dropboxapi.com",
            "POST",
            "/2/files/upload"
        ));
        // No policy, or a provider without a request guard → no buffering.
        assert!(!needs_request_body(
            None,
            "api.dropboxapi.com",
            "POST",
            "/2/files/get_metadata"
        ));
        assert!(!needs_request_body(
            Some(&policy),
            "api.github.com",
            "GET",
            "/repos/org/a"
        ));
    }
}
