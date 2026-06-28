//! Request injection and agent authentication.
//!
//! This module handles:
//! - Extracting agent tokens from `Proxy-Authorization` headers
//! - Applying injection rules (set_header, remove_header, set_param, set_path,
//!   replace_path_regex) to forwarded requests
//! - Path pattern matching for injection rules

use std::borrow::Cow;
use std::sync::{Arc, OnceLock};

use base64::Engine;
use dashmap::DashMap;
use hyper::header::{HeaderName, HeaderValue};
use hyper::Request;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::vault::VaultCredential;

// ── Data types ──────────────────────────────────────────────────────────

/// A single injection instruction returned by the API.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)]
pub(crate) enum Injection {
    SetHeader {
        name: String,
        value: String,
    },
    /// Replace a header only if it already exists in the request.
    /// Used for OAuth: replace Authorization when the SDK sends the exchange
    /// request, but leave x-api-key untouched on subsequent requests.
    ReplaceHeader {
        name: String,
        value: String,
    },
    RemoveHeader {
        name: String,
    },
    /// Add or replace a URL query parameter.
    SetParam {
        name: String,
        value: String,
    },
    /// Substitute the secret into a `{value}` hole in the URL path (template mode).
    /// The agent emits the natural URL shape with any/empty filler in the secret's
    /// slot; the gateway replaces that slot with `value`. Used for token-in-path
    /// APIs like Telegram (`/bot<token>/sendMessage`).
    SetPath {
        /// Path template containing exactly one `{value}` hole, e.g. `/bot{value}`.
        template: String,
        /// The resolved secret value substituted into the hole.
        value: String,
    },
    /// Rewrite the URL path via a regex (advanced mode). `replacement` may use
    /// `$N` capture references and a literal `{value}` token for the secret.
    ReplacePathRegex {
        /// The regex matched against the request path (query stripped).
        pattern: String,
        /// Replacement template; `$N` are expanded from captures, then `{value}`
        /// is replaced with the secret (so a `$` in the secret is never reinterpreted).
        replacement: String,
        /// The resolved secret value.
        value: String,
    },
}

/// A rule matching a path pattern with injection instructions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct InjectionRule {
    pub path_pattern: String,
    pub injections: Vec<Injection>,
}

// ── Agent token extraction ──────────────────────────────────────────────

/// Extract the agent access token from the `Proxy-Authorization: Basic base64({token}:)` header.
/// Returns `None` if the header is missing or malformed.
pub(crate) fn extract_agent_token<T>(req: &Request<T>) -> Option<String> {
    let value = req.headers().get("proxy-authorization")?.to_str().ok()?;
    let encoded = value.strip_prefix("Basic ")?.trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded_str = String::from_utf8(decoded).ok()?;
    // Format is "{username}:{token}" — extract the token from the password field.
    // Follows the convention of GitHub/GitLab/Bitbucket: dummy username, token as password.
    // Also handles legacy "{token}:" format (token as username, empty password).
    let token = match decoded_str.split_once(':') {
        Some((_, pass)) if !pass.is_empty() => pass,
        Some((user, _)) => user, // empty password → token is the username
        None => &decoded_str,
    };
    Some(token.to_string())
}

// ── Injection application ───────────────────────────────────────────────

/// Apply injection rules to the request headers and URL path.
/// `request_path` may be mutated when `SetParam` injections add query parameters.
/// Returns the number of injection actions applied.
pub(crate) fn apply_injections(
    headers: &mut hyper::HeaderMap,
    request_path: &mut String,
    rules: &[InjectionRule],
) -> usize {
    let mut count = 0;

    for rule in rules {
        if !path_matches(request_path, &rule.path_pattern) {
            continue;
        }

        for injection in &rule.injections {
            match injection {
                Injection::SetHeader { name, value } => {
                    if let (Ok(header_name), Ok(header_value)) = (
                        HeaderName::from_bytes(name.as_bytes()),
                        HeaderValue::from_str(value),
                    ) {
                        headers.insert(header_name, header_value);
                        count += 1;
                    } else {
                        warn!(
                            header = %name,
                            "injection skipped: invalid header name or value"
                        );
                    }
                }
                Injection::ReplaceHeader { name, value } => {
                    if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
                        if headers.contains_key(&header_name) {
                            if let Ok(header_value) = HeaderValue::from_str(value) {
                                headers.insert(header_name, header_value);
                                count += 1;
                            }
                        }
                    }
                }
                Injection::RemoveHeader { name } => {
                    if let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) {
                        if headers.remove(&header_name).is_some() {
                            count += 1;
                        }
                    }
                }
                Injection::SetParam { name, value } => {
                    apply_set_param(request_path, name, value);
                    count += 1;
                }
                Injection::SetPath { template, value } => {
                    if apply_set_path(request_path, template, value) {
                        count += 1;
                    }
                }
                Injection::ReplacePathRegex {
                    pattern,
                    replacement,
                    value,
                } => {
                    if apply_replace_path_regex(request_path, pattern, replacement, value) {
                        count += 1;
                    }
                }
            }
        }
    }

    count
}

/// Add or replace a URL query parameter in a path+query string.
///
/// Only the injected parameter is encoded via `form_urlencoded`; existing
/// query segments are preserved byte-for-byte so their on-the-wire encoding
/// is never altered (important for signature-based auth like AWS SigV4).
///
/// Fragments (`#…`) are preserved and kept after the query string.
fn apply_set_param(request_path: &mut String, name: &str, value: &str) {
    let encoded_pair = form_urlencoded::Serializer::new(String::new())
        .append_pair(name, value)
        .finish();
    let encoded_name = &encoded_pair[..encoded_pair
        .find('=')
        .expect("BUG: form_urlencoded always produces name=value")];

    // Strip fragment — query params must appear before it.
    let fragment = request_path.find('#').map(|pos| {
        let frag = request_path[pos..].to_string();
        request_path.truncate(pos);
        frag
    });

    match request_path.find('?') {
        None => {
            request_path.push('?');
            request_path.push_str(&encoded_pair);
        }
        Some(qmark) => {
            let query_start = qmark + 1;
            let query = request_path[query_start..].to_string();

            if query.is_empty() {
                request_path.push_str(&encoded_pair);
            } else {
                let mut result =
                    String::with_capacity(query_start + query.len() + 1 + encoded_pair.len());
                result.push_str(&request_path[..query_start]);

                let mut replaced = false;
                for (i, segment) in query.split('&').enumerate() {
                    if i > 0 {
                        result.push('&');
                    }
                    let seg_name = segment.split_once('=').map_or(segment, |(n, _)| n);
                    if seg_name == encoded_name && !replaced {
                        result.push_str(&encoded_pair);
                        replaced = true;
                    } else {
                        result.push_str(segment);
                    }
                }

                if !replaced {
                    result.push('&');
                    result.push_str(&encoded_pair);
                }

                *request_path = result;
            }
        }
    }

    if let Some(frag) = fragment {
        request_path.push_str(&frag);
    }
}

// ── Path injection ──────────────────────────────────────────────────────

/// Reject secret values that would reshape the URL if substituted into the path
/// raw. Path secrets are injected verbatim (so e.g. a Telegram token's `:`
/// survives), so any path-structural delimiter, percent sign, space, or control
/// character in the resolved value would corrupt or redirect the request — fail
/// safe instead. Covers values whose source (e.g. 1Password) is unknown at write
/// time, so this is the authoritative guard.
fn is_path_safe(value: &str) -> bool {
    !value
        .chars()
        .any(|c| matches!(c, '/' | '?' | '#' | '%' | ' ') || c.is_control())
}

/// Split a `path[?query][#fragment]` string into the path portion and the
/// remainder, so path rewriting never touches the query or fragment.
fn split_path_suffix(request_path: &str) -> (&str, &str) {
    match request_path.find(['?', '#']) {
        Some(pos) => request_path.split_at(pos),
        None => (request_path, ""),
    }
}

/// Template-mode path injection. Splits `template` on its single `{value}` hole,
/// requires the request path to start with the literal prefix (and, if present,
/// the literal suffix immediately after the hole), then replaces the hole — the
/// run of characters up to the next `/` — with the secret. Substitution is raw
/// (the secret must be path-safe). Returns `true` if the path was rewritten.
fn apply_set_path(request_path: &mut String, template: &str, value: &str) -> bool {
    const HOLE: &str = "{value}";

    let mut parts = template.splitn(2, HOLE);
    let prefix = parts.next().unwrap_or("");
    let Some(suffix) = parts.next() else {
        warn!("set_path skipped: template has no {{value}} placeholder");
        return false;
    };
    if suffix.contains(HOLE) {
        warn!("set_path skipped: template must contain exactly one {{value}} placeholder");
        return false;
    }
    if !is_path_safe(value) {
        warn!("set_path skipped: secret value is not path-safe");
        return false;
    }

    let (path, rest) = split_path_suffix(request_path);

    // The prefix is anchored at the start of the path.
    let Some(after_prefix) = path.strip_prefix(prefix) else {
        return false;
    };
    // The hole spans up to the next `/` (one segment / segment-suffix).
    let hole_len = after_prefix.find('/').unwrap_or(after_prefix.len());
    let after_hole = &after_prefix[hole_len..];
    // A literal suffix in the template must follow the hole.
    if !after_hole.starts_with(suffix) {
        return false;
    }

    let new_path = format!("{prefix}{value}{after_hole}");
    // Defense-in-depth: never emit a path that lost its leading `/`, which would
    // fuse with the host when the upstream URL is built (`scheme://host{path}`).
    if !new_path.starts_with('/') {
        warn!("set_path skipped: rewritten path would not start with /");
        return false;
    }
    *request_path = format!("{new_path}{rest}");
    true
}

/// Process-global cache of compiled path-rewrite regexes. Patterns come from
/// stored secrets (a small, finite set), so the cache stays bounded. Compile
/// *failures* (`None`) are cached too, so an invalid pattern isn't recompiled on
/// every request.
fn regex_cache() -> &'static DashMap<String, Option<Arc<Regex>>> {
    static CACHE: OnceLock<DashMap<String, Option<Arc<Regex>>>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

fn compiled_regex(pattern: &str) -> Option<Arc<Regex>> {
    if let Some(entry) = regex_cache().get(pattern) {
        return entry.clone();
    }
    let compiled = match Regex::new(pattern) {
        Ok(re) => Some(Arc::new(re)),
        Err(e) => {
            warn!(error = %e, "replace_path_regex skipped: invalid pattern");
            None
        }
    };
    regex_cache().insert(pattern.to_string(), compiled.clone());
    compiled
}

/// Regex-mode path injection (advanced). Applies `pattern`/`replacement` to the
/// path portion only. The secret is substituted at the `{value}` positions of the
/// replacement template, split out before `$N` expansion — so neither a `$` in the
/// secret nor a `{value}` inside a captured group is ever reinterpreted. First
/// match only. Returns `true` if the path was rewritten.
fn apply_replace_path_regex(
    request_path: &mut String,
    pattern: &str,
    replacement: &str,
    value: &str,
) -> bool {
    if !is_path_safe(value) {
        warn!("replace_path_regex skipped: secret value is not path-safe");
        return false;
    }
    let Some(re) = compiled_regex(pattern) else {
        return false;
    };

    let (path, rest) = split_path_suffix(request_path);
    let rewritten = re.replace(path, |caps: &regex::Captures| {
        // Substitute the secret only at the `{value}` positions of the replacement
        // *template* — split out before `$N` expansion — so neither a `$` in the
        // secret nor a `{value}` that appears inside a captured group is ever
        // reinterpreted: the secret lands only where the operator put `{value}`.
        let mut out = String::new();
        for (i, segment) in replacement.split("{value}").enumerate() {
            if i > 0 {
                out.push_str(value);
            }
            caps.expand(segment, &mut out);
        }
        out
    });

    match rewritten {
        // No match — the path is unchanged, so nothing was injected.
        Cow::Borrowed(_) => false,
        // Defense-in-depth: never emit a path that lost its leading `/`, which
        // would fuse with the host when the upstream URL is built.
        Cow::Owned(new_path) if !new_path.starts_with('/') => {
            warn!("replace_path_regex skipped: rewritten path would not start with /");
            false
        }
        Cow::Owned(new_path) => {
            *request_path = format!("{new_path}{rest}");
            true
        }
    }
}

/// Check if a request path matches a rule's path pattern.
///
/// Supported patterns (checked in order):
/// - `"*"` — matches any path
/// - `"/a/*/b"` — segment wildcard (`*` matches one segment, e.g. `/repos/*/issues`)
/// - `"/a/*/b/*:action"` — segment wildcard with in-segment glob (`*:predict` matches `ep123:predict`)
/// - `"/foo/*/bar/*"` — mixed (segment globs + trailing wildcard matches 1+ segments)
/// - `"/prefix/*"` — prefix with path boundary (`/v1/*` matches `/v1/foo` but not `/v1beta`)
/// - `"/prefix*"` — glob prefix (`/v1.0/me/messages*` matches `/v1.0/me/messages/123`)
/// - exact match — path must equal pattern exactly
///
/// Query strings in `request_path` are stripped before comparison.
pub(crate) fn path_matches(request_path: &str, pattern: &str) -> bool {
    let path = request_path.split('?').next().unwrap_or(request_path);
    if pattern == "*" {
        return true;
    }
    if has_mid_path_wildcard(pattern) {
        return segment_wildcard_matches(path, pattern);
    }
    if let Some(prefix) = pattern.strip_suffix("/*") {
        return path == prefix
            || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'));
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return path.starts_with(prefix);
    }
    path == pattern
}

fn has_mid_path_wildcard(pattern: &str) -> bool {
    pattern.len() > 1 && pattern[..pattern.len() - 1].contains('*')
}

/// Match patterns with `*` wildcards in path segments. Each `*` matches
/// any characters within a single segment (no `/` crossing), except a
/// trailing standalone `*` which matches one or more remaining segments.
///
/// - `*` as a full segment matches any segment
/// - `*:predict` matches `abc:predict` (glob within a segment)
/// - trailing `*` matches 1+ remaining segments
fn segment_wildcard_matches(path: &str, pattern: &str) -> bool {
    let path_segs: Vec<&str> = path.split('/').collect();
    let pat_segs: Vec<&str> = pattern.split('/').collect();

    let trailing_wild = pat_segs.last() == Some(&"*");
    let fixed_pats = if trailing_wild {
        &pat_segs[..pat_segs.len() - 1]
    } else {
        &pat_segs[..]
    };

    if trailing_wild {
        if path_segs.len() < fixed_pats.len() + 1 {
            return false;
        }
    } else if path_segs.len() != pat_segs.len() {
        return false;
    }

    for (pat, seg) in fixed_pats.iter().zip(path_segs.iter()) {
        if !segment_matches(seg, pat) {
            return false;
        }
    }
    true
}

fn segment_matches(segment: &str, pattern: &str) -> bool {
    match pattern.find('*') {
        None => segment == pattern,
        Some(pos) => {
            let prefix = &pattern[..pos];
            let suffix = &pattern[pos + 1..];
            segment.starts_with(prefix)
                && segment.ends_with(suffix)
                && segment.len() >= prefix.len() + suffix.len()
        }
    }
}

// ── Vault credential → injection rules ──────────────────────────────

/// Convert a vault credential to injection rules for a given hostname.
/// Anthropic uses `x-api-key`, everything else defaults to `Authorization: Bearer`.
pub(crate) fn vault_credential_to_rules(
    hostname: &str,
    cred: &VaultCredential,
) -> Vec<InjectionRule> {
    let password = match cred.password.as_deref() {
        Some(p) if !p.is_empty() => p,
        _ => return vec![],
    };

    let injections = match hostname {
        "api.anthropic.com" => vec![
            Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: password.to_string(),
            },
            Injection::RemoveHeader {
                name: "authorization".to_string(),
            },
        ],
        _ => vec![Injection::SetHeader {
            name: "authorization".to_string(),
            value: format!("Bearer {password}"),
        }],
    };

    vec![InjectionRule {
        path_pattern: "*".to_string(),
        injections,
    }]
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use hyper::Method;

    use super::*;

    // ── Agent token extraction ──────────────────────────────────────────

    /// Helper: build a minimal request with an optional Proxy-Authorization header.
    fn request_with_proxy_auth(auth: Option<&str>) -> Request<()> {
        let mut builder = Request::builder()
            .method(Method::CONNECT)
            .uri("example.com:443");
        if let Some(value) = auth {
            builder = builder.header("proxy-authorization", value);
        }
        builder.body(()).expect("build request")
    }

    fn encode_basic_auth(token: &str) -> String {
        // Convention: dummy username "x", token as password (like GitHub/GitLab)
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("x:{token}"));
        format!("Basic {encoded}")
    }

    #[test]
    fn extract_token_valid() {
        // Standard format: x:token (token in password field)
        let req = request_with_proxy_auth(Some(&encode_basic_auth("aoc_test123")));
        assert_eq!(extract_agent_token(&req).as_deref(), Some("aoc_test123"));
    }

    #[test]
    fn extract_token_legacy_username_format() {
        // Legacy format: token: (token in username field, empty password)
        let encoded = base64::engine::general_purpose::STANDARD.encode("aoc_legacy:");
        let req = request_with_proxy_auth(Some(&format!("Basic {encoded}")));
        assert_eq!(extract_agent_token(&req).as_deref(), Some("aoc_legacy"));
    }

    #[test]
    fn extract_token_without_colon() {
        // Some clients might send just the token without ":"
        let encoded = base64::engine::general_purpose::STANDARD.encode("aoc_nocolon");
        let req = request_with_proxy_auth(Some(&format!("Basic {encoded}")));
        assert_eq!(extract_agent_token(&req).as_deref(), Some("aoc_nocolon"));
    }

    #[test]
    fn extract_token_missing_header() {
        let req = request_with_proxy_auth(None);
        assert_eq!(extract_agent_token(&req), None);
    }

    #[test]
    fn extract_token_wrong_scheme() {
        let req = request_with_proxy_auth(Some("Bearer some_token"));
        assert_eq!(extract_agent_token(&req), None);
    }

    #[test]
    fn extract_token_invalid_base64() {
        let req = request_with_proxy_auth(Some("Basic !!!not-base64!!!"));
        assert_eq!(extract_agent_token(&req), None);
    }

    #[test]
    fn extract_token_empty_value() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(":");
        let req = request_with_proxy_auth(Some(&format!("Basic {encoded}")));
        // Empty token (just ":") → returns Some("") which the caller rejects
        assert_eq!(extract_agent_token(&req).as_deref(), Some(""));
    }

    // ── path_matches ────────────────────────────────────────────────────

    #[test]
    fn path_wildcard_matches_everything() {
        assert!(path_matches("/v1/messages", "*"));
        assert!(path_matches("/", "*"));
        assert!(path_matches("/any/path/here", "*"));
    }

    #[test]
    fn path_prefix_wildcard() {
        assert!(path_matches("/v1/messages", "/v1/*"));
        assert!(path_matches("/v1/", "/v1/*"));
        assert!(path_matches("/v1/completions/stream", "/v1/*"));
        // The prefix itself without trailing slash
        assert!(path_matches("/v1", "/v1/*"));
    }

    #[test]
    fn path_prefix_wildcard_rejects_non_matching() {
        assert!(!path_matches("/v2/messages", "/v1/*"));
        assert!(!path_matches("/", "/v1/*"));
        assert!(!path_matches("/v1beta/foo", "/v1/*"));
    }

    #[test]
    fn path_exact() {
        assert!(path_matches("/v1/messages", "/v1/messages"));
        assert!(!path_matches("/v1/messages/", "/v1/messages"));
        assert!(!path_matches("/v1/other", "/v1/messages"));
    }

    #[test]
    fn path_glob_prefix() {
        // "/v1.0/me/messages*" — generated by build_app_injection_rules for path_prefix providers
        assert!(path_matches("/v1.0/me/messages", "/v1.0/me/messages*"));
        assert!(path_matches("/v1.0/me/messages/123", "/v1.0/me/messages*"));
        assert!(path_matches(
            "/v1.0/me/messages/123/attachments",
            "/v1.0/me/messages*"
        ));
        assert!(!path_matches("/v1.0/me/mailFolders", "/v1.0/me/messages*"));
        assert!(!path_matches("/v1.0/me/", "/v1.0/me/messages*"));
    }

    #[test]
    fn path_glob_prefix_with_query_string() {
        assert!(path_matches(
            "/v1.0/me/messages?$top=10&$select=subject",
            "/v1.0/me/messages*"
        ));
    }

    #[test]
    fn path_segment_wildcard() {
        // "/repos/*/issues" — mid-path segment wildcard for app permissions
        assert!(path_matches("/repos/myrepo/issues", "/repos/*/issues"));
        assert!(path_matches("/repos/other-repo/issues", "/repos/*/issues"));
        assert!(!path_matches("/repos/myrepo/pulls", "/repos/*/issues"));
        assert!(!path_matches("/repos/issues", "/repos/*/issues"));
        assert!(!path_matches("/repos/myrepo/sub/issues", "/repos/*/issues"));
    }

    #[test]
    fn path_segment_wildcard_multiple() {
        // Multiple segment wildcards
        assert!(path_matches(
            "/repos/myrepo/issues/123/comments",
            "/repos/*/issues/*/comments"
        ));
        assert!(!path_matches(
            "/repos/myrepo/issues/comments",
            "/repos/*/issues/*/comments"
        ));
        assert!(!path_matches(
            "/repos/myrepo/pulls/123/comments",
            "/repos/*/issues/*/comments"
        ));
    }

    #[test]
    fn path_segment_wildcard_with_query_string() {
        assert!(path_matches(
            "/repos/myrepo/issues?state=open",
            "/repos/*/issues"
        ));
    }

    #[test]
    fn path_segment_wildcard_trailing() {
        // "/gmail/v1/users/*/messages/*" — mid-path wildcard + trailing segment wildcard
        assert!(path_matches(
            "/gmail/v1/users/me/messages/abc123",
            "/gmail/v1/users/*/messages/*"
        ));
        assert!(!path_matches(
            "/gmail/v1/users/me/messages",
            "/gmail/v1/users/*/messages/*"
        ));
        assert!(!path_matches(
            "/gmail/v1/users/me/threads/abc123",
            "/gmail/v1/users/*/messages/*"
        ));
    }

    #[test]
    fn path_segment_glob_suffix() {
        // "/v1/documents/*:batchUpdate" — `*` matches prefix within segment
        assert!(path_matches(
            "/v1/documents/doc123:batchUpdate",
            "/v1/documents/*:batchUpdate"
        ));
        assert!(!path_matches(
            "/v1/documents/doc123:getContent",
            "/v1/documents/*:batchUpdate"
        ));
        assert!(!path_matches(
            "/v1/documents/doc123",
            "/v1/documents/*:batchUpdate"
        ));
    }

    #[test]
    fn path_segment_glob_compound() {
        // "/v1/projects/*/locations/*/endpoints/*:predict" — real Vertex AI pattern
        assert!(path_matches(
            "/v1/projects/my-proj/locations/us-central1/endpoints/ep123:predict",
            "/v1/projects/*/locations/*/endpoints/*:predict"
        ));
        assert!(!path_matches(
            "/v1/projects/my-proj/locations/us-central1/endpoints/ep123:explain",
            "/v1/projects/*/locations/*/endpoints/*:predict"
        ));
    }

    /// Regression guard for app-permission catalog patterns: each pattern must
    /// match the REAL request path its operation produces. A `*` matches exactly
    /// one path segment, so a pattern with too few segments silently never
    /// matches and the permission becomes a no-op. These cases encode endpoints
    /// verified against official provider docs; see
    /// `packages/api/src/apps/app-permissions/*`.
    #[test]
    fn app_permission_patterns_match_real_endpoints() {
        // GitHub REST nests under /repos/{owner}/{repo}/... (two path params).
        assert!(path_matches(
            "/repos/octocat/hello/pulls",
            "/repos/*/*/pulls"
        ));
        assert!(path_matches(
            "/repos/octocat/hello/issues",
            "/repos/*/*/issues"
        ));
        assert!(path_matches(
            "/repos/octocat/hello/issues/42/comments",
            "/repos/*/*/issues/*/comments"
        ));
        // Branch ref contains a slash (heads/<branch>); trailing * absorbs it.
        assert!(path_matches(
            "/repos/octocat/hello/git/refs/heads/main",
            "/repos/*/*/git/refs/*"
        ));
        // The old one-param shapes must NOT match real two-param paths.
        assert!(!path_matches(
            "/repos/octocat/hello/pulls",
            "/repos/*/pulls"
        ));
        assert!(!path_matches(
            "/repos/octocat/hello/issues",
            "/repos/*/issues"
        ));
        // GitHub git-over-HTTPS: POST to {owner}/{repo}.git/git-upload-pack.
        assert!(path_matches(
            "/octocat/hello.git/git-upload-pack",
            "/*/*/git-upload-pack"
        ));

        // Confluence Cloud via OAuth 3LO is served under /ex/confluence/{cloudid}.
        assert!(path_matches(
            "/ex/confluence/abc123/wiki/api/v2/pages/77",
            "/ex/confluence/*/wiki/api/v2/pages/*"
        ));
        assert!(path_matches(
            "/ex/confluence/abc123/wiki/rest/api/search",
            "/ex/confluence/*/wiki/rest/api/search"
        ));
        // Bare /wiki/... (missing the cloudid prefix) was the systemic bug.
        assert!(!path_matches(
            "/ex/confluence/abc123/wiki/api/v2/pages/77",
            "/wiki/api/v2/pages/*"
        ));

        // Jira Cloud JQL search migrated from /search to /search/jql.
        assert!(path_matches(
            "/ex/jira/abc123/rest/api/3/search/jql",
            "/ex/jira/*/rest/api/3/search/jql"
        ));

        // Sentry project issues nest under {org}/{project} (two slugs).
        assert!(path_matches(
            "/api/0/projects/acme/web/issues/",
            "/api/0/projects/*/*/issues/"
        ));
        assert!(!path_matches(
            "/api/0/projects/acme/web/issues/",
            "/api/0/projects/*/issues/"
        ));

        // Docker Hub destructive ops live on /v2/repositories/{ns}/{repo}/.
        assert!(path_matches(
            "/v2/repositories/acme/app/",
            "/v2/repositories/*/*"
        ));
        assert!(path_matches(
            "/v2/repositories/acme/app/tags/latest/",
            "/v2/repositories/*/*/tags/*"
        ));

        // Google Drive / YouTube media writes go to the /upload/... host path.
        assert!(path_matches(
            "/upload/drive/v3/files/file123",
            "/upload/drive/v3/files/*"
        ));
        assert!(path_matches(
            "/upload/youtube/v3/videos",
            "/upload/youtube/v3/videos"
        ));

        // Todoist migrated to /api/v1/...; Outlook respond aliases.
        assert!(path_matches(
            "/api/v1/tasks/abc/close",
            "/api/v1/tasks/*/close"
        ));
        assert!(path_matches(
            "/v1.0/me/events/evt1/tentativelyAccept",
            "/v1.0/me/events/*/tentativelyAccept"
        ));
    }

    #[test]
    fn path_matches_ignores_query_string() {
        assert!(path_matches("/v1/messages?api_key=sk-123", "/v1/messages"));
        assert!(path_matches("/v1/messages?api_key=sk-123", "/v1/*"));
        assert!(path_matches("/v1/messages?api_key=sk-123", "*"));
        assert!(!path_matches("/v2/messages?api_key=sk-123", "/v1/*"));
        assert!(!path_matches("/v1/messages?api_key=sk-123", "/v1/other"));
    }

    #[test]
    fn path_mid_segment_glob() {
        // Google Calendar: block POST to /calendar/v3/calendars/*/events
        assert!(path_matches(
            "/calendar/v3/calendars/primary/events",
            "/calendar/v3/calendars/*/events"
        ));
        assert!(path_matches(
            "/calendar/v3/calendars/abc123/events",
            "/calendar/v3/calendars/*/events"
        ));
        // Wrong suffix — should not match
        assert!(!path_matches(
            "/calendar/v3/calendars/primary/settings",
            "/calendar/v3/calendars/*/events"
        ));
        // Too few segments
        assert!(!path_matches(
            "/calendar/v3/calendars/events",
            "/calendar/v3/calendars/*/events"
        ));
        // Too many segments
        assert!(!path_matches(
            "/calendar/v3/calendars/primary/events/extra",
            "/calendar/v3/calendars/*/events"
        ));
    }

    #[test]
    fn path_mid_glob_with_trailing_wildcard() {
        // /calendar/v3/calendars/*/events/* — glob + trailing wildcard
        assert!(path_matches(
            "/calendar/v3/calendars/primary/events/eventId123",
            "/calendar/v3/calendars/*/events/*"
        ));
        assert!(path_matches(
            "/calendar/v3/calendars/primary/events/eventId123/instances",
            "/calendar/v3/calendars/*/events/*"
        ));
        // Must have at least one segment after "events"
        assert!(!path_matches(
            "/calendar/v3/calendars/primary/events",
            "/calendar/v3/calendars/*/events/*"
        ));
    }

    #[test]
    fn path_multiple_mid_globs() {
        assert!(path_matches(
            "/api/v1/orgs/myorg/repos/myrepo/issues",
            "/api/v1/orgs/*/repos/*/issues"
        ));
        assert!(!path_matches(
            "/api/v1/orgs/myorg/repos/myrepo/pulls",
            "/api/v1/orgs/*/repos/*/issues"
        ));
    }

    // ── apply_injections ────────────────────────────────────────────────

    fn make_rule(path_pattern: &str, injections: Vec<Injection>) -> InjectionRule {
        InjectionRule {
            path_pattern: path_pattern.to_string(),
            injections,
        }
    }

    fn set_header(name: &str, value: &str) -> Injection {
        Injection::SetHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    fn remove_header(name: &str) -> Injection {
        Injection::RemoveHeader {
            name: name.to_string(),
        }
    }

    #[test]
    fn inject_set_header() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("application/json"));

        let rules = vec![make_rule("*", vec![set_header("x-api-key", "sk-ant-123")])];

        let count = apply_injections(&mut headers, &mut "/v1/messages".to_string(), &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("x-api-key").unwrap(), "sk-ant-123");
        // Original header preserved
        assert_eq!(headers.get("accept").unwrap(), "application/json");
    }

    #[test]
    fn inject_set_header_overwrites_existing() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer old-token"),
        );

        let rules = vec![make_rule(
            "*",
            vec![set_header("authorization", "Bearer new-token")],
        )];

        let count = apply_injections(&mut headers, &mut "/".to_string(), &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("authorization").unwrap(), "Bearer new-token");
    }

    #[test]
    fn inject_replace_header_when_present() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer placeholder"),
        );

        let rules = vec![make_rule(
            "*",
            vec![Injection::ReplaceHeader {
                name: "authorization".to_string(),
                value: "Bearer real-token".to_string(),
            }],
        )];

        let count = apply_injections(&mut headers, &mut "/".to_string(), &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("authorization").unwrap(), "Bearer real-token");
    }

    #[test]
    fn inject_replace_header_skips_when_absent() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("x-api-key", HeaderValue::from_static("temp-key"));

        let rules = vec![make_rule(
            "*",
            vec![Injection::ReplaceHeader {
                name: "authorization".to_string(),
                value: "Bearer real-token".to_string(),
            }],
        )];

        let count = apply_injections(&mut headers, &mut "/".to_string(), &rules);
        assert_eq!(count, 0);
        assert!(headers.get("authorization").is_none());
        // x-api-key untouched
        assert_eq!(headers.get("x-api-key").unwrap(), "temp-key");
    }

    #[test]
    fn inject_remove_header() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer token"));
        headers.insert("accept", HeaderValue::from_static("application/json"));

        let rules = vec![make_rule("*", vec![remove_header("authorization")])];

        let count = apply_injections(&mut headers, &mut "/".to_string(), &rules);
        assert_eq!(count, 1);
        assert!(headers.get("authorization").is_none());
        // Other headers preserved
        assert_eq!(headers.get("accept").unwrap(), "application/json");
    }

    #[test]
    fn inject_remove_nonexistent_counts_zero() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("application/json"));

        let rules = vec![make_rule("*", vec![remove_header("x-not-present")])];

        let count = apply_injections(&mut headers, &mut "/".to_string(), &rules);
        assert_eq!(count, 0);
    }

    #[test]
    fn inject_combined_set_and_remove() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer old"));

        let rules = vec![make_rule(
            "*",
            vec![
                set_header("x-api-key", "sk-ant-123"),
                remove_header("authorization"),
            ],
        )];

        let count = apply_injections(&mut headers, &mut "/v1/messages".to_string(), &rules);
        assert_eq!(count, 2);
        assert_eq!(headers.get("x-api-key").unwrap(), "sk-ant-123");
        assert!(headers.get("authorization").is_none());
    }

    #[test]
    fn inject_path_mismatch_skips_rule() {
        let mut headers = hyper::HeaderMap::new();

        let rules = vec![make_rule(
            "/v1/*",
            vec![set_header("x-api-key", "sk-ant-123")],
        )];

        let count = apply_injections(&mut headers, &mut "/v2/messages".to_string(), &rules);
        assert_eq!(count, 0);
        assert!(headers.get("x-api-key").is_none());
    }

    #[test]
    fn inject_multiple_rules_different_paths() {
        let mut headers = hyper::HeaderMap::new();

        let rules = vec![
            make_rule("/v1/*", vec![set_header("x-api-key", "key-v1")]),
            make_rule("/v2/*", vec![set_header("x-api-key", "key-v2")]),
        ];

        // Only the /v1 rule should match
        let count = apply_injections(&mut headers, &mut "/v1/messages".to_string(), &rules);
        assert_eq!(count, 1);
        assert_eq!(headers.get("x-api-key").unwrap(), "key-v1");
    }

    #[test]
    fn inject_no_rules_returns_zero() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("*/*"));

        let count = apply_injections(&mut headers, &mut "/anything".to_string(), &[]);
        assert_eq!(count, 0);
    }

    // ── vault_credential_to_rules ──────────────────────────────────────

    fn cred(password: Option<&str>) -> VaultCredential {
        VaultCredential {
            username: None,
            password: password.map(|s| s.to_string()),
        }
    }

    #[test]
    fn vault_cred_anthropic_uses_x_api_key() {
        let rules = vault_credential_to_rules("api.anthropic.com", &cred(Some("sk-ant-123")));
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].injections.len(), 2);
        assert_eq!(
            rules[0].injections[0],
            Injection::SetHeader {
                name: "x-api-key".to_string(),
                value: "sk-ant-123".to_string(),
            }
        );
        assert_eq!(
            rules[0].injections[1],
            Injection::RemoveHeader {
                name: "authorization".to_string(),
            }
        );
    }

    #[test]
    fn vault_cred_default_uses_bearer() {
        let rules = vault_credential_to_rules("api.openai.com", &cred(Some("sk-proj-abc")));
        assert_eq!(rules.len(), 1);
        assert_eq!(
            rules[0].injections[0],
            Injection::SetHeader {
                name: "authorization".to_string(),
                value: "Bearer sk-proj-abc".to_string(),
            }
        );
    }

    #[test]
    fn vault_cred_no_password_returns_empty() {
        assert!(vault_credential_to_rules("api.openai.com", &cred(None)).is_empty());
    }

    #[test]
    fn vault_cred_empty_password_returns_empty() {
        assert!(vault_credential_to_rules("api.openai.com", &cred(Some(""))).is_empty());
    }

    // ── SetParam ───────────────────────────────────────────────────────

    fn set_param(name: &str, value: &str) -> Injection {
        Injection::SetParam {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn inject_set_param_no_existing_query() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search".to_string();

        let rules = vec![make_rule("*", vec![set_param("api_key", "sk-123")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/v1/search?api_key=sk-123");
    }

    #[test]
    fn inject_set_param_with_existing_query() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search?q=hello".to_string();

        let rules = vec![make_rule("*", vec![set_param("api_key", "sk-123")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert!(path.contains("q=hello"));
        assert!(path.contains("api_key=sk-123"));
        assert!(path.starts_with("/v1/search?"));
    }

    #[test]
    fn inject_set_param_replaces_existing() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search?api_key=old-key&q=hello".to_string();

        let rules = vec![make_rule("*", vec![set_param("api_key", "new-key")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert!(path.contains("api_key=new-key"));
        assert!(!path.contains("old-key"));
        assert!(path.contains("q=hello"));
    }

    #[test]
    fn inject_set_param_path_mismatch_skips() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v2/search".to_string();

        let rules = vec![make_rule("/v1/*", vec![set_param("api_key", "sk-123")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/v2/search");
    }

    #[test]
    fn inject_set_param_combined_with_header() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search".to_string();

        let rules = vec![make_rule(
            "*",
            vec![
                set_header("x-custom", "value"),
                set_param("api_key", "sk-123"),
            ],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 2);
        assert_eq!(headers.get("x-custom").unwrap(), "value");
        assert_eq!(path, "/v1/search?api_key=sk-123");
    }

    #[test]
    fn inject_set_param_empty_query_after_qmark() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search?".to_string();

        let rules = vec![make_rule("*", vec![set_param("api_key", "sk-123")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/v1/search?api_key=sk-123");
    }

    #[test]
    fn inject_set_param_special_chars_in_value() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search".to_string();

        let rules = vec![make_rule("*", vec![set_param("token", "a=b&c=d")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/v1/search?token=a%3Db%26c%3Dd");
    }

    #[test]
    fn inject_set_param_special_chars_in_name() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search".to_string();

        let rules = vec![make_rule("*", vec![set_param("my key", "value")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/v1/search?my+key=value");
    }

    #[test]
    fn inject_set_param_preserves_fragment() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search#section".to_string();

        let rules = vec![make_rule("*", vec![set_param("api_key", "sk-123")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/v1/search?api_key=sk-123#section");
    }

    #[test]
    fn inject_set_param_with_query_and_fragment() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/search?q=hello#section".to_string();

        let rules = vec![make_rule("*", vec![set_param("api_key", "sk-123")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert!(path.contains("q=hello"));
        assert!(path.contains("api_key=sk-123"));
        assert!(path.ends_with("#section"));
    }

    #[test]
    fn inject_set_param_second_rule_exact_match_after_mutation() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/messages".to_string();

        let rules = vec![
            make_rule("*", vec![set_param("api_key", "sk-123")]),
            make_rule("/v1/messages", vec![set_header("x-custom", "value")]),
        ];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 2);
        assert!(path.contains("api_key=sk-123"));
        assert_eq!(headers.get("x-custom").unwrap(), "value");
    }

    // ── SetPath (template mode) ────────────────────────────────────────

    fn set_path(template: &str, value: &str) -> Injection {
        Injection::SetPath {
            template: template.to_string(),
            value: value.to_string(),
        }
    }

    /// The canonical Telegram case: the agent emits any filler in the token slot
    /// and the gateway repairs it — and the token's `:` must survive un-encoded.
    #[test]
    fn inject_set_path_telegram() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botPLACEHOLDER/sendMessage".to_string();

        let token = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
        let rules = vec![make_rule("*", vec![set_path("/bot{value}", token)])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, format!("/bot{token}/sendMessage"));
        // The `:` is a valid path char and must NOT be percent-encoded.
        assert!(path.contains(':'));
    }

    /// The agent can even send an empty token slot; the gateway fills it.
    #[test]
    fn inject_set_path_empty_filler() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/bot/sendMessage".to_string();

        let rules = vec![make_rule("*", vec![set_path("/bot{value}", "123:ABC")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/bot123:ABC/sendMessage");
    }

    #[test]
    fn inject_set_path_preserves_query_and_fragment() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botX/sendMessage?chat_id=5#frag".to_string();

        let rules = vec![make_rule("*", vec![set_path("/bot{value}", "123:ABC")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/bot123:ABC/sendMessage?chat_id=5#frag");
    }

    #[test]
    fn inject_set_path_prefix_mismatch_is_noop() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/v1/other".to_string();

        let rules = vec![make_rule("*", vec![set_path("/bot{value}", "123:ABC")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/v1/other");
    }

    /// A literal suffix after the hole must match (so a template can pin a method).
    #[test]
    fn inject_set_path_literal_suffix_guard() {
        let rules = vec![make_rule(
            "*",
            vec![set_path("/bot{value}/sendMessage", "123:ABC")],
        )];

        let mut matching = "/botX/sendMessage".to_string();
        let mut headers = hyper::HeaderMap::new();
        assert_eq!(apply_injections(&mut headers, &mut matching, &rules), 1);
        assert_eq!(matching, "/bot123:ABC/sendMessage");

        let mut other = "/botX/getUpdates".to_string();
        assert_eq!(
            apply_injections(&mut hyper::HeaderMap::new(), &mut other, &rules),
            0
        );
        assert_eq!(other, "/botX/getUpdates");
    }

    /// A secret containing a path-structural char would reshape the URL — skip.
    #[test]
    fn inject_set_path_unsafe_value_skipped() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botX/sendMessage".to_string();

        let rules = vec![make_rule("*", vec![set_path("/bot{value}", "12/34")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/botX/sendMessage");
    }

    #[test]
    fn inject_set_path_missing_placeholder_skipped() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botX/sendMessage".to_string();

        let rules = vec![make_rule("*", vec![set_path("/bot", "123:ABC")])];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/botX/sendMessage");
    }

    // ── ReplacePathRegex (advanced mode) ───────────────────────────────

    fn replace_path_regex(pattern: &str, replacement: &str, value: &str) -> Injection {
        Injection::ReplacePathRegex {
            pattern: pattern.to_string(),
            replacement: replacement.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn inject_replace_path_regex_telegram() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botFAKE/sendMessage".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(
                r"^/bot[^/]+(/.*)?$",
                "/bot{value}$1",
                "123:ABC",
            )],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/bot123:ABC/sendMessage");
    }

    /// The capture group may be empty (no trailing path).
    #[test]
    fn inject_replace_path_regex_empty_capture() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botFAKE".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(
                r"^/bot[^/]+(/.*)?$",
                "/bot{value}$1",
                "123:ABC",
            )],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/bot123:ABC");
    }

    #[test]
    fn inject_replace_path_regex_preserves_query() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botFAKE/sendMessage?chat_id=5".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(
                r"^/bot[^/]+(/.*)?$",
                "/bot{value}$1",
                "123:ABC",
            )],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/bot123:ABC/sendMessage?chat_id=5");
    }

    /// Security: a `$1` inside the secret must be inserted literally, never
    /// reinterpreted as a capture reference (the secret is spliced in AFTER
    /// `$N` expansion).
    #[test]
    fn inject_replace_path_regex_dollar_in_secret_is_literal() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botFAKE".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(r"^/bot[^/]+$", "/bot{value}", "ab$1cd")],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/botab$1cd");
    }

    /// Security: a `{value}` that lands inside a captured group must stay literal —
    /// the secret is placed only where the operator wrote `{value}` in the
    /// replacement, never in agent-controlled captured content.
    #[test]
    fn inject_replace_path_regex_value_in_capture_is_literal() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/bot{value}".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(
                r"^/bot(.+)$",
                "/bot{value}/$1",
                "SECRET",
            )],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 1);
        assert_eq!(path, "/botSECRET/{value}");
    }

    /// Defense-in-depth: a replacement that would strip the leading `/` (fusing
    /// the path with the host) is skipped rather than emitted.
    #[test]
    fn inject_replace_path_regex_slashless_result_skipped() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botX".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(r"^/bot[^/]+$", "bot{value}", "SECRET")],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/botX");
    }

    #[test]
    fn inject_replace_path_regex_invalid_pattern_skipped() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botFAKE/sendMessage".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex("[unclosed", "/bot{value}", "123:ABC")],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/botFAKE/sendMessage");
    }

    #[test]
    fn inject_replace_path_regex_no_match_is_noop() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/other/path".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(r"^/bot[^/]+$", "/bot{value}", "123:ABC")],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/other/path");
    }

    #[test]
    fn inject_replace_path_regex_unsafe_value_skipped() {
        let mut headers = hyper::HeaderMap::new();
        let mut path = "/botFAKE".to_string();

        let rules = vec![make_rule(
            "*",
            vec![replace_path_regex(r"^/bot[^/]+$", "/bot{value}", "12#34")],
        )];

        let count = apply_injections(&mut headers, &mut path, &rules);
        assert_eq!(count, 0);
        assert_eq!(path, "/botFAKE");
    }
}
