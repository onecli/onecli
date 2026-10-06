//! Google Drive — request-level granular access (per-agent folder allowlist).
//!
//! Google OAuth tokens can't be scoped to folders, so — like Dropbox — the
//! allowlist is enforced here by inspecting each request. Unlike Dropbox, Drive
//! addresses everything by opaque file ID rather than by path, so whether a
//! target is "inside" an allowed folder can't be read off the request: it is
//! decided by walking the target's LIVE parent chain upstream, with the very
//! credential the request carries.
//!
//! ## Policy shape
//!
//! `{"driveFolders": ["<id>/<id>/…", …]}` — each entry is the chain of folder
//! IDs from the top of a drive down to the selected folder, as the dashboard
//! picker browsed it (a shared drive's ID heads its chain; My Drive's root is
//! omitted). A target is in scope when its live ancestor set (itself
//! included) contains EVERY ID of at least one chain.
//!
//! Checking the whole chain rather than only its last folder is what keeps
//! composition sound without I/O: an org boundary `A` and a workspace
//! selection `A/B` intersect to `A/B` purely, and if `B` is later moved out of
//! `A` the live walk no longer finds `A`, so the boundary still holds.
//!
//! ## Enforcement
//!
//! Strict default-deny: an endpoint is permitted only when every file it
//! touches (the path's file ID, `addParents`, a create's `parents`, …) can be
//! named and verified in scope. `files.list` must be narrowed to the children
//! of an in-scope folder (`'<id>' in parents`, ANDed with anything else).
//! Batch requests, the changes feed, Drive v2, and anything unrecognised are
//! refused.
//!
//! ## Reading the request exactly as Google does
//!
//! A verdict only holds if this guard and Google's front end see the same
//! request. Every channel through which Google would execute a different
//! method, read different parameters, or decode a different body than the one
//! classified here is therefore refused outright — each observed against the
//! live API: `$`-prefixed system parameters (`$httpMethod`, `$ct`), the
//! method-override headers (`X-HTTP-Method-Override` and kin), form-encoded
//! bodies (whose fields Google merges into the parameters), the
//! upload-protocol selectors, repeated parameters, headers, or JSON keys
//! (Google keeps the first, serde the last), and metadata bodies not declared
//! as UTF-8 JSON. Parameters and JSON fields are read under both spellings
//! Google accepts (`addParents`/`add_parents`).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;

use super::{RequestGuard, ResourceAxis};

/// How a Drive folder scope works, for the agent's self-correction. Each
/// allowed entry is a chain of folder IDs from the top of a drive down to the
/// selected folder; only that LAST folder and what sits beneath it are
/// reachable — its parents are not.
const HINT: &str = "Each allowed entry is a path of Google Drive folder IDs (top/…/selected); \
     only the LAST folder in each path and everything inside it can be reached, \
     not the folders above it. List a folder with q=\"'<folderId>' in parents\", \
     and create or move files only into an allowed folder.";
/// The refusal for a `files.list` that isn't confined to one folder.
const LIST_HINT: &str = "files.list must be confined to an allowed folder: \
                         q=\"'<folderId>' in parents\" (optionally `and` other terms)";
const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";

/// System parameters (`$…`) that can't change what a request does: only the
/// error-format selector, a standard parameter in Drive's discovery document.
const HARMLESS_SYSTEM_PARAMS: &[&str] = &["$.xgafv"];

/// Upper bound on upstream metadata lookups for ONE target's ancestry walk.
/// Drive nests folders at most 100 deep (My Drive and shared drives alike), so
/// this covers the deepest legal chain plus the target itself; hitting it means
/// "can't verify" → deny.
const MAX_LOOKUPS: usize = 101;
/// How long a file's parent list is reused. Short on purpose: a folder a user
/// moves out of scope must stop being reachable within this window.
const PARENT_CACHE_TTL: Duration = Duration::from_secs(30);
const PARENT_CACHE_MAX: usize = 10_000;

pub(super) struct GoogleDrive;

// ── Policy model ─────────────────────────────────────────────────────────

/// The IDs an entry requires to be among a target's ancestors.
fn chain_ids(entry: &str) -> Vec<&str> {
    entry.split('/').filter(|s| !s.is_empty()).collect()
}

/// Whether the collected ancestor IDs satisfy at least one chain.
fn satisfied(seen: &HashSet<String>, allowed: &[String]) -> bool {
    allowed
        .iter()
        .any(|c| chain_ids(c).iter().all(|id| seen.contains(*id)))
}

/// A chain contains another when it requires every ID the other does — so
/// whatever satisfies the narrower entry satisfies the wider one too. Pure and
/// sound; the live walk re-verifies the full chain on every request.
impl ResourceAxis for GoogleDrive {
    fn key(&self) -> &'static str {
        "driveFolders"
    }

    /// IDs are case-sensitive, so only the separators are tidied (no case
    /// folding — that would merge distinct IDs).
    fn normalize(&self, entry: &str) -> String {
        chain_ids(entry).join("/")
    }

    fn covered_by(&self, entry: &str, boundary: &[String]) -> bool {
        let required: HashSet<&str> = chain_ids(entry).into_iter().collect();
        if required.is_empty() {
            // An empty chain names nothing, so it is inside nothing — mirrors
            // Dropbox, where the account root is not a verifiable target.
            return boundary.iter().any(|b| chain_ids(b).is_empty());
        }
        boundary
            .iter()
            .any(|b| chain_ids(b).iter().all(|id| required.contains(id)))
    }
}

// ── Request classification (pure) ────────────────────────────────────────

/// Drive file IDs are URL-safe base64-ish. Anything else (dot segments,
/// percent-escapes, empty segments) is refused rather than interpreted.
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The lowerCamel name Google reads a field or parameter under. Google accepts
/// the exact snake_case spelling of every name as an alias (`add_parents` =
/// `addParents`), so a strictly snake_case name is folded. Any other spelling
/// (`addparents`, `add__parents`, `Add_Parents`) is one Google ignores, and is
/// kept as-is so it is ignored here too.
fn canonical_name(name: &str) -> String {
    let words: Vec<&str> = name.split('_').collect();
    let snake = words.len() > 1
        && words.iter().all(|w| {
            !w.is_empty()
                && w.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if !snake {
        return name.to_string();
    }
    let mut out = words[0].to_string();
    for word in &words[1..] {
        let (first, rest) = word.split_at(1);
        out.push_str(&first.to_ascii_uppercase());
        out.push_str(rest);
    }
    out
}

/// The request's query parameters, keyed the way Google reads them (see
/// [`canonical_name`]). `Err` = a parameter whose effect can't be pinned down,
/// which is refused rather than guessed at.
fn params(query: &str) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for (raw, value) in form_urlencoded::parse(query.as_bytes()) {
        // `$`-prefixed system parameters change how Google reads the request
        // (`$httpMethod` the method, `$ct` the body's type), and
        // `upload_protocol` picks another upload protocol than `uploadType`.
        let system = raw.starts_with('$') && !HARMLESS_SYSTEM_PARAMS.contains(&&*raw);
        if system || raw == "upload_protocol" {
            return Err(format!(
                "query parameter not allowed under a folder policy: {raw}"
            ));
        }
        // The resumable session id is spelled only in snake_case.
        let name = if raw == "upload_id" {
            raw.to_string()
        } else {
            canonical_name(&raw)
        };
        if out.insert(name, value.into_owned()).is_some() {
            return Err(format!("repeated query parameter: {raw}"));
        }
    }
    Ok(out)
}

/// Method-override headers. Google executes `X-HTTP-Method-Override` instead
/// of the request line's method (so a "create" POST could run as an unconfined
/// files.list); the others are honored by other front ends and refused alike —
/// no legitimate Drive client sends any of them.
const METHOD_OVERRIDE_HEADERS: &[&str] = &[
    "x-http-method-override",
    "x-http-method",
    "x-method-override",
    "x-goog-http-method-override",
];

/// Refuses every header through which Google would execute or decode something
/// other than what [`classify`] reads. `Some` = deny, with why.
fn refuse_reinterpretation(headers: &hyper::HeaderMap) -> Option<String> {
    if METHOD_OVERRIDE_HEADERS
        .iter()
        .any(|h| headers.contains_key(*h))
    {
        return Some("HTTP method override is not allowed under a folder policy".into());
    }
    if headers
        .keys()
        .any(|k| k.as_str().starts_with("x-goog-upload-"))
    {
        return Some("upload protocol headers are not allowed under a folder policy".into());
    }
    let mut content_types = headers.get_all(hyper::header::CONTENT_TYPE).iter();
    let content_type = content_types.next()?;
    if content_types.next().is_some() {
        return Some("repeated Content-Type header".into());
    }
    // Google merges a form body's fields into the request parameters — an
    // `addParents` could ride in a body never read here — and it detects the
    // form type ANYWHERE in the header, case-insensitively.
    let form = b"application/x-www-form-urlencoded";
    if find_bytes(&content_type.as_bytes().to_ascii_lowercase(), form).is_some() {
        return Some("form-encoded bodies are not allowed under a folder policy".into());
    }
    None
}

/// `addParents=a,b` — each new parent must itself be in scope (a file can't be
/// linked into a folder the agent may not reach). `removeParents` only ever
/// narrows the agent's reach, so it is not checked.
fn add_parents(params: &HashMap<String, String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if let Some(raw) = params.get("addParents") {
        for id in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if !valid_id(id) {
                return Err(format!("invalid addParents id: {id}"));
            }
            out.push(id.to_string());
        }
    }
    Ok(out)
}

/// The scope-relevant fields of a file-metadata body (Google reads its JSON
/// fields under the snake_case alias too). Built only by [`metadata`].
#[derive(Deserialize)]
struct FileMetadata {
    parents: Option<Value>,
    #[serde(rename = "shortcutDetails", alias = "shortcut_details")]
    shortcut_details: Option<ShortcutDetails>,
}

#[derive(Deserialize)]
struct ShortcutDetails {
    #[serde(rename = "targetId", alias = "target_id")]
    target_id: Option<Value>,
}

const UNREADABLE: &str = "cannot read file metadata from request body";

/// Parses a metadata body, refusing a repeated key at any depth — under either
/// spelling — because Google and serde would keep different copies.
fn metadata(raw: &[u8]) -> Result<FileMetadata, String> {
    let UniqueKeys(tree) = serde_json::from_slice(raw).map_err(|_| UNREADABLE.to_string())?;
    if !tree.is_object() {
        return Err(UNREADABLE.into());
    }
    serde_json::from_value(tree).map_err(|_| UNREADABLE.to_string())
}

/// A JSON value whose objects never repeat a key (snake/camel aliases
/// included); anything else fails to deserialize.
struct UniqueKeys(Value);

impl<'de> Deserialize<'de> for UniqueKeys {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueKeys;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without repeated keys")
            }
            fn visit_bool<E>(self, v: bool) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys(v.into()))
            }
            fn visit_i64<E>(self, v: i64) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys(v.into()))
            }
            fn visit_u64<E>(self, v: u64) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys(v.into()))
            }
            fn visit_f64<E>(self, v: f64) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys(v.into()))
            }
            fn visit_str<E>(self, v: &str) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys(v.into()))
            }
            fn visit_unit<E>(self) -> Result<UniqueKeys, E> {
                Ok(UniqueKeys(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<UniqueKeys, A::Error> {
                let mut out = Vec::new();
                while let Some(UniqueKeys(v)) = seq.next_element()? {
                    out.push(v);
                }
                Ok(UniqueKeys(Value::Array(out)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<UniqueKeys, A::Error> {
                let mut out = serde_json::Map::new();
                let mut names = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !names.insert(canonical_name(&key)) {
                        return Err(serde::de::Error::custom(format!("repeated key {key}")));
                    }
                    let UniqueKeys(v) = map.next_value()?;
                    out.insert(key, v);
                }
                Ok(UniqueKeys(Value::Object(out)))
            }
        }
        d.deserialize_any(Visitor)
    }
}

/// `application/json`, optionally `charset=utf-8` — the only declaration under
/// which Google reads the bytes as they are parsed here. A body it would
/// decode by another charset (UTF-7 can smuggle a key inside a string), or not
/// as JSON at all, is refused.
fn is_json_media(content_type: &str) -> bool {
    let mut parts = content_type.split(';');
    parts.next().is_some_and(|m| m.trim() == "application/json")
        && parts.all(|p| {
            p.trim().is_empty()
                || p.split_once('=').is_some_and(|(k, v)| {
                    k.trim().eq_ignore_ascii_case("charset")
                        && v.trim().trim_matches('"').eq_ignore_ascii_case("utf-8")
                })
        })
}

/// The buffered body as Google will read it. Google inflates a compressed body
/// before parsing it, so compressed bytes are not what it sees.
fn readable_body<'a>(
    headers: &hyper::HeaderMap,
    body: Option<&'a [u8]>,
) -> Result<&'a [u8], String> {
    let identity = |v: &hyper::header::HeaderValue| {
        v.to_str()
            .is_ok_and(|s| s.trim().eq_ignore_ascii_case("identity"))
    };
    if !headers
        .get_all(hyper::header::CONTENT_ENCODING)
        .iter()
        .all(identity)
    {
        return Err("compressed request bodies are not allowed under a folder policy".into());
    }
    body.ok_or_else(|| UNREADABLE.to_string())
}

/// A request's JSON metadata body. `None` for an empty body — the method's
/// defaults apply (a create lands in root, a copy beside its source).
fn json_metadata(
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Result<Option<FileMetadata>, String> {
    let raw = readable_body(headers, body)?;
    if raw.is_empty() {
        return Ok(None);
    }
    let content_type = headers
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !is_json_media(content_type) {
        return Err("file metadata must be sent as application/json".into());
    }
    metadata(raw).map(Some)
}

/// Parent IDs a create/copy places the new file in, plus a shortcut's target.
/// `required` = a create with no parents lands in My Drive's root, which is
/// never in scope.
fn body_parents(meta: Option<&FileMetadata>, required: bool) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    match meta.and_then(|m| m.parents.as_ref()) {
        None if required => {
            return Err(
                "new files must be created inside an allowed folder (set `parents`)".into(),
            );
        }
        None => {}
        Some(parents) => {
            let arr = parents
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or("`parents` must be a non-empty list of folder IDs")?;
            for p in arr {
                match p.as_str() {
                    Some(id) if valid_id(id) => out.push(id.to_string()),
                    _ => return Err(format!("invalid parent id: {p}")),
                }
            }
        }
    }
    // A shortcut created in scope must not point outside it either.
    let target = meta
        .and_then(|m| m.shortcut_details.as_ref())
        .and_then(|d| d.target_id.as_ref());
    if let Some(target) = target {
        match target.as_str() {
            Some(id) if valid_id(id) => out.push(id.to_string()),
            _ => return Err("invalid shortcut target".into()),
        }
    }
    Ok(out)
}

/// RFC 2046 boundary characters (bounded, no space), so the delimiter is
/// unambiguous. Anything else is refused rather than guessed at.
fn valid_boundary(b: &str) -> bool {
    (1..=70).contains(&b.len())
        && b.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"'()+_,-./:=?".contains(&c))
}

/// The `boundary` parameter of a multipart Content-Type: exactly one (Google
/// would use the last of several), bare or wholly quoted. Any other quoting is
/// refused — a quoted `;` splits the parameters differently for Google than
/// here, which is how a body's real delimiter could be hidden.
fn multipart_boundary(content_type: &str) -> Option<&str> {
    let mut boundary = None;
    for param in content_type.split(';').skip(1) {
        if param.trim().is_empty() {
            continue;
        }
        let (name, value) = param.split_once('=')?;
        let value = value.trim();
        let value = match value.strip_prefix('"') {
            Some(quoted) => quoted.strip_suffix('"')?,
            None => value,
        };
        if value.contains('"') {
            return None;
        }
        if name.trim().eq_ignore_ascii_case("boundary") && boundary.replace(value).is_some() {
            return None;
        }
    }
    boundary.filter(|b| valid_boundary(b))
}

/// The JSON metadata of a `multipart` upload, read the way Google reads it:
/// the body must OPEN with the first delimiter (Google skips a preamble, which
/// could disguise the real metadata), and its first part must be declared as
/// JSON (Google takes that part as the metadata, whatever follows). Only the
/// buffered prefix is needed — metadata precedes the content.
fn multipart_metadata(
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Result<FileMetadata, String> {
    const MALFORMED: &str = "malformed multipart metadata part";
    const ENCODED: &str = "encoded multipart metadata is not allowed";
    let content_type = headers
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let boundary = multipart_boundary(content_type)
        .ok_or("multipart upload needs exactly one valid boundary")?;
    let delim = format!("--{boundary}");
    let mut rest = readable_body(headers, body)?
        .strip_prefix(delim.as_bytes())
        .and_then(|r| r.strip_prefix(b"\r\n").or_else(|| r.strip_prefix(b"\n")))
        .ok_or("multipart upload must open with its boundary")?;

    let mut part_type = None;
    loop {
        let eol = rest.iter().position(|&b| b == b'\n').ok_or(MALFORMED)?;
        let line = &rest[..eol];
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        rest = &rest[eol + 1..];
        if line.is_empty() {
            break;
        }
        // A folded (continued) header line is read differently by MIME parsers.
        if line.starts_with(b" ") || line.starts_with(b"\t") {
            return Err(MALFORMED.into());
        }
        let line = std::str::from_utf8(line).map_err(|_| MALFORMED)?;
        let (name, value) = line.split_once(':').ok_or(MALFORMED)?;
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-type" if part_type.replace(value).is_some() => {
                return Err("repeated Content-Type in multipart metadata part".into());
            }
            // An encoded part (base64, quoted-printable, gzip) hides the
            // metadata from this parser.
            "content-transfer-encoding"
                if !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "7bit" | "8bit" | "binary"
                ) =>
            {
                return Err(ENCODED.into());
            }
            "content-encoding" => return Err(ENCODED.into()),
            _ => {}
        }
    }
    if !part_type.is_some_and(is_json_media) {
        return Err("a multipart upload must start with its application/json metadata".into());
    }
    // The part runs to the next line starting with the delimiter. A near-miss
    // (`--<boundary>x`) can only end it EARLY: the part must still parse as
    // strict JSON, and no delimiter line can hide inside valid JSON (strings
    // can't hold raw line breaks, and `--` is no JSON token).
    let end = find_bytes(rest, format!("\n{delim}").as_bytes())
        .ok_or("multipart metadata part is not terminated")?;
    let part = &rest[..end];
    metadata(part.strip_suffix(b"\r").unwrap_or(part))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[derive(Debug, PartialEq)]
enum QueryToken {
    /// A single-quoted string; `escaped` = it contained a `\` escape.
    Str {
        value: String,
        escaped: bool,
    },
    Word(String),
    Open,
    Close,
}

/// Tokenizes a Drive search query. Values are single-quoted with `\` escapes —
/// the only string syntax Drive documents, so a `"` is refused rather than
/// given a meaning Google might not share. `None` = unparseable (unterminated
/// string, stray quote, unbalanced parentheses) → deny.
fn tokenize(q: &str) -> Option<Vec<QueryToken>> {
    let mut out = Vec::new();
    let mut chars = q.chars().peekable();
    let mut depth: i32 = 0;
    while let Some(&c) = chars.peek() {
        match c {
            c if c.is_whitespace() => {
                chars.next();
            }
            '(' => {
                chars.next();
                depth += 1;
                out.push(QueryToken::Open);
            }
            ')' => {
                chars.next();
                depth -= 1;
                if depth < 0 {
                    return None;
                }
                out.push(QueryToken::Close);
            }
            '"' => return None,
            '\'' => {
                chars.next();
                let mut value = String::new();
                let mut escaped = false;
                loop {
                    match chars.next()? {
                        '\\' => {
                            escaped = true;
                            value.push(chars.next()?);
                        }
                        '\'' => break,
                        ch => value.push(ch),
                    }
                }
                out.push(QueryToken::Str { value, escaped });
            }
            _ => {
                let mut w = String::new();
                while let Some(&ch) = chars.peek() {
                    if ch.is_whitespace() || matches!(ch, '(' | ')' | '\'' | '"') {
                        break;
                    }
                    w.push(ch);
                    chars.next();
                }
                out.push(QueryToken::Word(w));
            }
        }
    }
    (depth == 0).then_some(out)
}

/// The folder IDs a `files.list` query is confined to: the `'<id>' in parents`
/// terms that are top-level conjuncts. Any top-level `or` defeats confinement
/// (`'A' in parents or trashed = false` reaches everything), so it is refused
/// outright; anything ANDed with a parents term only narrows it further. A
/// Drive ID never needs escaping, so an escaped literal never confines.
fn list_parents(q: &str) -> Result<Vec<String>, String> {
    let tokens = tokenize(q).ok_or_else(|| format!("unparseable search query; {LIST_HINT}"))?;
    let mut conjuncts: Vec<Vec<&QueryToken>> = vec![Vec::new()];
    let mut depth = 0;
    for t in &tokens {
        match t {
            QueryToken::Open => depth += 1,
            QueryToken::Close => depth -= 1,
            QueryToken::Word(w) if depth == 0 && w.eq_ignore_ascii_case("or") => {
                return Err(format!("top-level `or` is not allowed; {LIST_HINT}"));
            }
            QueryToken::Word(w) if depth == 0 && w.eq_ignore_ascii_case("and") => {
                conjuncts.push(Vec::new());
                continue;
            }
            _ => {}
        }
        conjuncts.last_mut().expect("never empty").push(t);
    }
    let ids: Vec<String> = conjuncts
        .iter()
        .filter_map(|c| match c.as_slice() {
            [QueryToken::Str {
                value,
                escaped: false,
            }, QueryToken::Word(op), QueryToken::Word(field)]
                if op == "in" && field == "parents" && valid_id(value) =>
            {
                Some(value.clone())
            }
            _ => None,
        })
        .collect();
    if ids.is_empty() {
        return Err(LIST_HINT.to_string());
    }
    Ok(ids)
}

/// What a request requires: the file IDs that must ALL be in scope (empty =
/// the endpoint touches no file, e.g. account info). `Err` = deny, with why.
#[derive(Debug, PartialEq)]
enum Requirement {
    /// Every ID must be in scope.
    All(Vec<String>),
    /// At least one ID must be in scope (list confinement: ANDed parents terms).
    Any(Vec<String>),
}

fn classify(
    method: &str,
    path_and_query: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Result<Requirement, String> {
    if let Some(reason) = refuse_reinterpretation(headers) {
        return Err(reason);
    }
    let (path, query) = path_and_query
        .split_once('?')
        .unwrap_or((path_and_query, ""));
    let params = params(query)?;
    let not_permitted = || format!("endpoint not permitted under a folder policy: {method} {path}");

    let (upload, rest) = if let Some(r) = path.strip_prefix("/upload/drive/v3/") {
        (true, r)
    } else if let Some(r) = path.strip_prefix("/drive/v3/") {
        (false, r)
    } else {
        // Drive v2, /batch/drive, and anything else on the provider's prefixes.
        return Err(not_permitted());
    };
    let segs: Vec<&str> = rest.split('/').collect();
    if segs.iter().any(|s| !valid_id(s)) {
        return Err(not_permitted());
    }

    let upload_type = params.get("uploadType").map(String::as_str);
    let resumable_continuation =
        method == "PUT" && upload_type == Some("resumable") && params.contains_key("upload_id");
    if params.contains_key("upload_id") && !resumable_continuation {
        return Err(not_permitted());
    }

    // `addParents` links a file into more folders, each of which must be in
    // scope — checked on every method, not only the update that documents it.
    let added = add_parents(&params)?;
    let ids = |mut required: Vec<String>| {
        required.extend(added.iter().cloned());
        Ok(Requirement::All(required))
    };

    match (upload, method, segs.as_slice()) {
        (false, "GET", ["about"]) | (false, "GET", ["files", "generateIds"]) => ids(Vec::new()),
        // A listing touches no single file, so it has nothing to attach an
        // `addParents` to; one that carries it anyway is refused below.
        (false, "GET", ["files"]) if added.is_empty() => match params.get("q") {
            Some(q) => Ok(Requirement::Any(list_parents(q)?)),
            None => Err(LIST_HINT.to_string()),
        },
        (false, "POST", ["files"]) => ids(body_parents(json_metadata(headers, body)?.as_ref(), true)?),
        // Continuing a resumable session: the session was opened by an
        // already-verified initial request, so its upload_id can't widen scope.
        (true, "PUT", ["files"]) if resumable_continuation => ids(Vec::new()),
        (true, "POST", ["files"]) => match upload_type {
            Some("multipart") => ids(body_parents(Some(&multipart_metadata(headers, body)?), true)?),
            Some("resumable") => ids(body_parents(json_metadata(headers, body)?.as_ref(), true)?),
            // `media` uploads carry no metadata → the file lands in root.
            _ => Err("simple (media) uploads land in My Drive's root; use uploadType=multipart or resumable with `parents`".into()),
        },
        (_, _, ["files", "trash"]) => Err(not_permitted()),
        (true, "PATCH", ["files", id]) => ids(vec![id.to_string()]),
        (true, "PUT", ["files", id]) if resumable_continuation => ids(vec![id.to_string()]),
        (false, "GET" | "DELETE", ["files", id]) => ids(vec![id.to_string()]),
        (false, "PATCH", ["files", id]) => {
            // v3 makes `parents` read-only on update (moves go through
            // addParents); refuse a body that tries anyway rather than trust it.
            if json_metadata(headers, body)?.is_some_and(|m| m.parents.is_some()) {
                return Err("set parents via addParents, not the request body".into());
            }
            ids(vec![id.to_string()])
        }
        (false, "POST", ["files", id, "copy"]) => {
            let mut required = vec![id.to_string()];
            required.extend(body_parents(json_metadata(headers, body)?.as_ref(), false)?);
            ids(required)
        }
        (false, "GET", ["files", id, "export"]) | (false, "POST", ["files", id, "download"]) => {
            ids(vec![id.to_string()])
        }
        (false, _, ["files", id, "permissions" | "revisions" | "comments", rest @ ..])
            if rest.len() <= 3 =>
        {
            ids(vec![id.to_string()])
        }
        _ => Err(not_permitted()),
    }
}

// ── Ancestry verification (I/O) ──────────────────────────────────────────

/// One file's canonical ID and parent IDs, as the caller's credential sees it.
#[async_trait::async_trait]
pub(super) trait ParentLookup: Sync {
    async fn parents(&self, id: &str) -> Result<(String, Vec<String>), String>;
}

/// Whether `target` sits inside one of `allowed` (see the module docs). Every
/// failure to verify — upstream error, unknown file, too deep — is `false`.
async fn in_scope(lookup: &dyn ParentLookup, target: &str, allowed: &[String]) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = Vec::new();
    // The target itself is always looked up: its canonical ID (not an alias
    // such as `root`) is what joins the ancestor set.
    let Ok((canonical, parents)) = lookup.parents(target).await else {
        return false;
    };
    seen.insert(canonical);
    for p in parents {
        if seen.insert(p.clone()) {
            queue.push(p);
        }
    }
    let mut lookups = 1;
    // Ancestors join the set as soon as they're NAMED by a child, before they
    // are fetched — so a chain headed by a shared drive is satisfied without
    // ever fetching the drive itself.
    while !satisfied(&seen, allowed) {
        let Some(node) = queue.pop() else {
            return false;
        };
        if lookups >= MAX_LOOKUPS {
            return false;
        }
        lookups += 1;
        let Ok((_, parents)) = lookup.parents(&node).await else {
            return false;
        };
        for p in parents {
            if seen.insert(p.clone()) {
                queue.push(p);
            }
        }
    }
    true
}

type CacheKey = (String, String);
type CacheEntry = (Instant, String, Vec<String>);

fn parent_cache() -> &'static Mutex<HashMap<CacheKey, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Never follows a redirect, and never waits long: every lookup carries the
/// agent's credential, which must only ever reach the Drive API itself. Built
/// with `expect` like the gateway's upstream client — a silent
/// `Client::default()` fallback would follow redirects with no timeout.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("build Drive lookup client")
    })
}

/// Looks parents up on the Drive API with the request's own (injected)
/// credential, so visibility is exactly the agent's. Cached per credential —
/// never shared across tokens, since what a file's parents are can differ by
/// who is asking.
struct DriveApiLookup {
    authorization: String,
    fingerprint: String,
    /// Always the production Drive API; overridable only in tests.
    base: String,
}

impl DriveApiLookup {
    fn new(authorization: &str) -> Self {
        let digest = ring::digest::digest(&ring::digest::SHA256, authorization.as_bytes());
        let fingerprint = digest.as_ref()[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Self {
            authorization: authorization.to_string(),
            fingerprint,
            base: DRIVE_API.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl ParentLookup for DriveApiLookup {
    async fn parents(&self, id: &str) -> Result<(String, Vec<String>), String> {
        if !valid_id(id) {
            return Err("invalid id".into());
        }
        let key = (
            format!("{}|{}", self.base, self.fingerprint),
            id.to_string(),
        );
        if let Ok(cache) = parent_cache().lock() {
            if let Some((at, canonical, parents)) = cache.get(&key) {
                if at.elapsed() < PARENT_CACHE_TTL {
                    return Ok((canonical.clone(), parents.clone()));
                }
            }
        }
        let resp = http_client()
            .get(format!("{}/files/{id}", self.base))
            .query(&[("fields", "id,parents"), ("supportsAllDrives", "true")])
            .header(hyper::header::AUTHORIZATION, &self.authorization)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("drive metadata lookup failed: {}", resp.status()));
        }
        let json: Value = resp.json().await.map_err(|e| e.to_string())?;
        let canonical = json
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| valid_id(s))
            .ok_or("drive metadata without id")?
            .to_string();
        let parents: Vec<String> = json
            .get("parents")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| valid_id(s))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(mut cache) = parent_cache().lock() {
            if cache.len() >= PARENT_CACHE_MAX {
                cache.clear();
            }
            cache.insert(key, (Instant::now(), canonical.clone(), parents.clone()));
        }
        Ok((canonical, parents))
    }
}

/// Classify, then verify every required file. `Some(reason)` = block.
async fn enforce(
    lookup: &dyn ParentLookup,
    allowed: &[String],
    method: &str,
    path: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Option<String> {
    let requirement = match classify(method, path, headers, body) {
        Ok(r) => r,
        Err(reason) => return Some(reason),
    };
    match requirement {
        Requirement::All(ids) => {
            for id in ids {
                if !in_scope(lookup, &id, allowed).await {
                    return Some(format!("file or folder outside allowed folders: {id}"));
                }
            }
            None
        }
        Requirement::Any(ids) => {
            for id in &ids {
                if in_scope(lookup, id, allowed).await {
                    return None;
                }
            }
            Some(format!(
                "listing outside allowed folders: {}",
                ids.join(", ")
            ))
        }
    }
}

#[async_trait::async_trait]
impl RequestGuard for GoogleDrive {
    fn rule_name(&self) -> &'static str {
        "Google Drive folder policy"
    }

    fn hint(&self) -> Option<&'static str> {
        Some(HINT)
    }

    fn needs_body(&self, _host: &str, method: &str, path: &str) -> bool {
        // Create/copy/upload-init carry the destination in the body (POST);
        // a metadata PATCH is read to refuse a smuggled `parents`. Content
        // PUT/PATCH uploads are never read, so they are never buffered.
        method == "POST" || (method == "PATCH" && path.starts_with("/drive/v3/"))
    }

    async fn check(
        &self,
        allowed: &[String],
        _host: &str,
        method: &str,
        path: &str,
        headers: &hyper::HeaderMap,
        body: Option<&[u8]>,
    ) -> Option<String> {
        // The walk must see exactly what the agent's credential sees. No
        // injected credential → nothing to verify with → deny.
        let Some(auth) = headers
            .get(hyper::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
        else {
            // Still name the precise refusal when the request shape alone
            // decides it: that is what the agent needs to self-correct.
            return Some(
                classify(method, path, headers, body)
                    .err()
                    .unwrap_or_else(|| "no credential available to verify folder scope".into()),
            );
        };
        enforce(
            &DriveApiLookup::new(auth),
            allowed,
            method,
            path,
            headers,
            body,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake Drive: id → parents. `root` resolves to the real root id.
    ///
    ///   ROOT ─ Clients ─ Acme ─ report
    ///        └ Finance ─ secret
    ///   SD (shared drive) ─ Team ─ plan
    ///   multi: parents [Acme, Finance]
    struct FakeDrive(HashMap<&'static str, Vec<&'static str>>);

    fn drive() -> FakeDrive {
        FakeDrive(HashMap::from([
            ("ROOT", vec![]),
            ("Clients", vec!["ROOT"]),
            ("Acme", vec!["Clients"]),
            ("report", vec!["Acme"]),
            ("Finance", vec!["ROOT"]),
            ("secret", vec!["Finance"]),
            ("Team", vec!["SD"]),
            ("plan", vec!["Team"]),
            ("multi", vec!["Acme", "Finance"]),
            ("loop1", vec!["loop2"]),
            ("loop2", vec!["loop1"]),
        ]))
    }

    #[async_trait::async_trait]
    impl ParentLookup for FakeDrive {
        async fn parents(&self, id: &str) -> Result<(String, Vec<String>), String> {
            let id = if id == "root" { "ROOT" } else { id };
            self.0
                .get(id)
                .map(|p| (id.to_string(), p.iter().map(|s| s.to_string()).collect()))
                .ok_or_else(|| "404".to_string())
        }
    }

    fn allowed() -> Vec<String> {
        vec!["Clients/Acme".to_string(), "SD".to_string()]
    }

    /// Headers of a well-formed JSON metadata request.
    fn json_headers() -> hyper::HeaderMap {
        headers(&[("content-type", "application/json")])
    }

    fn headers(pairs: &[(&'static str, &str)]) -> hyper::HeaderMap {
        let mut h = hyper::HeaderMap::new();
        for (name, value) in pairs {
            h.append(*name, value.parse().unwrap());
        }
        h
    }

    async fn blocked_with(
        method: &str,
        path: &str,
        headers: &hyper::HeaderMap,
        body: Option<&[u8]>,
    ) -> bool {
        enforce(&drive(), &allowed(), method, path, headers, body)
            .await
            .is_some()
    }

    /// Whether a request with a JSON body (when it has one) is BLOCKED.
    async fn blocked(method: &str, path: &str, body: Option<&[u8]>) -> bool {
        blocked_with(method, path, &json_headers(), body).await
    }

    #[tokio::test]
    async fn ancestry_decides_scope() {
        let d = drive();
        let a = allowed();
        assert!(in_scope(&d, "Acme", &a).await);
        assert!(in_scope(&d, "report", &a).await);
        assert!(
            in_scope(&d, "plan", &a).await,
            "shared-drive chain, drive never fetched"
        );
        assert!(
            !in_scope(&d, "Clients", &a).await,
            "an ancestor is not inside its child"
        );
        assert!(!in_scope(&d, "secret", &a).await);
        assert!(!in_scope(&d, "root", &a).await);
        assert!(!in_scope(&d, "missing", &a).await, "unverifiable → out");
        assert!(!in_scope(&d, "loop1", &a).await, "cycles terminate");
        // A file genuinely inside an allowed folder stays reachable even if it
        // is also linked elsewhere.
        assert!(in_scope(&d, "multi", &a).await);
    }

    #[tokio::test]
    async fn the_whole_chain_must_hold_live() {
        // Entry Clients/Acme, but Acme has since been moved under Finance: the
        // live walk no longer finds Clients, so the (org) boundary still holds.
        let moved = FakeDrive(HashMap::from([
            ("Acme", vec!["Finance"]),
            ("Finance", vec!["ROOT"]),
            ("ROOT", vec![]),
            ("doc", vec!["Acme"]),
        ]));
        assert!(!in_scope(&moved, "doc", &["Clients/Acme".to_string()]).await);
        assert!(in_scope(&moved, "doc", &["Acme".to_string()]).await);
    }

    #[tokio::test]
    async fn file_endpoints_follow_the_path_id() {
        assert!(!blocked("GET", "/drive/v3/files/report?alt=media", None).await);
        assert!(
            !blocked(
                "GET",
                "/drive/v3/files/report/export?mimeType=text/plain",
                None
            )
            .await
        );
        assert!(blocked("GET", "/drive/v3/files/secret?alt=media", None).await);
        assert!(blocked("DELETE", "/drive/v3/files/secret", None).await);
        assert!(!blocked("DELETE", "/drive/v3/files/report", None).await);
        assert!(!blocked("POST", "/drive/v3/files/report/permissions", Some(b"{}")).await);
        assert!(blocked("POST", "/drive/v3/files/secret/permissions", Some(b"{}")).await);
        assert!(!blocked("GET", "/drive/v3/files/report/comments/c1/replies/r1", None).await);
        assert!(blocked("GET", "/drive/v3/files/root", None).await);
    }

    #[tokio::test]
    async fn listing_must_be_confined_to_an_allowed_folder() {
        let list = |q: &str| {
            format!(
                "/drive/v3/files?q={}&fields=files(id,name)",
                form_urlencoded::byte_serialize(q.as_bytes()).collect::<String>()
            )
        };
        assert!(!blocked("GET", &list("'Acme' in parents"), None).await);
        assert!(
            !blocked(
                "GET",
                &list("'Acme' in parents and name contains 'q' and trashed = false"),
                None
            )
            .await
        );
        assert!(
            !blocked(
                "GET",
                &list("mimeType != 'x' and ('a' or 'b') and 'Team' in parents"),
                None
            )
            .await
        );
        // Unconfined, out of scope, or escaping via `or` / `not`.
        assert!(blocked("GET", "/drive/v3/files", None).await);
        assert!(blocked("GET", &list("name contains 'secret'"), None).await);
        assert!(blocked("GET", &list("'Finance' in parents"), None).await);
        assert!(blocked("GET", &list("'Acme' in parents or trashed = false"), None).await);
        assert!(
            blocked(
                "GET",
                &list("'Acme' in parents OR 'Finance' in parents"),
                None
            )
            .await
        );
        assert!(blocked("GET", &list("not 'Finance' in parents"), None).await);
        assert!(blocked("GET", &list("('Acme' in parents or trashed = false)"), None).await);
        assert!(
            blocked("GET", &list("'Acme\\' in parents"), None).await,
            "unterminated"
        );
        assert!(
            blocked("GET", &list("'Acme' in parents)"), None).await,
            "unbalanced"
        );
        // Two q params: ambiguous which one upstream honors → deny.
        assert!(
            blocked(
                "GET",
                "/drive/v3/files?q=%27Acme%27+in+parents&q=trashed%3Dfalse",
                None
            )
            .await
        );
    }

    #[tokio::test]
    async fn creates_need_in_scope_parents() {
        assert!(
            !blocked(
                "POST",
                "/drive/v3/files",
                Some(br#"{"name":"x","parents":["Acme"]}"#)
            )
            .await
        );
        assert!(
            blocked("POST", "/drive/v3/files", Some(br#"{"name":"x"}"#)).await,
            "root"
        );
        assert!(
            blocked(
                "POST",
                "/drive/v3/files",
                Some(br#"{"parents":["Finance"]}"#)
            )
            .await
        );
        assert!(blocked("POST", "/drive/v3/files", Some(br#"{"parents":[]}"#)).await);
        assert!(blocked("POST", "/drive/v3/files", None).await);
        // A shortcut placed in scope may not point outside it.
        assert!(
            blocked(
                "POST",
                "/drive/v3/files",
                Some(br#"{"parents":["Acme"],"shortcutDetails":{"targetId":"secret"}}"#)
            )
            .await
        );
    }

    #[tokio::test]
    async fn uploads() {
        let h = headers(&[("content-type", "multipart/related; boundary=XYZ")]);
        let body = |parent: &str| {
            format!(
                "--XYZ\r\nContent-Type: application/json\r\n\r\n{{\"name\":\"a\",\"parents\":[\"{parent}\"]}}\r\n--XYZ\r\nContent-Type: text/plain\r\n\r\nhello\r\n--XYZ--"
            )
        };
        let up = "/upload/drive/v3/files?uploadType=multipart";
        let ok = body("Acme");
        let bad = body("Finance");
        assert!(!blocked_with("POST", up, &h, Some(ok.as_bytes())).await);
        assert!(blocked_with("POST", up, &h, Some(bad.as_bytes())).await);
        // No boundary → can't read metadata → deny.
        assert!(blocked("POST", up, Some(ok.as_bytes())).await);
        // Media uploads land in root.
        assert!(
            blocked(
                "POST",
                "/upload/drive/v3/files?uploadType=media",
                Some(b"x")
            )
            .await
        );
        // Resumable: the initiating request is checked, the continuation isn't.
        let init = "/upload/drive/v3/files?uploadType=resumable";
        assert!(!blocked("POST", init, Some(br#"{"parents":["Team"]}"#)).await);
        assert!(blocked("POST", init, Some(b"")).await);
        assert!(
            !blocked(
                "PUT",
                "/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
                None
            )
            .await
        );
        // upload_id can't be smuggled onto a non-continuation request.
        assert!(
            blocked_with(
                "POST",
                "/upload/drive/v3/files?uploadType=multipart&upload_id=abc",
                &h,
                Some(ok.as_bytes())
            )
            .await
        );
        // Content update of an existing file.
        assert!(
            !blocked(
                "PATCH",
                "/upload/drive/v3/files/report?uploadType=media",
                None
            )
            .await
        );
        assert!(
            blocked(
                "PATCH",
                "/upload/drive/v3/files/secret?uploadType=media",
                None
            )
            .await
        );
    }

    /// A multipart upload is read the way Google's upload front end reads it
    /// (each rule observed live), so its metadata can't be disguised.
    #[tokio::test]
    async fn multipart_metadata_is_read_like_google() {
        async fn send(content_type: &str, body: &str) -> bool {
            let h = headers(&[("content-type", content_type)]);
            let up = "/upload/drive/v3/files?uploadType=multipart";
            blocked_with("POST", up, &h, Some(body.as_bytes())).await
        }
        let related = "multipart/related; boundary=B";
        let meta = |parent: &str, part_headers: &str| {
            format!(
                "--B\r\n{part_headers}\r\n\r\n{{\"parents\":[\"{parent}\"]}}\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B--\r\n"
            )
        };

        // Accepted spellings: LF-only lines, quoted boundary, UTF-8 charset,
        // an explicit identity transfer encoding.
        assert!(!send(related, &meta("Acme", "Content-Type: application/json")).await);
        assert!(
            !send(
                "multipart/related; boundary=B",
                "--B\nContent-Type: application/json\n\n{\"parents\":[\"Acme\"]}\n--B--\n"
            )
            .await
        );
        assert!(
            !send(
                "multipart/related; boundary=\"B\"",
                &meta("Acme", "Content-Type: application/json")
            )
            .await
        );
        assert!(
            !send(
                related,
                &meta(
                    "Acme",
                    "Content-Type: application/json; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit"
                )
            )
            .await
        );

        // Google uses the LAST of several boundaries; a quoted `;` splits the
        // parameters differently than a naive parser would.
        let hidden =
            "--Z\r\nContent-Type: application/json\r\n\r\n{\"parents\":[\"Acme\"]}\r\n--Z--\r\n";
        assert!(send("multipart/related; boundary=Z; boundary=B", hidden).await);
        assert!(send("multipart/related; x=\"a;boundary=B\"; boundary=Z", hidden).await);
        // A preamble is skipped by Google, so the real first part could hide.
        assert!(
            send(
                related,
                &format!("junk\r\n{}", meta("Acme", "Content-Type: application/json"))
            )
            .await
        );
        assert!(
            send(
                related,
                "junk--B\r\nContent-Type: image/png\r\n\r\nx\r\n--B\r\nContent-Type: application/json\r\n\r\n{\"parents\":[\"Acme\"]}\r\n--B--\r\n"
            )
            .await
        );
        // The first part must be the JSON metadata Google takes it to be.
        assert!(send(related, &meta("Acme", "Content-Type: text/plain")).await);
        assert!(send(related, &meta("Acme", "")).await);
        assert!(
            send(
                related,
                &meta(
                    "Acme",
                    "Content-Type: application/json\r\nContent-Type: text/plain"
                )
            )
            .await
        );
        assert!(
            send(
                related,
                "--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B\r\nContent-Type: application/json\r\n\r\n{\"parents\":[\"Acme\"]}\r\n--B--\r\n"
            )
            .await
        );
        // Encoded or folded part headers would hide the metadata.
        for part_headers in [
            "Content-Type: application/json\r\nContent-Transfer-Encoding: base64",
            "Content-Type: application/json\r\nContent-Encoding: gzip",
            "Content-Type:\r\n application/json",
        ] {
            assert!(
                send(related, &meta("Acme", part_headers)).await,
                "{part_headers}"
            );
        }
        // Repeated keys in the metadata are ambiguous.
        assert!(
            send(
                related,
                "--B\r\nContent-Type: application/json\r\n\r\n{\"parents\":[\"Finance\"],\"parents\":[\"Acme\"]}\r\n--B--\r\n"
            )
            .await
        );
    }

    #[tokio::test]
    async fn moves_and_copies_stay_in_scope() {
        assert!(
            !blocked(
                "PATCH",
                "/drive/v3/files/report?addParents=Team&removeParents=Acme",
                Some(b"{}")
            )
            .await
        );
        assert!(
            blocked(
                "PATCH",
                "/drive/v3/files/report?addParents=Finance",
                Some(b"{}")
            )
            .await
        );
        assert!(
            blocked(
                "PATCH",
                "/drive/v3/files/report?addParents=Team,Finance",
                Some(b"")
            )
            .await
        );
        assert!(
            blocked(
                "PATCH",
                "/drive/v3/files/report",
                Some(br#"{"parents":["Finance"]}"#)
            )
            .await
        );
        assert!(!blocked("POST", "/drive/v3/files/report/copy", Some(b"{}")).await);
        assert!(
            !blocked(
                "POST",
                "/drive/v3/files/report/copy",
                Some(br#"{"parents":["Team"]}"#)
            )
            .await
        );
        assert!(
            blocked(
                "POST",
                "/drive/v3/files/report/copy",
                Some(br#"{"parents":["Finance"]}"#)
            )
            .await
        );
        assert!(blocked("POST", "/drive/v3/files/secret/copy", Some(b"{}")).await);
    }

    #[tokio::test]
    async fn unrecognised_surfaces_are_denied() {
        for (m, p) in [
            ("GET", "/drive/v3/changes?pageToken=1"),
            ("GET", "/drive/v3/changes/startPageToken"),
            ("GET", "/drive/v3/drives"),
            ("POST", "/batch/drive/v3"),
            ("GET", "/drive/v2/files"),
            ("DELETE", "/drive/v3/files/trash"),
            ("POST", "/drive/v3/files/report/watch"),
            ("GET", "/drive/v3/files/../../gmail/v1/users/me"),
            ("GET", "/drive/v3/files/%2e%2e"),
            ("GET", "/drive/v3/files/"),
        ] {
            assert!(blocked(m, p, Some(b"{}")).await, "{m} {p} must be denied");
        }
        // Pathless account endpoints are fine.
        assert!(!blocked("GET", "/drive/v3/about?fields=user", None).await);
        assert!(!blocked("GET", "/drive/v3/files/generateIds?count=2", None).await);
    }

    /// Every channel through which Google would read a different request than
    /// the one classified — each observed against the live API — is refused,
    /// even on a request that would otherwise be in scope.
    #[tokio::test]
    async fn requests_google_would_read_differently_are_refused() {
        let create = Some(br#"{"parents":["Acme"]}"#.as_slice());
        assert!(
            !blocked("POST", "/drive/v3/files", create).await,
            "baseline"
        );
        // Method override: every header spelling, and the `$httpMethod`
        // system parameter.
        for header in METHOD_OVERRIDE_HEADERS {
            let overridden = headers(&[("content-type", "application/json"), (header, "GET")]);
            assert!(
                blocked_with("POST", "/drive/v3/files", &overridden, create).await,
                "{header}"
            );
        }
        for path in [
            "/drive/v3/files?%24httpMethod=GET",
            "/drive/v3/files?$httpMethod=GET",
            "/drive/v3/files?$ct=application/x-www-form-urlencoded",
            "/upload/drive/v3/files?uploadType=resumable&upload_protocol=raw",
        ] {
            assert!(blocked("POST", path, create).await, "{path}");
        }
        // Form bodies are merged into the parameters, wherever Google spots
        // the form type in the header.
        for ct in [
            "application/x-www-form-urlencoded",
            "Application/X-WWW-Form-Urlencoded; charset=utf-8",
            "application/json; x=application/x-www-form-urlencoded",
            "text/plain;application/x-www-form-urlencoded",
        ] {
            let h = headers(&[("content-type", ct)]);
            assert!(
                blocked_with(
                    "PATCH",
                    "/drive/v3/files/report",
                    &h,
                    Some(b"addParents=Finance")
                )
                .await,
                "{ct}"
            );
        }
        // Upload-protocol headers, a repeated Content-Type, compressed bodies.
        let upload = headers(&[
            ("content-type", "application/json"),
            ("x-goog-upload-protocol", "raw"),
        ]);
        let init = "/upload/drive/v3/files?uploadType=resumable";
        assert!(blocked_with("POST", init, &upload, create).await);
        let two_types = headers(&[
            ("content-type", "application/json"),
            ("content-type", "text/plain"),
        ]);
        assert!(blocked_with("POST", "/drive/v3/files", &two_types, create).await);
        let gzip = headers(&[
            ("content-type", "application/json"),
            ("content-encoding", "gzip"),
        ]);
        assert!(blocked_with("POST", "/drive/v3/files", &gzip, create).await);
        // Metadata not declared as UTF-8 JSON is not what Google parses.
        for ct in [
            "text/plain",
            "application/json; charset=utf-7",
            "application/jsonx",
        ] {
            let h = headers(&[("content-type", ct)]);
            assert!(
                blocked_with("POST", "/drive/v3/files", &h, create).await,
                "{ct}"
            );
        }
        let utf8 = headers(&[("content-type", "application/json; charset=UTF-8")]);
        assert!(!blocked_with("POST", "/drive/v3/files", &utf8, create).await);
        // The error-format system parameter changes nothing and stays allowed.
        assert!(!blocked("GET", "/drive/v3/about?%24.xgafv=2", None).await);
    }

    /// Google reads every parameter and JSON field under its exact snake_case
    /// spelling too, and keeps the FIRST of repeated ones (serde the last).
    #[tokio::test]
    async fn alias_spellings_and_repeats_are_read_like_google() {
        // A move into an out-of-scope folder, however it is spelled.
        assert!(
            blocked(
                "PATCH",
                "/drive/v3/files/report?add_parents=Finance",
                Some(b"")
            )
            .await
        );
        // Spellings Google ignores are ignored here too (the move is a no-op).
        assert!(
            !blocked(
                "PATCH",
                "/drive/v3/files/report?add__parents=Finance",
                Some(b"")
            )
            .await
        );
        assert!(
            !blocked(
                "PATCH",
                "/drive/v3/files/report?Add_Parents=Finance",
                Some(b"")
            )
            .await
        );
        // Repeats — under one spelling or both — are ambiguous: refused.
        for path in [
            "/drive/v3/files/report?addParents=Team&addParents=Finance",
            "/drive/v3/files/report?addParents=Team&add_parents=Finance",
            "/upload/drive/v3/files?uploadType=multipart&upload_type=media",
        ] {
            assert!(blocked("PATCH", path, Some(b"")).await, "{path}");
        }
        // `addParents` is honored on every method, not only update.
        assert!(blocked("GET", "/drive/v3/files/report?addParents=Finance", None).await);
        assert!(
            blocked(
                "GET",
                "/drive/v3/files?q=%27Acme%27+in+parents&addParents=Finance",
                None
            )
            .await
        );
        // JSON metadata: snake_case fields count, repeated keys are refused.
        for body in [
            br#"{"parents":["Acme"],"shortcut_details":{"target_id":"secret"}}"#.as_slice(),
            br#"{"parents":["Finance"],"parents":["Acme"]}"#,
            br#"{"parents":["Acme"],"shortcutDetails":{"targetId":"report","target_id":"secret"}}"#,
        ] {
            assert!(
                blocked("POST", "/drive/v3/files", Some(body)).await,
                "{}",
                String::from_utf8_lossy(body)
            );
        }
    }

    #[test]
    fn coverage_is_chain_containment() {
        let gd = GoogleDrive;
        assert!(gd.covered_by("A/B", &["A".to_string()]));
        assert!(gd.covered_by("A", &["A".to_string()]));
        assert!(gd.covered_by("A/B/", &["A/".to_string()]));
        assert!(!gd.covered_by("A", &["A/B".to_string()]));
        assert!(!gd.covered_by("AB", &["A".to_string()]));
        // IDs are case-sensitive.
        assert!(!gd.covered_by("a", &["A".to_string()]));
        assert_eq!(
            gd.intersect(&["A".to_string()], &["A/B".to_string(), "C".to_string()]),
            vec!["A/B".to_string()]
        );
        assert_eq!(
            gd.intersect(&["A/B".to_string()], &["A".to_string()]),
            vec!["A/B".to_string()]
        );
        assert!(gd
            .intersect(&["A".to_string()], &["C".to_string()])
            .is_empty());
    }

    #[test]
    fn needs_body_only_for_metadata_bearing_methods() {
        let gd = GoogleDrive;
        let host = "www.googleapis.com";
        assert!(gd.needs_body(host, "POST", "/upload/drive/v3/files"));
        assert!(gd.needs_body(host, "PATCH", "/drive/v3/files/x"));
        assert!(!gd.needs_body(host, "PATCH", "/upload/drive/v3/files/x"));
        assert!(!gd.needs_body(host, "PUT", "/upload/drive/v3/files"));
        assert!(!gd.needs_body(host, "GET", "/drive/v3/files"));
    }

    #[test]
    fn only_exact_snake_case_folds_to_camel_case() {
        assert_eq!(canonical_name("add_parents"), "addParents");
        assert_eq!(
            canonical_name("keep_revision_forever"),
            "keepRevisionForever"
        );
        assert_eq!(canonical_name("addParents"), "addParents");
        for ignored in ["add__parents", "_alt", "alt_", "Add_Parents", "add_Parents"] {
            assert_eq!(canonical_name(ignored), ignored);
        }
    }

    #[test]
    fn list_queries_use_drive_string_syntax_only() {
        assert_eq!(
            list_parents("'Acme' in parents"),
            Ok(vec!["Acme".to_string()])
        );
        // Drive strings are single-quoted; a double-quoted one is refused
        // rather than given a meaning Google might not share.
        assert!(list_parents("\"Acme\" in parents").is_err());
        assert!(list_parents("'Acme' in parents and name = \"x\"").is_err());
        // An ID never needs escaping, so an escaped literal never confines.
        assert!(list_parents("'Ac\\me' in parents").is_err());
        // Escapes elsewhere are fine.
        assert!(list_parents("'Acme' in parents and name = 'it\\'s'").is_ok());
    }

    /// The REAL lookup over HTTP against a local Drive-shaped server: the
    /// request it sends (path, fields, supportsAllDrives, the agent's own
    /// Authorization), how it reads the response, caching, and failure modes.
    mod live_lookup {
        use super::super::*;
        use axum::extract::{Path, Query, State};
        use axum::http::{HeaderMap as AxHeaders, StatusCode};
        use axum::routing::get;
        use axum::{Json, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        #[derive(Clone)]
        struct Srv {
            hits: Arc<AtomicUsize>,
        }

        async fn file(
            State(s): State<Srv>,
            Path(id): Path<String>,
            Query(q): Query<HashMap<String, String>>,
            h: AxHeaders,
        ) -> Result<Json<Value>, StatusCode> {
            s.hits.fetch_add(1, Ordering::SeqCst);
            if h.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer agent-tok") {
                return Err(StatusCode::UNAUTHORIZED);
            }
            if q.get("fields").map(String::as_str) != Some("id,parents")
                || q.get("supportsAllDrives").map(String::as_str) != Some("true")
            {
                return Err(StatusCode::BAD_REQUEST);
            }
            let tree: HashMap<&str, Value> = HashMap::from([
                ("root", serde_json::json!({"id": "ROOTID"})),
                (
                    "Acme",
                    serde_json::json!({"id": "Acme", "parents": ["Clients"]}),
                ),
                (
                    "Clients",
                    serde_json::json!({"id": "Clients", "parents": ["ROOTID"]}),
                ),
                (
                    "report",
                    serde_json::json!({"id": "report", "parents": ["Acme"]}),
                ),
                (
                    "secret",
                    serde_json::json!({"id": "secret", "parents": ["Finance"]}),
                ),
                (
                    "Finance",
                    serde_json::json!({"id": "Finance", "parents": ["ROOTID"]}),
                ),
                (
                    "weird",
                    serde_json::json!({"id": "weird", "parents": ["../x", "Acme"]}),
                ),
                ("noid", serde_json::json!({"parents": ["Acme"]})),
            ]);
            if id == "boom" {
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
            tree.get(id.as_str())
                .cloned()
                .map(Json)
                .ok_or(StatusCode::NOT_FOUND)
        }

        async fn serve() -> (String, Arc<AtomicUsize>) {
            let hits = Arc::new(AtomicUsize::new(0));
            let app = Router::new()
                .route("/drive/v3/files/{id}", get(file))
                .with_state(Srv { hits: hits.clone() });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            (format!("http://{addr}/drive/v3"), hits)
        }

        fn lookup(base: &str, auth: &str) -> DriveApiLookup {
            let mut l = DriveApiLookup::new(auth);
            l.base = base.to_string();
            l
        }

        #[tokio::test]
        async fn real_http_lookup_enforces_scope_end_to_end() {
            let (base, hits) = serve().await;
            let l = lookup(&base, "Bearer agent-tok");
            let allowed = vec!["Clients/Acme".to_string()];
            let h = super::json_headers();
            // In scope: read, export, and a create into the folder.
            assert!(enforce(
                &l,
                &allowed,
                "GET",
                "/drive/v3/files/report?alt=media",
                &h,
                None
            )
            .await
            .is_none());
            assert!(enforce(
                &l,
                &allowed,
                "POST",
                "/drive/v3/files",
                &h,
                Some(br#"{"parents":["Acme"]}"#)
            )
            .await
            .is_none());
            assert!(enforce(
                &l,
                &allowed,
                "GET",
                "/drive/v3/files?q=%27Acme%27+in+parents",
                &h,
                None
            )
            .await
            .is_none());
            // Out of scope, root alias, unknown, upstream error, missing id.
            for p in ["secret", "root", "missing", "boom", "noid"] {
                let path = format!("/drive/v3/files/{p}");
                assert!(
                    enforce(&l, &allowed, "GET", &path, &h, None)
                        .await
                        .is_some(),
                    "{p}"
                );
            }
            // Malformed parent ids from upstream are ignored, not followed.
            assert!(
                enforce(&l, &allowed, "GET", "/drive/v3/files/weird", &h, None)
                    .await
                    .is_none()
            );
            // Cache: repeating an allowed read makes no new upstream calls.
            let before = hits.load(Ordering::SeqCst);
            assert!(
                enforce(&l, &allowed, "GET", "/drive/v3/files/report", &h, None)
                    .await
                    .is_none()
            );
            assert_eq!(hits.load(Ordering::SeqCst), before);
        }

        #[tokio::test]
        async fn lookup_uses_the_agents_token_and_never_shares_cache_across_tokens() {
            let (base, _) = serve().await;
            let allowed = vec!["Clients/Acme".to_string()];
            let h = hyper::HeaderMap::new();
            // Warm the cache with the good token...
            let good = lookup(&base, "Bearer agent-tok");
            assert!(
                enforce(&good, &allowed, "GET", "/drive/v3/files/report", &h, None)
                    .await
                    .is_none()
            );
            // ...a different token (the upstream rejects it) must not ride it.
            let other = lookup(&base, "Bearer someone-else");
            assert!(
                enforce(&other, &allowed, "GET", "/drive/v3/files/report", &h, None)
                    .await
                    .is_some()
            );
        }

        #[tokio::test]
        async fn unreachable_drive_fails_closed() {
            let l = lookup("http://127.0.0.1:1/drive/v3", "Bearer agent-tok");
            assert!(enforce(
                &l,
                &["Acme".to_string()],
                "GET",
                "/drive/v3/files/report",
                &hyper::HeaderMap::new(),
                None
            )
            .await
            .is_some());
        }
    }
}
