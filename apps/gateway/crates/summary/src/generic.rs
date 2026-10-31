//! Fallback summary for requests no app summarizer knows, readable for any
//! app: a title in words from the method and path ("Read draft", "Move
//! message", "Create issue Crash on save"), the endpoint, the records the
//! path names, the query parameters, and the body as labeled rows
//! ([`super::nested`]). A GraphQL call reads as the operation it runs.
//! Never a JSON blob.
//!
//! The title is read from the URL's grammar alone (no app knowledge), so
//! when the path is ambiguous it stays general rather than guess a specific
//! action: a DELETE never reads as another verb, and an unknown word after
//! a record reads as a part of it ("Delete issue lock"), not an action. The
//! Endpoint row retains the path rather than hiding it behind that inference.
//!
//! Secret-named values are masked, base64 blobs and long strings are elided,
//! and every row is bounded. This is key-based redaction, not a guarantee
//! against credentials hidden in arbitrary free text. The request's masked
//! raw view remains available.

use serde_json::{Map, Value};

use super::change::ChangeHint;
use super::graphql::{self, Kind, Read};
use super::nested::{self, Leaf, Leaves, Reading, EMPTY};
use super::redact::{
    is_multipart, is_url_credential, looks_like_base64_blob, mask_secrets, redact_string,
};
use super::{
    clamp, decode_segment, human_size, humanize_key, one_line, parse_json, ApprovalSummary,
    SummaryRequest, BODY_PEEK, MAX_BODY_LEN, MAX_FIELD_ROWS, MAX_SNIPPET_LEN, MAX_VALUE_LEN,
};

/// Verbs a path word may start with (`move`, `create_folder`, `replyAll`) or,
/// after a qualifier, end with (`batchUpdate`, `permanently_delete`): the
/// word names an action, not a resource.
const VERBS: &[&str] = &[
    "accept",
    "approve",
    "archive",
    "assign",
    "attach",
    "cancel",
    "capture",
    "clone",
    "close",
    "complete",
    "confirm",
    "copy",
    "create",
    "decline",
    "delete",
    "deny",
    "describe",
    "detach",
    "disable",
    "dismiss",
    "enable",
    "execute",
    "export",
    "extract",
    "finalize",
    "forward",
    "import",
    "inspect",
    "invite",
    "lock",
    "mark",
    "merge",
    "move",
    "pause",
    "pay",
    "publish",
    "query",
    "read",
    "refund",
    "reject",
    "remove",
    "rename",
    "reopen",
    "reply",
    "resolve",
    "restore",
    "resume",
    "retry",
    "revoke",
    "run",
    "search",
    "send",
    "share",
    "start",
    "stop",
    "submit",
    "sync",
    "transfer",
    "trash",
    "unarchive",
    "unassign",
    "unlock",
    "unpublish",
    "unshare",
    "untrash",
    "update",
    "upload",
    "validate",
    "verify",
    "void",
];

/// Path words that carry no meaning for a title: API prefixes and the
/// grouping word of a batch call (`/services/data/…`, `/contacts/batch/create`).
const NOISE_WORDS: &[&str] = &["api", "rest", "services", "data", "batch"];

/// The signed-in user (`/v1.0/me/…`, `/users/me/drafts`): a record no row
/// needs to show.
const SELF_WORDS: &[&str] = &["me", "self"];

/// Longest query-parameter label: a name is agent-written.
const MAX_LABEL_LEN: usize = 60;
/// Most prose blocks (a template, a message body) a nested card shows.
const MAX_PROSE_ROWS: usize = 3;
/// Settings shown beside text that leads a card (the rest are counted).
const CONTEXT_ROWS: usize = 3;
/// Most fields a form body is read for, and how deep a bracketed key nests.
const MAX_FORM_FIELDS: usize = 400;
const MAX_FORM_DEPTH: usize = 6;

/// Summarize any request in words. See the module docs.
pub(super) fn summarize(req: &SummaryRequest<'_>) -> ApprovalSummary {
    let method = req.method_upper();
    let path = Path::parse(req.base_path());
    let title = title(&method, &path);
    let mut s = ApprovalSummary::new(title.text.clone());
    // One endpoint serves every GraphQL operation: the operation is the card.
    if req
        .body
        .is_some_and(|b| push_graphql(&mut s, req.content_type, b))
    {
        s.fallback = Some(0..0);
        return s;
    }
    s.push("Endpoint", req.base_path());
    let first = s.details.len();
    for (label, id) in path.record_rows() {
        s.push(label, id);
    }
    s.fallback = Some(first..s.details.len());
    push_query(&mut s, req.path);
    let Some(b) = req.body.filter(|b| !b.is_empty()) else {
        return s;
    };
    let form = is_form(req.content_type);
    let parsed = if form {
        form_value(b)
    } else {
        json_body(req.content_type, b).map(|v| (v, true))
    };
    let Some((v, read_whole)) = parsed else {
        s.push("Body", unread_body(req.content_type, b));
        return s;
    };
    // A list reads like any list in a body, under one label.
    let array_wrapper;
    let rows_of = if v.is_array() {
        array_wrapper = serde_json::json!({ "items": &v });
        &array_wrapper
    } else {
        &v
    };
    let mut all = nested::leaves(rows_of, Reading::Request);
    all.complete &= read_whole;
    if all.leaves.is_empty() {
        s.push("Body", EMPTY);
    } else {
        push_leaves(&mut s, &all);
    }
    s.action = title.named(nested::body_name(&v));
    // Only a JSON body reads back in the shape it was sent.
    if !form {
        s.change = ChangeHint::same_path(req.method, req.path, &v);
    }
    s
}

// ── Path ─────────────────────────────────────────────────────────────────────

/// One path segment, read for meaning.
#[derive(Debug)]
enum Segment {
    /// A resource or action word, as written (`calendarView`, `move`).
    Word(String),
    /// A Google-style custom method (`index:inspect`, `AGENT:run`): always
    /// the action.
    Verb(String),
    /// A record the path names (an id, or a name the agent chose), with the
    /// collection word before it (`drafts` for `drafts/{id}`). Shown as a
    /// row, never in the title.
    Key { of: Option<String>, value: String },
    /// A Microsoft Graph item addressed by its path in the drive
    /// (`root:/Folder/File.txt:`).
    ItemPath(String),
}

struct Path(Vec<Segment>);

impl Path {
    fn parse(base: &str) -> Self {
        let raw: Vec<String> = base
            .split('/')
            .filter(|s| !s.is_empty())
            .map(decode_segment)
            .collect();
        let mut path = Self(Vec::new());
        let mut i = 0;
        while i < raw.len() {
            let seg = &raw[i];
            path.push(seg.strip_suffix(':').unwrap_or(seg));
            i += 1;
            // Graph's path addressing: `root:/a/b.txt:/content` switches to
            // the drive's own path space until the closing colon (or the end).
            if seg.len() > 1 && seg.ends_with(':') {
                let start = i;
                while i < raw.len() && !raw[i].ends_with(':') {
                    i += 1;
                }
                let mut parts: Vec<&str> = raw[start..i].iter().map(String::as_str).collect();
                if let Some(last) = raw.get(i) {
                    parts.push(last.trim_end_matches(':'));
                    i += 1;
                }
                if !parts.is_empty() {
                    path.0.push(Segment::ItemPath(parts.join("/")));
                }
            }
        }
        path
    }

    fn push(&mut self, seg: &str) {
        // A Google-style custom method: `index:inspect`, `AGENT:run`.
        let (head, verb) = match seg.rsplit_once(':') {
            Some((h, m)) if !h.is_empty() && is_word(m) => (h, Some(m)),
            _ => (seg, None),
        };
        // Graph's key syntax: `mailFolders('inbox')`.
        let (word, key) = match head.split_once('(') {
            Some((w, k)) if is_word(w) => {
                (w, Some(k.trim_end_matches(')').trim_matches(['\'', '"'])))
            }
            _ => (head, None),
        };
        let word = without_version_suffix(word);
        let collection = match self.0.last() {
            Some(Segment::Word(w)) => Some(w.clone()),
            _ => None,
        };
        let after_collection = collection.as_deref().is_some_and(is_plural);
        // A version-shaped name after a collection is still its record.
        if (!after_collection && is_version(word, self.0.is_empty())) || NOISE_WORDS.contains(&word)
        {
            return;
        }
        // A record named in parts (`repos/{owner}/{name}`): an id right
        // after a record's key is the key's next part. A word never is: from
        // the URL alone `projects/my-app/env` (a part of the record) reads
        // the same as `repos/acme/web` (a name in two words), and a part is
        // the safer reading.
        let continues_key = !is_word(word)
            && key.is_none()
            && verb.is_none()
            && matches!(self.0.last(), Some(Segment::Key { of: Some(_), .. }));
        if continues_key {
            if let Some(Segment::Key { value, .. }) = self.0.last_mut() {
                value.push('/');
                value.push_str(word);
            }
            return;
        }
        if !is_word(word) || (after_collection && !is_plural(word) && !is_action(word)) {
            // An id, or a name after a collection (`projects/my-app`).
            self.0.push(Segment::Key {
                of: collection,
                value: word.to_string(),
            });
        } else if !SELF_WORDS.contains(&word) {
            self.0.push(Segment::Word(word.to_string()));
        }
        if let Some(key) = key.filter(|k| !k.is_empty()) {
            self.0.push(Segment::Key {
                of: Some(word.to_string()),
                value: key.to_string(),
            });
        }
        if let Some(verb) = verb {
            self.0.push(Segment::Verb(verb.to_string()));
        }
    }

    /// The noun of the record segment `i` names, if it names one: "draft"
    /// for `drafts/{id}`, "item" for a Graph item path. `None` for the
    /// signed-in user, and for an id with no collection word before it.
    fn record_noun(&self, i: usize) -> Option<String> {
        match self.0.get(i)? {
            Segment::Key { of: Some(w), value } if !SELF_WORDS.contains(&value.as_str()) => {
                Some(singular(&noun(w)))
            }
            Segment::ItemPath(_) => Some("item".into()),
            _ => None,
        }
    }

    /// The records the path names as rows, labeled by their collection, at
    /// most the last two: the record acted on and its parent. An id with no
    /// collection word before it names nothing a label could say.
    fn record_rows(&self) -> Vec<(String, String)> {
        let mut rows: Vec<(String, String)> = self
            .0
            .iter()
            .filter_map(|seg| match seg {
                Segment::Key { of: Some(w), value } if !SELF_WORDS.contains(&value.as_str()) => {
                    Some((singular(&humanize_key(w)), one_line(value, MAX_VALUE_LEN)))
                }
                Segment::ItemPath(p) => Some(("Path".into(), one_line(p, MAX_VALUE_LEN))),
                _ => None,
            })
            .collect();
        let older = rows.len().saturating_sub(2);
        rows.drain(..older);
        rows
    }
}

// ── Title ────────────────────────────────────────────────────────────────────

/// A card title, and, for one that names the resource a request writes
/// ("Create issue"), where the body's own name for it fits ("Create issue
/// Crash on save", "Create child Notes in item").
struct Title {
    text: String,
    name_at: Option<usize>,
}

impl Title {
    fn plain(text: String) -> Self {
        Self {
            text,
            name_at: None,
        }
    }

    fn resource(head: String, tail: &str) -> Self {
        let name_at = Some(head.len());
        Self {
            text: head + tail,
            name_at,
        }
    }

    fn named(self, name: Option<String>) -> String {
        match (self.name_at, name) {
            (Some(at), Some(name)) => clamp(
                &format!("{} {name}{}", &self.text[..at], &self.text[at..]),
                MAX_VALUE_LEN,
            ),
            _ => self.text,
        }
    }
}

/// The title from the method and the path's last word.
fn title(method: &str, path: &Path) -> Title {
    let segs = &path.0;
    let Some((last, word, custom)) = segs.iter().enumerate().rev().find_map(|(i, s)| match s {
        Segment::Word(w) => Some((i, w.as_str(), false)),
        Segment::Verb(v) => Some((i, v.as_str(), true)),
        _ => None,
    }) else {
        return Title::plain(format!("{method} request"));
    };
    if word.eq_ignore_ascii_case("graphql") {
        return Title::plain("Run GraphQL request".to_string());
    }
    // A record follows the word (`drafts/{id}`): the request is about it.
    let on_record = last + 1 < segs.len();
    let parent_record = last.checked_sub(1).and_then(|p| path.record_noun(p));

    // An action (`messages/{id}/move`, `files/delete_v2`). A DELETE removes
    // what the path names, whatever its last word says (`issues/{n}/lock`).
    if method != "DELETE" && (custom || (!on_record && is_action(word))) {
        let phrase = humanize_key(word);
        let parent_word = match last.checked_sub(1).map(|p| &segs[p]) {
            Some(Segment::Word(w)) => Some(noun(w)),
            _ => None,
        };
        // "Create folder" names its own object; "Move", "Batch update" take
        // the path's.
        let ends_with_verb = phrase
            .rsplit(' ')
            .next()
            .is_some_and(|w| VERBS.contains(&w.to_ascii_lowercase().as_str()));
        return Title::plain(match parent_record.or(parent_word) {
            Some(object) if ends_with_verb => format!("{phrase} {object}"),
            _ => phrase,
        });
    }

    let thing = noun(word);
    let one = singular(&thing);
    if on_record {
        let one = path.record_noun(last + 1).unwrap_or(one);
        return match method {
            "GET" | "HEAD" => Title::plain(format!("Read {one}")),
            "POST" | "PUT" | "PATCH" => Title::resource(format!("Update {one}"), ""),
            "DELETE" => Title::resource(format!("Delete {one}"), ""),
            other => Title::plain(format!("{other} {one}")),
        };
    }
    if let Some(parent) = parent_record.as_deref().filter(|_| !is_plural(word)) {
        // A part of one record: `items/{id}/content`, `issues/{n}/lock`.
        let doing = match method {
            "GET" | "HEAD" => "Read",
            "POST" | "PUT" | "PATCH" => "Update",
            "DELETE" => "Delete",
            other => other,
        };
        return Title::plain(format!("{doing} {parent} {thing}"));
    }
    let into = parent_record
        .map(|p| format!(" in {p}"))
        .unwrap_or_default();
    match method {
        "GET" | "HEAD" => Title::plain(format!("Read {thing}{into}")),
        "POST" => Title::resource(format!("Create {one}"), &into),
        "PUT" | "PATCH" => Title::resource(format!("Update {thing}"), &into),
        "DELETE" => Title::resource(format!("Delete {thing}"), &into),
        other => Title::plain(format!("{other} {thing}{into}")),
    }
}

/// An API version: `v1`, `v1.0`, `v62.0`, `v2beta`, a dated one (`2024-07`,
/// `2010-04-01`), or, before any resource word, a bare number (`/2/files`,
/// `/1/cards`, `/api/0/projects`).
fn is_version(s: &str, leading: bool) -> bool {
    let named = s.strip_prefix(['v', 'V']).is_some_and(|rest| {
        rest.starts_with(|c: char| c.is_ascii_digit())
            && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
    });
    let parts: Vec<&str> = s.split('-').collect();
    let dated = (2..=3).contains(&parts.len())
        && parts[0].len() == 4
        && parts
            .iter()
            .all(|p| (1..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    let numbered = leading && (1..=3).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    named || dated || numbered
}

/// A word without its endpoint version (`delete_v2` → `delete`).
fn without_version_suffix(word: &str) -> &str {
    match word.rsplit_once("_v") {
        Some((stem, n))
            if !stem.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) =>
        {
            stem
        }
        _ => word,
    }
}

/// A resource word: letters (camelCase, `snake_case` and `kebab-case`
/// allowed), short, not all capitals. Anything with a digit or a dot is an
/// id or a name the agent chose (`Shelf42`, `Report.docx`).
fn is_word(s: &str) -> bool {
    (2..=40).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphabetic() || b == b'_' || b == b'-')
        && s.bytes().any(|b| b.is_ascii_lowercase())
}

/// Whether a path word names an action (`move`, `create_folder`,
/// `batchUpdate`) rather than a collection: a plural is always a collection
/// (`merge_requests`).
fn is_action(word: &str) -> bool {
    let phrase = humanize_key(word).to_ascii_lowercase();
    let words: Vec<&str> = phrase.split(' ').collect();
    !is_plural(word)
        && (VERBS.contains(&words[0]) || (words.len() == 2 && VERBS.contains(&words[1])))
}

fn is_plural(word: &str) -> bool {
    let n = noun(word);
    singular(&n) != n
}

/// A path word as a lowercase noun: `calendarView` → "calendar view",
/// keeping acronyms ("SMS messages").
fn noun(word: &str) -> String {
    let h = humanize_key(word);
    let mut cs = h.chars();
    match (cs.next(), cs.next()) {
        (Some(_), Some(b)) if b.is_uppercase() => h,
        (Some(a), _) => a.to_lowercase().chain(h.chars().skip(1)).collect(),
        _ => h,
    }
}

/// The last word of a noun in the singular: "drafts" → "draft",
/// "calendar entries" → "calendar entry", "children" → "child".
fn singular(noun: &str) -> String {
    let (head, last) = noun.rsplit_once(' ').map_or(("", noun), |(h, l)| (h, l));
    let lower = last.to_ascii_lowercase();
    let cut = |n: usize| last[..last.len() - n].to_string();
    let consonant_before = |suffix: usize| {
        lower
            .as_bytes()
            .get(lower.len().wrapping_sub(suffix + 1))
            .is_some_and(|c| !b"aeiou".contains(c))
    };
    let one = match lower.as_str() {
        "children" => "child".to_string(),
        "people" => "person".to_string(),
        "statuses" | "aliases" => cut(2),
        "indices" => format!("{}ex", &last[..last.len() - 4]),
        "analyses" => format!("{}is", &last[..last.len() - 2]),
        "data" | "news" | "series" | "species" => last.to_string(),
        l if l.ends_with("ies") && l.len() > 4 => format!("{}y", cut(3)),
        l if l.ends_with("sses") || l.ends_with("xes") || l.ends_with("shes") => cut(2),
        l if l.ends_with("ches") && consonant_before(4) => cut(2),
        l if l.ends_with('s')
            && !l.ends_with("ss")
            && !l.ends_with("us")
            && !l.ends_with("is")
            && l.len() > 3 =>
        {
            cut(1)
        }
        _ => last.to_string(),
    };
    if head.is_empty() {
        one
    } else {
        format!("{head} {one}")
    }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/// The query parameters as rows (`$top=10` → "Top: 10"). A query carries
/// credentials under names no body would use (`X-Amz-Signature`, `sig`,
/// `code`), so it masks by the gateway's URL-credential list.
fn push_query(s: &mut ApprovalSummary, path: &str) {
    let Some((_, query)) = path.split_once('?') else {
        return;
    };
    let pairs: Vec<_> = form_urlencoded::parse(query.as_bytes())
        .filter(|(k, _)| !k.is_empty())
        .collect();
    for (k, v) in pairs.iter().take(MAX_FIELD_ROWS) {
        let value = if is_url_credential(k) {
            "***".to_string()
        } else if v.trim().is_empty() {
            EMPTY.to_string()
        } else {
            one_line(&redact_string(v), MAX_VALUE_LEN)
        };
        let label = one_line(
            &humanize_key(k.trim_start_matches(['$', '@'])),
            MAX_LABEL_LEN,
        );
        s.push(label, value);
    }
    let hidden = pairs.len().saturating_sub(MAX_FIELD_ROWS);
    if hidden > 0 {
        s.push("More", format!("+{hidden} more parameters"));
    }
}

/// A JSON object or list body. `None` for anything else, or a body the
/// gateway's peek cut (it no longer parses).
fn json_body(content_type: Option<&str>, body: &[u8]) -> Option<Value> {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    if !(ct.contains("json") || looks_like_json(body)) {
        return None;
    }
    parse_json(body).filter(|v| v.is_object() || v.is_array())
}

/// A body the card can't read as rows: what it is and its size, or, for
/// plain text, the text with its secret-named fields masked. A cut JSON
/// body or a multipart form is never shown as text: a secret in it may sit
/// where masking can't see it.
fn unread_body(content_type: Option<&str>, body: &[u8]) -> String {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    let text = String::from_utf8_lossy(body);
    let kind = if ct.contains("json") || looks_like_json(body) {
        "JSON"
    } else if ct.contains("multipart/") || is_multipart(&text) {
        "multipart form"
    } else if is_mostly_binary(body) {
        "binary"
    } else {
        return redact_text(&mask_secrets(&text).0);
    };
    format!("{kind}, {}", size_of(body))
}

/// A GraphQL call: in a JSON envelope (`{"query": "...", "variables": {...},
/// "operationName": "..."}`) or, as `application/graphql`, the document
/// itself. Every write goes to one endpoint, so the title is the operation's
/// own ("Change simple column value"), and the arguments of every field it
/// calls read as rows, the same rows (and the same redaction) as any JSON
/// body. A document this can't read shows as written, its secret-named
/// arguments masked. `false` (nothing pushed) for a body that is not GraphQL.
fn push_graphql(s: &mut ApprovalSummary, content_type: Option<&str>, body: &[u8]) -> bool {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    let raw_document = ct.contains("application/graphql") && !ct.contains("json");
    let envelope = if raw_document || !(ct.contains("json") || looks_like_json(body)) {
        None
    } else {
        parse_json(body)
    };
    let raw_text;
    let (doc, vars, operation_name) = match &envelope {
        Some(v) => {
            let Some(query) = v.get("query").and_then(Value::as_str) else {
                return false;
            };
            (
                query,
                v.get("variables").filter(|x| !x.is_null()),
                v.get("operationName").and_then(Value::as_str),
            )
        }
        None if raw_document => {
            raw_text = String::from_utf8_lossy(body);
            (raw_text.as_ref(), None, None)
        }
        None => return false,
    };
    let doc = doc.trim();
    match graphql::read(doc, vars, operation_name) {
        Read::NotGraphql => false,
        Read::Unreadable => {
            s.action = "GraphQL request".to_string();
            s.push_clamped("GraphQL", graphql::mask_secrets(doc), MAX_SNIPPET_LEN);
            if let Some(vars) = vars {
                let all =
                    nested::leaves(&serde_json::json!({ "variables": vars }), Reading::Request);
                push_leaves(s, &all);
            }
            true
        }
        Read::Operation(op) => {
            push_operation(s, op);
            true
        }
    }
}

/// The operation as the card reads it: titled by the field it calls (or the
/// first of several, with a row naming every one), each field's arguments
/// as rows ("Value: Done").
fn push_operation(s: &mut ApprovalSummary, op: graphql::Operation) {
    let names: Vec<String> = op.fields.iter().map(|f| humanize_key(&f.name)).collect();
    let Some(first) = names.first() else {
        return;
    };
    let first = match op.kind {
        Kind::Subscription => format!("Subscribe to {}", first.to_lowercase()),
        Kind::Query | Kind::Mutation => first.clone(),
    };
    s.action = match names.len() {
        1 => first,
        n => clamp(&format!("{first} and {} more", n - 1), MAX_VALUE_LEN),
    };
    let args = if op.fields.len() == 1 {
        op.fields.into_iter().next().map(|f| Value::Object(f.args))
    } else {
        s.push("Calls", names.join(", "));
        // Each call under its own name; one called twice is numbered.
        let repeated: Vec<bool> = op
            .fields
            .iter()
            .map(|f| op.fields.iter().filter(|g| g.name == f.name).count() > 1)
            .collect();
        let calls: Map<String, Value> = op
            .fields
            .into_iter()
            .zip(repeated)
            .enumerate()
            .map(|(i, (f, repeated))| {
                let key = if repeated {
                    format!("{} #{}", f.name, i + 1)
                } else {
                    f.name
                };
                (key, Value::Object(f.args))
            })
            .collect();
        Some(Value::Object(calls))
    };
    if let Some(args) = args {
        push_leaves(s, &nested::leaves(&args, Reading::Request));
    }
}

fn is_form(content_type: Option<&str>) -> bool {
    content_type
        .unwrap_or("")
        .to_ascii_lowercase()
        .contains("x-www-form-urlencoded")
}

/// A form-encoded body (`email=a%40b.com&metadata[plan]=pro`), as Stripe,
/// Twilio and many older APIs send it, as the object it describes: values
/// decoded, bracketed keys read as nesting ("Metadata › Plan"), a repeated
/// key as every value it sends (`To=a&To=b`), and an empty value as
/// [`EMPTY`], since an empty value is an instruction (Stripe unsets a
/// metadata key that way). The flag is `false` when the body has more
/// fields than are read. `None` for a body with no fields.
fn form_value(body: &[u8]) -> Option<(Value, bool)> {
    let mut pairs = form_urlencoded::parse(body).filter(|(k, _)| !k.is_empty());
    let mut obj = Map::new();
    for (k, v) in pairs.by_ref().take(MAX_FORM_FIELDS) {
        let segs: Vec<String> = k
            .replace(']', "")
            .split('[')
            .filter(|p| !p.is_empty())
            .take(MAX_FORM_DEPTH)
            .map(str::to_string)
            .collect();
        let v = v.trim();
        let value = Value::String(if v.is_empty() { EMPTY } else { v }.to_string());
        insert_path(&mut obj, &segs, value);
    }
    let read_whole = pairs.next().is_none();
    (!obj.is_empty()).then_some((Value::Object(obj), read_whole))
}

/// Set `segs` (a bracketed form key, split) to `value` in `obj`. A key sent
/// again adds its value to the list; a key that would turn a value into an
/// object keeps the value.
fn insert_path(obj: &mut Map<String, Value>, segs: &[String], value: Value) {
    let Some((head, rest)) = segs.split_first() else {
        return;
    };
    if rest.is_empty() {
        match obj.remove(head) {
            None => {
                obj.insert(head.clone(), value);
            }
            Some(Value::Array(mut a)) => {
                a.push(value);
                obj.insert(head.clone(), Value::Array(a));
            }
            Some(first @ Value::String(_)) => {
                obj.insert(head.clone(), Value::Array(vec![first, value]));
            }
            Some(kept) => {
                obj.insert(head.clone(), kept);
            }
        }
        return;
    }
    let child = obj
        .entry(head.clone())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(child) = child {
        insert_path(child, rest, value);
    }
}

/// The rows of a body: prose first, then the rest, bounded, with a closing
/// row counting what is left out (and saying so when the body was too big
/// to read whole).
fn push_leaves(s: &mut ApprovalSummary, all: &Leaves) {
    let (prose, mut rest): (Vec<&Leaf>, Vec<&Leaf>) = all.leaves.iter().partition(|l| l.long);
    let prose_shown = prose.len().min(MAX_PROSE_ROWS);
    for l in prose.iter().take(prose_shown) {
        s.push_clamped(l.label.clone(), l.value.clone(), MAX_SNIPPET_LEN);
    }
    // When text leads the card it is what the change is about: a few of the
    // shallowest settings give it context, the rest is counted. Without
    // text, the settings are the change and get the full row budget.
    let room = if prose_shown > 0 {
        CONTEXT_ROWS
    } else {
        MAX_FIELD_ROWS
    };
    rest.sort_by_key(|l| l.depth);
    for l in rest.iter().take(room) {
        s.push(l.label.clone(), l.value.clone());
    }
    let hidden = (prose.len() - prose_shown) + rest.len().saturating_sub(room);
    if hidden > 0 {
        s.push(
            "More",
            if all.complete {
                format!("+{hidden} more values")
            } else {
                format!("+{hidden} more values (the body is too big to read whole)")
            },
        );
    }
}

/// A body's size as read. A body that filled the gateway's peek may go on.
fn size_of(body: &[u8]) -> String {
    let size = human_size(body.len());
    if body.len() >= BODY_PEEK {
        format!("{size} or more")
    } else {
        size
    }
}

/// Plain text with long base64 runs replaced by their size, on one line.
fn redact_text(s: &str) -> String {
    let mut out = String::new();
    for token in s.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        if looks_like_base64_blob(token) {
            out.push_str(&format!("<{} chars, base64>", token.len()));
        } else {
            out.push_str(token);
        }
        if out.len() > MAX_BODY_LEN {
            break;
        }
    }
    clamp(&out, MAX_BODY_LEN)
}

fn is_mostly_binary(b: &[u8]) -> bool {
    let sample = &b[..b.len().min(512)];
    let nonprint = sample
        .iter()
        .filter(|&&c| c < 0x09 || (0x0d < c && c < 0x20))
        .count();
    nonprint as f64 > 0.10 * sample.len() as f64
}

fn looks_like_json(b: &[u8]) -> bool {
    matches!(
        b.iter().find(|c| !c.is_ascii_whitespace()),
        Some(b'{') | Some(b'[')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generic(method: &str, path: &str, ct: Option<&str>, body: Option<&[u8]>) -> ApprovalSummary {
        summarize(&SummaryRequest {
            method,
            path,
            content_type: ct,
            body,
        })
    }

    fn detail<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    const JSON: Option<&str> = Some("application/json");
    const FORM: Option<&str> = Some("application/x-www-form-urlencoded");

    /// Endpoints of the shapes agents call most, as titles. Ids are made up.
    #[test]
    fn titles_read_as_words() {
        for (method, path, want) in [
            (
                "GET",
                "/v1.0/me/calendarView?startDateTime=2026-01-05",
                "Read calendar view",
            ),
            (
                "POST",
                "/v1.0/me/drive/items/01ABCDEFGHIJKLMNOPQRSTUVWX/children",
                "Create child in item",
            ),
            (
                "GET",
                "/gmail/v1/users/me/drafts/r-1234567890abcdef",
                "Read draft",
            ),
            (
                "GET",
                "/services/data/v59.0/analytics/reports/00O5e000001AbCdEAF/describe",
                "Describe report",
            ),
            (
                "PATCH",
                "/services/data/v62.0/analytics/reports/00O5e000001AbCdEAF",
                "Update report",
            ),
            ("POST", "/v1/urlInspection/index:inspect", "Inspect index"),
            (
                "POST",
                "/v2/objects/companies/records/merge",
                "Merge records",
            ),
            (
                "POST",
                "/v1.0/me/messages/AAMkAGFkZTEx=/move",
                "Move message",
            ),
            (
                "GET",
                "/v1.0/me/mailFolders('inbox')/messages",
                "Read messages in mail folder",
            ),
            ("POST", "/repos/acme/web/git/refs", "Create ref"),
            (
                "POST",
                "/api/v2/databases/SALES/schemas/PUBLIC/agents/SUPPORT_BOT:run",
                "Run agent",
            ),
            (
                "GET",
                "/lists/12345/list-entries",
                "Read list entries in list",
            ),
            ("DELETE", "/v1/things/42", "Delete thing"),
            ("POST", "/v1/customers/cus_Abc123", "Update customer"),
            ("GET", "/users/me", "Read user"),
            ("POST", "/admin/api/2024-07/products", "Create product"),
            ("POST", "/graphql", "Run GraphQL request"),
            ("POST", "/v2", "POST request"),
        ] {
            assert_eq!(
                generic(method, path, None, None).action,
                want,
                "{method} {path}"
            );
        }
    }

    /// An action word reads as the action: RPC-style paths (Dropbox's
    /// `files/delete_v2`), verbs after a record (Stripe's `confirm`), and
    /// Google's custom methods. A plural is a collection, never an action.
    #[test]
    fn action_words_read_as_actions() {
        for (method, path, want) in [
            ("POST", "/2/files/delete_v2", "Delete files"),
            ("POST", "/2/files/move_v2", "Move files"),
            ("POST", "/2/files/create_folder_v2", "Create folder"),
            (
                "POST",
                "/2/files/permanently_delete",
                "Permanently delete files",
            ),
            ("POST", "/search", "Search"),
            (
                "POST",
                "/crm/v3/objects/contacts/batch/create",
                "Create contacts",
            ),
            (
                "POST",
                "/crm/v3/objects/contacts/batch/archive",
                "Archive contacts",
            ),
            (
                "POST",
                "/v1/payment_intents/pi_3Abc/confirm",
                "Confirm payment intent",
            ),
            (
                "POST",
                "/v1/documents/1AbC_dEf-123456:batchUpdate",
                "Batch update document",
            ),
            (
                "POST",
                "/api/v4/projects/123/merge_requests",
                "Create merge request in project",
            ),
        ] {
            assert_eq!(
                generic(method, path, None, None).action,
                want,
                "{method} {path}"
            );
        }
    }

    /// GitHub's lock endpoint: PUT locks the issue, DELETE unlocks it. A
    /// DELETE never reads as another verb, and an unknown word after a
    /// record reads as a part of it.
    #[test]
    fn a_delete_never_reads_as_another_action() {
        let lock = "/repos/acme/web/issues/42/lock";
        assert_eq!(generic("PUT", lock, None, None).action, "Lock issue");
        let s = generic("DELETE", lock, None, None);
        assert_eq!(s.action, "Delete issue lock");
        assert_eq!(detail(&s, "Endpoint"), Some(lock));
        let s = generic("GET", "/v9/projects/my-app/env", None, None);
        assert_eq!(s.action, "Read project env");
        assert_eq!(detail(&s, "Project"), Some("my-app"));
    }

    /// A name after a collection is a record, not a resource word.
    #[test]
    fn a_name_after_a_collection_is_a_record() {
        let s = generic("DELETE", "/v9/projects/my-app", None, None);
        assert_eq!(s.action, "Delete project");
        assert_eq!(detail(&s, "Project"), Some("my-app"));
        let version_name = generic("POST", "/v9/projects/v123", None, None);
        assert_eq!(version_name.action, "Update project");
        assert_eq!(detail(&version_name, "Project"), Some("v123"));
        let s = generic("DELETE", "/orgs/acme/members/eve", None, None);
        assert_eq!(s.action, "Delete member");
        assert_eq!(detail(&s, "Org"), Some("acme"));
        assert_eq!(detail(&s, "Member"), Some("eve"));
        // An id after a record's key is the key's next part.
        let s = generic("DELETE", "/repos/acme/web.app", None, None);
        assert_eq!(s.action, "Delete repo");
        assert_eq!(detail(&s, "Repo"), Some("acme/web.app"));
        // A word after one is read as a part of that record, never its
        // name: the URL alone can't tell `repos/acme/web` from
        // `projects/my-app/env`, and the Endpoint row says which.
        let s = generic("DELETE", "/repos/acme/web", None, None);
        assert_eq!(s.action, "Delete repo web");
        assert_eq!(detail(&s, "Endpoint"), Some("/repos/acme/web"));
        let s = generic("GET", "/calendars/primary/events", None, None);
        assert_eq!(s.action, "Read events in calendar");
        assert_eq!(detail(&s, "Calendar"), Some("primary"));
    }

    /// Microsoft Graph addresses a drive item by its path between colons.
    #[test]
    fn a_graph_item_path_reads_as_one_record() {
        let s = generic(
            "PUT",
            "/v1.0/me/drive/root:/Folder%20A/Notes.txt:/content",
            Some("text/plain"),
            Some(b"hello"),
        );
        assert_eq!(s.action, "Update item content");
        assert_eq!(detail(&s, "Path"), Some("Folder A/Notes.txt"));
        assert_eq!(detail(&s, "Body"), Some("hello"));
        let s = generic(
            "PUT",
            "/v1.0/me/drive/items/01ABCDEF:/Report.docx:/content",
            None,
            None,
        );
        assert_eq!(s.action, "Update item content");
        assert_eq!(detail(&s, "Item"), Some("01ABCDEF"));
        assert_eq!(detail(&s, "Path"), Some("Report.docx"));
        let s = generic("GET", "/v1.0/me/drive/root:/Documents", None, None);
        assert_eq!(s.action, "Read item");
        assert_eq!(detail(&s, "Path"), Some("Documents"));
    }

    #[test]
    fn the_endpoint_leads_then_the_records_the_path_names() {
        let s = generic(
            "GET",
            "/gmail/v1/users/me/drafts/r-1234567890abcdef?format=full",
            None,
            None,
        );
        let rows: Vec<(&str, &str)> = s
            .details
            .iter()
            .map(|d| (d.label.as_str(), d.value.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("Endpoint", "/gmail/v1/users/me/drafts/r-1234567890abcdef"),
                ("Draft", "r-1234567890abcdef"),
                ("Format", "full"),
            ]
        );
        // The signed-in user names no record worth a row.
        assert!(s.is_generic());
        let s = generic("GET", "/v1.0/me/mailFolders('inbox')/messages", None, None);
        assert_eq!(detail(&s, "Mail folder"), Some("inbox"));
    }

    #[test]
    fn query_params_are_rows_and_url_credentials_masked() {
        let s = generic(
            "GET",
            "/v1.0/me/calendarView?startDateTime=2026-01-05T00:00:00&$top=10&keyword=q3&access_token=sk-1&X-Amz-Signature=abc&upload_id=sess-1",
            None,
            None,
        );
        assert_eq!(detail(&s, "Start date time"), Some("2026-01-05T00:00:00"));
        assert_eq!(detail(&s, "Top"), Some("10"));
        assert_eq!(detail(&s, "Keyword"), Some("q3"));
        assert_eq!(detail(&s, "Access token"), Some("***"));
        assert_eq!(detail(&s, "X amz signature"), Some("***"));
        assert_eq!(detail(&s, "Upload id"), Some("***"));
        let all = format!("{:?}", s.details);
        assert!(!all.contains("sk-1") && !all.contains("sess-1"), "{all}");
    }

    #[test]
    fn json_redacts_base64_and_secrets_and_bounds() {
        // Read as rows: the blob is elided, the secret masked, the name shown.
        let big = "A".repeat(4000);
        let body = format!(
            "{{\"image\":\"{big}\",\"name\":\"foo\",\"api_key\":\"sk-123\",\"meta\":{{}}}}"
        );
        let s = generic("POST", "/v1/things", JSON, Some(body.as_bytes()));
        assert_eq!(s.action, "Create thing foo");
        assert_eq!(detail(&s, "Name"), Some("foo"));
        assert_eq!(detail(&s, "Api key"), Some("***"));
        assert!(detail(&s, "Image").unwrap().contains("base64"));
        let all = format!("{:?}", s.details);
        assert!(!all.contains(&big) && !all.contains("sk-123"), "{all}");
        assert!(s.render_text().chars().count() <= crate::MAX_RENDER_LEN);
    }

    /// The body's own name joins a title that names the resource, never an
    /// action's.
    #[test]
    fn a_body_name_joins_a_resource_title() {
        let name = Some(br#"{"name":"Notes"}"#.as_slice());
        let s = generic("POST", "/v1.0/me/drive/items/01ABCDEF/children", JSON, name);
        assert_eq!(s.action, "Create child Notes in item");
        let s = generic("POST", "/v1.0/me/messages/AAMk=/move", JSON, name);
        assert_eq!(s.action, "Move message");
    }

    #[test]
    fn flat_json_becomes_labeled_rows_with_redaction() {
        let big = "B".repeat(400);
        let body = format!(
            r#"{{"first_name":"Ada","lastName":"Lovelace","is_active":true,"count":3,"note":null,"api_key":"sk-live-1","avatar":"{big}"}}"#
        );
        let s = generic("POST", "/v1/people", JSON, Some(body.as_bytes()));
        assert_eq!(detail(&s, "First name"), Some("Ada"));
        assert_eq!(detail(&s, "Last name"), Some("Lovelace"));
        assert_eq!(detail(&s, "Is active"), Some("true"));
        assert_eq!(detail(&s, "Count"), Some("3"));
        assert_eq!(detail(&s, "Note"), Some(EMPTY));
        assert_eq!(detail(&s, "Api key"), Some("***"));
        assert!(detail(&s, "Avatar").unwrap().contains("base64"));
        assert_eq!(detail(&s, "Body"), None);
    }

    #[test]
    fn flat_json_rows_are_capped() {
        let fields: Vec<String> = (0..15).map(|i| format!("\"k{i}\":{i}")).collect();
        let body = format!("{{{}}}", fields.join(","));
        let s = generic("POST", "/v1/x", JSON, Some(body.as_bytes()));
        // Endpoint + 12 rows + "More".
        assert_eq!(s.details.len(), 14);
        assert_eq!(detail(&s, "More"), Some("+3 more values"));
    }

    /// A body the card can't read as rows says what it is, never shows a
    /// JSON blob: a cut body's secrets may sit where masking can't see.
    #[test]
    fn an_unread_body_says_what_it_is() {
        let cut = generic("POST", "/v1/x", JSON, Some(br#"{"a":1,"b":"#));
        assert_eq!(detail(&cut, "Body"), Some("JSON, 11 B"));
        let mut pretty = b"{\n  \"password\": \"hunter2\",\n  \"note\": \"".to_vec();
        pretty.resize(BODY_PEEK, b'x');
        let s = generic("POST", "/v1/x", JSON, Some(&pretty));
        assert_eq!(detail(&s, "Body"), Some("JSON, 16 KB or more"));
        assert!(!s.render_text().contains("hunter2"));
        let bin = generic("POST", "/v1/upload", None, Some(&[0u8; 5000]));
        assert_eq!(detail(&bin, "Body"), Some("binary, 5 KB"));
        let text = generic(
            "POST",
            "/v1/x",
            Some("text/plain"),
            Some(b"password=hunter2&note=hi"),
        );
        assert_eq!(detail(&text, "Body"), Some("password=***&note=hi"));
        let empty = generic("PATCH", "/v1/x", JSON, Some(b"{}"));
        assert_eq!(detail(&empty, "Body"), Some(EMPTY));
        // A list reads like a list in any body.
        let list = generic("POST", "/v1/x", JSON, Some(br#"[{"a":1}]"#));
        assert_eq!(detail(&list, "Items › A"), Some("1"));
    }

    /// A multipart form's fields are never read out of a prefix: a secret
    /// field's value must not reach the card, typed or sniffed.
    #[test]
    fn a_multipart_form_shows_its_kind_never_its_fields() {
        let body = b"--XX\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\nhunter2\r\n--XX--\r\n";
        let want = format!("multipart form, {} B", body.len());
        for ct in [Some("multipart/form-data; boundary=XX"), None] {
            let s = generic("POST", "/v1/upload", ct, Some(body));
            assert_eq!(detail(&s, "Body"), Some(want.as_str()), "{ct:?}");
            assert!(!s.render_text().contains("hunter2"));
        }
    }

    #[test]
    fn a_json_body_with_a_query_that_is_not_graphql_reads_as_json() {
        let s = generic(
            "POST",
            "/v1/search",
            JSON,
            Some(br#"{"query":"red shoes","limit":5}"#),
        );
        assert_eq!(s.action, "Search");
        assert_eq!(detail(&s, "Query"), Some("red shoes"));
        assert_eq!(detail(&s, "GraphQL"), None);
    }

    #[test]
    fn graphql_reads_every_call_it_makes() {
        let body = br#"{"query":"mutation { a: rename(id: 1, name: \"x\") { ok } b: deleteItem(id: 2) { ok } }"}"#;
        let s = generic("POST", "/graphql", JSON, Some(body));
        assert_eq!(s.action, "Rename and 1 more");
        assert_eq!(detail(&s, "Calls"), Some("Rename, Delete item"));
        assert_eq!(detail(&s, "Delete item › Id"), Some("2"));
        assert_eq!(detail(&s, "Rename › Name"), Some("x"));
        assert_eq!(detail(&s, "Endpoint"), None);
        assert!(s.is_generic());
    }

    #[test]
    fn graphql_reads_the_operation_the_request_names() {
        let body = br#"{"query":"mutation A { rename(id: 1) { ok } } mutation B { deleteEverything { ok } }","operationName":"B"}"#;
        let s = generic("POST", "/graphql", JSON, Some(body));
        assert_eq!(s.action, "Delete everything");
    }

    #[test]
    fn a_raw_graphql_document_reads_like_an_envelope() {
        let s = generic(
            "POST",
            "/graphql",
            Some("application/graphql"),
            Some(b"mutation { archive(id: 7) { ok } }"),
        );
        assert_eq!(s.action, "Archive");
        assert_eq!(detail(&s, "Id"), Some("7"));
    }

    #[test]
    fn unreadable_graphql_shows_as_written_with_its_secrets_masked() {
        let body = br#"{"query":"mutation { login(email: \"a@b\", password: \"hunter2\" { token } }","variables":{"api_key":"k"}}"#;
        let s = generic("POST", "/graphql", JSON, Some(body));
        assert_eq!(s.action, "GraphQL request");
        let all = format!("{:?}", s.details);
        assert!(!all.contains("hunter2") && !all.contains("\"k\""), "{all}");
        assert!(detail(&s, "GraphQL").unwrap().contains("a@b"));
        assert_eq!(detail(&s, "Variables › Api key"), Some("***"));
    }

    #[test]
    fn a_form_sends_every_repeated_value_and_says_what_it_clears() {
        let s = generic(
            "POST",
            "/v1/customers/cus_123",
            FORM,
            Some(b"To=%2B1555&To=%2B1666&metadata[plan]=&tags[]=a&tags[]=b&password=p"),
        );
        assert_eq!(s.action, "Update customer");
        assert_eq!(detail(&s, "Customer"), Some("cus_123"));
        assert_eq!(detail(&s, "To"), Some("+1555, +1666"));
        assert_eq!(detail(&s, "Tags"), Some("a, b"));
        assert_eq!(detail(&s, "Metadata › Plan"), Some(EMPTY));
        assert_eq!(detail(&s, "Password"), Some("***"));
        assert!(s.change_hint().is_none(), "a form never reads back");
    }

    #[test]
    fn a_form_too_big_to_read_whole_says_so() {
        let body: Vec<String> = (0..450).map(|i| format!("k{i}=v")).collect();
        let s = generic("POST", "/v1/x", FORM, Some(body.join("&").as_bytes()));
        assert!(
            detail(&s, "More")
                .unwrap()
                .contains("too big to read whole"),
            "{:?}",
            s.details
        );
    }

    #[test]
    fn a_query_scoped_write_never_compares_against_a_different_unscoped_read() {
        let mut s = generic(
            "PATCH",
            "/v1/items/42?scope=team",
            JSON,
            Some(br#"{"name":"new"}"#),
        );
        assert!(s.change_hint().is_none());
        s.apply_current(br#"{"name":"new"}"#, br#"{"name":"old"}"#);
        assert_eq!(detail(&s, "Scope"), Some("team"));
    }

    #[test]
    fn singulars_read_as_english() {
        for (plural, one) in [
            ("drafts", "draft"),
            ("calendar entries", "calendar entry"),
            ("children", "child"),
            ("batches", "batch"),
            ("caches", "cache"),
            ("indexes", "index"),
            ("addresses", "address"),
            ("statuses", "status"),
            ("aliases", "alias"),
            ("status", "status"),
            ("analysis", "analysis"),
            ("campus", "campus"),
            ("SMS messages", "SMS message"),
        ] {
            assert_eq!(singular(plural), one, "{plural}");
        }
    }
}
