//! Dropbox — request-level granular access (per-agent folder allowlist).
//!
//! Dropbox tokens can't be scoped to folders (unlike GitHub App tokens), so the
//! allowlist is enforced here by inspecting each request. The target path lives
//! in the JSON body (`api.dropboxapi.com`) or the `Dropbox-API-Arg` header
//! (`content.dropboxapi.com`). Strict default-deny: any request whose target
//! can't be determined and verified in-scope is blocked.

use serde_json::Value;

use super::{Denial, RequestGuard, ResourceAxis};

const RULE_NAME: &str = "Dropbox folder policy";

pub(super) struct Dropbox;

/// Folders nest, so one is inside another when it sits at or beneath it — the
/// same segment-boundary rule the request guard enforces per request, reused so
/// scope composition and enforcement can never disagree.
impl ResourceAxis for Dropbox {
    fn key(&self) -> &'static str {
        "folders"
    }

    fn normalize(&self, entry: &str) -> String {
        normalize_path(entry)
    }

    fn covered_by(&self, entry: &str, boundary: &[String]) -> bool {
        let normalized: Vec<String> = boundary.iter().map(|b| normalize_path(b)).collect();
        // The account root contains everything; `path_allowed` rejects it as a
        // request TARGET (an unverifiable reference), but as a boundary it is
        // the widest possible scope.
        if normalized.iter().any(|b| b.is_empty()) {
            return true;
        }
        path_allowed(entry, &normalized)
    }
}

impl RequestGuard for Dropbox {
    fn needs_body(&self, policy: &Value, host: &str, _method: &str, _path: &str) -> bool {
        // Only the RPC host carries the target path in the JSON body; content-host
        // calls carry it in the `Dropbox-API-Arg` header (no buffering needed).
        host == "api.dropboxapi.com" && folders(policy).is_some()
    }

    fn check(
        &self,
        policy: &Value,
        host: &str,
        path: &str,
        headers: &hyper::HeaderMap,
        body: Option<&[u8]>,
    ) -> Option<Denial> {
        let allowed = folders(policy)?;
        let reason = enforce(&allowed, host, path, headers, body)?;
        Some(Denial {
            reason,
            allowed,
            rule_name: RULE_NAME,
        })
    }
}

/// Lowercases and strips a trailing slash. Dropbox paths are case-insensitive
/// and `/`-separated; the account root is the empty string.
fn normalize_path(p: &str) -> String {
    p.to_ascii_lowercase().trim_end_matches('/').to_string()
}

/// Extracts a non-empty, normalized folder allowlist from a session policy.
fn folders(policy: &Value) -> Option<Vec<String>> {
    let arr = policy.get("folders")?.as_array()?;
    let folders: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str())
        .map(normalize_path)
        .filter(|s| !s.is_empty())
        .collect();
    if folders.is_empty() {
        None
    } else {
        Some(folders)
    }
}

/// True when `target` equals one of `allowed` or sits beneath one of them
/// (on a path-segment boundary, so `/foo` does not match `/foobar`).
fn path_allowed(target: &str, allowed: &[String]) -> bool {
    // Only absolute "/..." paths are verifiable; reject id:/rev:/ns: refs.
    if !target.starts_with('/') {
        return false;
    }
    let norm = normalize_path(target);
    if norm.is_empty() {
        return false; // account root
    }
    allowed
        .iter()
        .any(|f| norm == *f || norm.starts_with(&format!("{f}/")))
}

/// Navigates nested object keys and returns the string leaf, if present.
fn json_str_at(json: &Value, keys: &[&str]) -> Option<String> {
    let mut cur = json;
    for k in keys {
        cur = cur.get(k)?;
    }
    cur.as_str().map(str::to_string)
}

/// Reads the `Dropbox-API-Arg` header (JSON) and extracts a nested string.
fn header_arg_str(headers: &hyper::HeaderMap, keys: &[&str]) -> Option<String> {
    let raw = headers.get("dropbox-api-arg")?.to_str().ok()?;
    let json: Value = serde_json::from_str(raw).ok()?;
    json_str_at(&json, keys)
}

/// Returns `Some(reason)` if the request must be blocked under the folder
/// allowlist, or `None` to allow.
fn enforce(
    allowed: &[String],
    host: &str,
    path: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Option<String> {
    let endpoint = path.split('?').next().unwrap_or(path);

    // Endpoints with no resource path, or that only CONTINUE an already
    // authorized operation (the cursor/session was issued by a prior allowed
    // call, so it can't widen scope).
    //
    // INVARIANT: every endpoint that MINTS a cursor — `list_folder` AND
    // `list_folder/get_latest_cursor` — must be path-checked below, never
    // listed here. That is what keeps the pathless `list_folder/continue`
    // safe: an agent can only continue a cursor for a folder it was already
    // allowed to open.
    const NO_PATH_ALLOW: &[&str] = &[
        "/2/users/get_current_account",
        "/2/users/get_space_usage",
        "/2/users/get_account",
        "/2/users/get_account_batch",
        "/2/check/user",
        "/2/files/list_folder/continue",
        "/2/files/upload_session/start",
        "/2/files/upload_session/append",
        "/2/files/upload_session/append_v2",
    ];
    if NO_PATH_ALLOW.contains(&endpoint) {
        return None;
    }

    // The path(s) this request targets. A `None` entry means a required path
    // could not be determined → strict deny.
    let targets: Vec<Option<String>> = if host == "content.dropboxapi.com" {
        match endpoint {
            "/2/files/upload_session/finish" => vec![header_arg_str(headers, &["commit", "path"])],
            "/2/files/upload"
            | "/2/files/download"
            | "/2/files/download_zip"
            | "/2/files/get_preview"
            | "/2/files/get_thumbnail"
            | "/2/files/get_thumbnail_v2" => vec![header_arg_str(headers, &["path"])],
            _ => return Some(format!("endpoint not permitted: {endpoint}")),
        }
    } else {
        // api.dropboxapi.com — the path lives in the JSON body.
        let Some(json) = body.and_then(|b| serde_json::from_slice::<Value>(b).ok()) else {
            return Some(format!("cannot read request body for {endpoint}"));
        };
        match endpoint {
            "/2/files/move_v2" | "/2/files/copy_v2" | "/2/files/move" | "/2/files/copy" => vec![
                json_str_at(&json, &["from_path"]),
                json_str_at(&json, &["to_path"]),
            ],
            "/2/files/search_v2" => vec![json_str_at(&json, &["options", "path"])],
            "/2/files/search" => vec![json_str_at(&json, &["path"])],
            "/2/files/get_metadata"
            | "/2/files/list_folder"
            // get_latest_cursor takes a `path` and mints a cursor; treat it
            // exactly like list_folder so an out-of-scope folder can't be opened.
            | "/2/files/list_folder/get_latest_cursor"
            | "/2/files/create_folder"
            | "/2/files/create_folder_v2"
            | "/2/files/delete"
            | "/2/files/delete_v2"
            | "/2/files/permanently_delete"
            | "/2/files/get_temporary_link"
            | "/2/files/list_revisions"
            | "/2/files/restore"
            | "/2/sharing/list_shared_links"
            | "/2/sharing/create_shared_link_with_settings" => vec![json_str_at(&json, &["path"])],
            _ => return Some(format!("endpoint not permitted: {endpoint}")),
        }
    };

    for target in targets {
        match target {
            Some(p) if path_allowed(&p, allowed) => {}
            Some(p) => return Some(format!("path outside allowed folders: {p}")),
            None => return Some(format!("missing or invalid path for {endpoint}")),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{enforce, folders, path_allowed, Dropbox};
    use crate::granular_access::ResourceAxis;

    fn allowed() -> Vec<String> {
        vec!["/clients/acme".to_string(), "/marketing".to_string()]
    }

    #[test]
    fn coverage_follows_the_segment_boundary_and_is_one_directional() {
        let boundary = vec!["/clients".to_string()];
        assert!(Dropbox.covered_by("/clients", &boundary));
        assert!(Dropbox.covered_by("/clients/acme", &boundary));
        assert!(Dropbox.covered_by("/Clients/ACME", &boundary));
        // A sibling that merely shares a prefix is outside.
        assert!(!Dropbox.covered_by("/clientsfoo", &boundary));
        // An ancestor is not inside its own descendant.
        assert!(!Dropbox.covered_by("/", &boundary));
        // The account root as a BOUNDARY contains everything.
        assert!(Dropbox.covered_by("/anything", &["/".to_string()]));
    }

    #[test]
    fn intersect_keeps_the_deeper_folder_of_a_nested_pair() {
        let outer = vec!["/clients".to_string()];
        let inner = vec!["/clients/acme".to_string()];
        // Whichever side the narrower entry came from, it is the overlap —
        // dropping it (by only keeping "b entries inside a") would deny all
        // access to a folder both scopes plainly allow.
        assert_eq!(
            Dropbox.intersect(&outer, &inner),
            vec!["/clients/acme".to_string()]
        );
        assert_eq!(
            Dropbox.intersect(&inner, &outer),
            vec!["/clients/acme".to_string()]
        );
        // A root boundary leaves the other side untouched.
        assert_eq!(
            Dropbox.intersect(&["/".to_string()], &outer),
            vec!["/clients".to_string()]
        );
        // Siblings share nothing — the deny-all sentinel.
        assert!(Dropbox
            .intersect(&outer, &["/marketing".to_string()])
            .is_empty());
    }

    fn empty_headers() -> hyper::HeaderMap {
        hyper::HeaderMap::new()
    }

    fn arg_header(json: &str) -> hyper::HeaderMap {
        let mut h = hyper::HeaderMap::new();
        h.insert("dropbox-api-arg", json.parse().unwrap());
        h
    }

    /// Returns true when the request is BLOCKED.
    fn blocked(
        host: &str,
        endpoint: &str,
        headers: &hyper::HeaderMap,
        body: Option<&[u8]>,
    ) -> bool {
        enforce(&allowed(), host, endpoint, headers, body).is_some()
    }

    #[test]
    fn allows_in_scope_body_path() {
        let body = br#"{"path":"/Clients/Acme/report"}"#;
        assert!(!blocked(
            "api.dropboxapi.com",
            "/2/files/get_metadata",
            &empty_headers(),
            Some(body)
        ));
    }

    #[test]
    fn denies_out_of_scope_body_path() {
        let body = br#"{"path":"/Finance/secret"}"#;
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/get_metadata",
            &empty_headers(),
            Some(body)
        ));
    }

    #[test]
    fn prefix_must_be_segment_boundary() {
        // /marketing must not match /marketing-2024
        let body = br#"{"path":"/Marketing-2024/x"}"#;
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &empty_headers(),
            Some(body)
        ));
    }

    #[test]
    fn move_requires_both_sides_in_scope() {
        let ok = br#"{"from_path":"/Clients/Acme/a","to_path":"/Marketing/b"}"#;
        assert!(!blocked(
            "api.dropboxapi.com",
            "/2/files/move_v2",
            &empty_headers(),
            Some(ok)
        ));
        let bad = br#"{"from_path":"/Clients/Acme/a","to_path":"/Finance/b"}"#;
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/move_v2",
            &empty_headers(),
            Some(bad)
        ));
    }

    #[test]
    fn search_requires_scoped_options_path() {
        let no_path = br#"{"query":"q"}"#;
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/search_v2",
            &empty_headers(),
            Some(no_path)
        ));
        let scoped = br#"{"query":"q","options":{"path":"/Marketing"}}"#;
        assert!(!blocked(
            "api.dropboxapi.com",
            "/2/files/search_v2",
            &empty_headers(),
            Some(scoped)
        ));
    }

    #[test]
    fn root_and_id_refs_denied() {
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &empty_headers(),
            Some(br#"{"path":""}"#)
        ));
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/get_metadata",
            &empty_headers(),
            Some(br#"{"path":"id:abc123"}"#)
        ));
    }

    #[test]
    fn upload_header_path_enforced() {
        let ok = arg_header(r#"{"path":"/Clients/Acme/a.txt","mode":"add"}"#);
        assert!(!blocked(
            "content.dropboxapi.com",
            "/2/files/upload",
            &ok,
            None
        ));
        let bad = arg_header(r#"{"path":"/Finance/a.txt"}"#);
        assert!(blocked(
            "content.dropboxapi.com",
            "/2/files/upload",
            &bad,
            None
        ));
    }

    #[test]
    fn unknown_endpoint_and_missing_body_denied() {
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/list_folder/longpoll",
            &empty_headers(),
            Some(br#"{}"#)
        ));
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/get_metadata",
            &empty_headers(),
            None
        ));
    }

    #[test]
    fn account_info_and_continuations_allowed() {
        assert!(!blocked(
            "api.dropboxapi.com",
            "/2/users/get_current_account",
            &empty_headers(),
            Some(b"null")
        ));
        assert!(!blocked(
            "api.dropboxapi.com",
            "/2/files/list_folder/continue",
            &empty_headers(),
            Some(br#"{"cursor":"x"}"#)
        ));
    }

    #[test]
    fn get_latest_cursor_path_enforced() {
        // get_latest_cursor mints a cursor for an arbitrary folder, so its path
        // must be checked — otherwise an agent scoped to /Marketing could mint a
        // cursor for /Finance and read its changes via list_folder/continue.
        assert!(blocked(
            "api.dropboxapi.com",
            "/2/files/list_folder/get_latest_cursor",
            &empty_headers(),
            Some(br#"{"path":"/Finance"}"#)
        ));
        assert!(!blocked(
            "api.dropboxapi.com",
            "/2/files/list_folder/get_latest_cursor",
            &empty_headers(),
            Some(br#"{"path":"/Marketing"}"#)
        ));
    }

    #[test]
    fn path_allowed_basics() {
        let a = allowed();
        assert!(path_allowed("/Clients/Acme", &a));
        assert!(path_allowed("/clients/acme/deep/file.txt", &a));
        assert!(!path_allowed("/clients", &a));
        assert!(!path_allowed("rev:123", &a));
    }

    #[test]
    fn folders_normalizes_and_drops_root() {
        let policy = serde_json::json!({ "folders": ["/Clients/Acme/", "/Marketing", "/"] });
        assert_eq!(
            folders(&policy).unwrap(),
            vec!["/clients/acme", "/marketing"]
        );
        assert!(folders(&serde_json::json!({ "folders": [] })).is_none());
        assert!(folders(&serde_json::json!({})).is_none());
    }
}
