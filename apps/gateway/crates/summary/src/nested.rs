//! Readable rows for any nested JSON body, for an app or endpoint without a
//! summarizer of its own.
//!
//! A write that carries a nested body (a Salesforce Flow version, a HubSpot
//! object with `properties`, a Notion page, a Jira transition) used to reach
//! the approver as one redacted JSON blob. Here it becomes:
//!
//! - one row per value that carries meaning, labeled by where it sits
//!   ("Action calls › Post_to_Sales_Channel › Slack conversation id"), with
//!   the noise dropped: `null`, empty strings, empty lists and objects, and
//!   layout-only keys. `false` is kept: turning a flag off is a change;
//! - long text (a message template, an email body, a description) first, as
//!   a block, since it is usually what the change is about.
//!
//! The same secret rules as every card apply ([`super::redact`]): a
//! secret-named key's value is `***` whatever its shape, and a base64 blob
//! is replaced by its size. Every walk and every value is bounded, and a walk
//! says when it stopped early, so nothing it did not read is ever counted as
//! read.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde_json::{Map, Value};

use super::redact::{is_sensitive_key, looks_like_base64_blob};
use super::{clamp, humanize_key, one_line, MAX_SNIPPET_LEN, MAX_VALUE_LEN};

/// Keys that only position or annotate an element for a builder UI.
const NOISE_KEYS: &[&str] = &["locationX", "locationY", "processMetadataValues"];

/// Keys that name the thing a body creates or changes, in order of trust.
const NAME_KEYS: &[&str] = &[
    "FullName",
    "fullName",
    "full_name",
    "DeveloperName",
    "name",
    "Name",
    "title",
    "Title",
    "label",
    "Label",
    "MasterLabel",
    "subject",
    "Subject",
    "summary",
    "displayName",
    "display_name",
];

/// Wrappers one level down that commonly hold the named fields.
const NAME_CONTAINERS: &[&str] = &[
    "Metadata",
    "metadata",
    "properties",
    "fields",
    "data",
    "record",
    "resource",
];

/// Keys that name one element of a list ("Post_to_Sales_Channel", "slack2").
const ITEM_NAME_KEYS: &[&str] = &[
    "name", "Name", "label", "Label", "field", "key", "title", "id",
];

/// Most values one walk collects, and how deep it goes. Past either bound
/// the walk says it is incomplete.
const MAX_LEAVES: usize = 2_000;
const MAX_DEPTH: usize = 12;
/// A label longer than this is cut: rows stay one line on every surface.
const MAX_LABEL_LEN: usize = 120;
/// Past this many characters (or with a line break) a value reads as prose.
/// The cards apply the same rule (`packages/api/src/lib/approval-text.ts`).
const LONG_VALUE_CHARS: usize = 80;
/// An element name longer than this is not used as a label segment.
const MAX_ITEM_NAME: usize = 60;

/// What a request sets a field to when it clears it: a JSON `null` at the
/// top of a body, or an empty form value.
pub(crate) const EMPTY: &str = "(empty)";

/// How the walk reads `null`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reading {
    /// A request body: a top-level `null` is an instruction ("clear this
    /// field"), and is kept as [`EMPTY`].
    Request,
    /// A read of the thing as it stands: `null` is a field with no value.
    Current,
}

/// One value of a body, labeled by where it sits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Leaf {
    pub(crate) label: String,
    /// The value as the card shows it: redacted and bounded.
    pub(crate) value: String,
    /// A prose value's whole text, for a line diff (`value` is clamped).
    pub(crate) text: Option<String>,
    pub(crate) depth: usize,
    /// Prose: shown as a block, first.
    pub(crate) long: bool,
    /// Under a secret-named key: `value` is `***`.
    pub(crate) secret: bool,
    /// The value as sent, hashed: two values are equal only when these are,
    /// however much of them the card shows. Never leaves the gateway.
    pub(crate) fingerprint: u64,
}

/// Every value of a body that carries meaning, in document order.
pub(crate) struct Leaves {
    pub(crate) leaves: Vec<Leaf>,
    /// `false` when the walk hit a bound: some values were not read.
    pub(crate) complete: bool,
}

pub(crate) fn leaves(v: &Value, reading: Reading) -> Leaves {
    let mut w = Walker {
        out: Vec::new(),
        complete: true,
        reading,
    };
    w.walk(v, &mut Vec::new(), 0, None, None);
    Leaves {
        leaves: w.out,
        complete: w.complete,
    }
}

/// A value as one row shows it.
struct Shown {
    value: String,
    text: Option<String>,
    long: bool,
    secret: bool,
    fingerprint: u64,
}

impl Shown {
    fn plain(value: &str, fingerprint: u64) -> Self {
        Self {
            value: clamp(value, MAX_VALUE_LEN),
            text: None,
            long: false,
            secret: false,
            fingerprint,
        }
    }

    fn secret(raw: &Value) -> Self {
        Self {
            value: "***".into(),
            text: None,
            long: false,
            secret: true,
            fingerprint: canonical_fingerprint(raw),
        }
    }
}

fn fingerprint(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// A whole value's fingerprint, read as the card reads it: unset values
/// (`null`, empty strings, empty lists) and layout keys are not part of it,
/// so a compact body and a full one that say the same thing match. Hashed as
/// it is walked, so nothing is copied.
fn canonical_fingerprint(v: &Value) -> u64 {
    fn feed(v: &Value, h: &mut DefaultHasher) {
        match v {
            Value::Object(o) => {
                h.write_u8(b'{');
                for (k, c) in o.iter().filter(|(k, c)| !is_noise(k, c) && !is_empty(c)) {
                    k.hash(h);
                    feed(c, h);
                }
                h.write_u8(b'}');
            }
            Value::Array(a) => {
                h.write_u8(b'[');
                a.iter().filter(|c| !is_empty(c)).for_each(|c| feed(c, h));
                h.write_u8(b']');
            }
            other => {
                h.write_u8(b'=');
                scalar_text(other).unwrap_or_default().hash(h);
            }
        }
    }
    let mut h = DefaultHasher::new();
    feed(v, &mut h);
    h.finish()
}

/// A scalar as the text it means: a string's own text (trimmed), a number or
/// boolean as written, so `"5000"` and `5000` are the same value.
fn scalar_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn is_prose(s: &str) -> bool {
    s.chars().count() > LONG_VALUE_CHARS || s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// A scalar as one row: a base64 blob by its size, prose whole (for the
/// diff) and clamped (for the card), anything else as written.
fn scalar(v: &Value) -> Option<Shown> {
    let s = scalar_text(v)?;
    if s.is_empty() {
        return None;
    }
    let fp = fingerprint(&s);
    if looks_like_base64_blob(&s) {
        return Some(Shown::plain(
            &format!("<{} chars, base64>", s.chars().count()),
            fp,
        ));
    }
    if is_prose(&s) {
        return Some(Shown {
            value: clamp(&s, MAX_SNIPPET_LEN),
            long: true,
            secret: false,
            fingerprint: fp,
            text: Some(s),
        });
    }
    Some(Shown::plain(&s, fp))
}

/// Salesforce's per-record `attributes` (`{"type": "Account", "url": …}`):
/// routing, not a value. Any other `attributes` (a JSON:API body's whole
/// payload) is read like every key.
fn is_noise(k: &str, v: &Value) -> bool {
    NOISE_KEYS.contains(&k)
        || (k == "attributes"
            && v.as_object().is_some_and(|o| {
                o.contains_key("type")
                    && o.keys()
                        .all(|k| matches!(k.as_str(), "type" | "url" | "referenceId"))
            }))
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.iter().all(is_empty),
        Value::Object(o) => o.iter().all(|(k, c)| is_noise(k, c) || is_empty(c)),
        _ => false,
    }
}

fn is_scalar(v: &Value) -> bool {
    !matches!(v, Value::Object(_) | Value::Array(_))
}

fn live(o: &Map<String, Value>) -> Vec<(&String, &Value)> {
    o.iter()
        .filter(|(k, c)| !is_noise(k, c) && !is_empty(c))
        .collect()
}

/// A list element that is just a value: a scalar, or an object holding only
/// its name or id (`{"id": "u1"}`, `{"name": "bug"}`), read as that value.
/// Never `key`: a lone `{"key": …}` may be a credential.
fn bare(v: &Value) -> Option<&Value> {
    if is_scalar(v) {
        return (!v.is_null()).then_some(v);
    }
    match live(v.as_object()?).as_slice() {
        [(k, c)]
            if matches!(
                k.as_str(),
                "id" | "name" | "Name" | "label" | "Label" | "title"
            ) && is_scalar(c) =>
        {
            Some(c)
        }
        _ => None,
    }
}

/// The short name an element of a list goes by, and the key it came from.
fn item_name(v: &Value) -> Option<(&'static str, String)> {
    let o = v.as_object()?;
    ITEM_NAME_KEYS.iter().find_map(|k| {
        let s = o.get(*k)?.as_str()?.trim();
        (!s.is_empty() && s.chars().count() <= MAX_ITEM_NAME && !s.contains('\n'))
            .then(|| (*k, one_line(s, MAX_ITEM_NAME)))
    })
}

struct Walker {
    out: Vec<Leaf>,
    complete: bool,
    reading: Reading,
}

impl Walker {
    fn push(&mut self, path: &[String], depth: usize, shown: Shown) {
        let label = if path.is_empty() {
            "Value".to_string()
        } else {
            one_line(&path.join(" › "), MAX_LABEL_LEN)
        };
        self.out.push(Leaf {
            label,
            value: shown.value,
            text: shown.text,
            depth,
            long: shown.long,
            secret: shown.secret,
            fingerprint: shown.fingerprint,
        });
    }

    /// A subtree past [`MAX_DEPTH`]: counted, not read.
    fn too_deep(&mut self, path: &[String], depth: usize, fingerprint: u64, what: String) {
        self.complete = false;
        self.push(path, depth, Shown::plain(&what, fingerprint));
    }

    fn walk(
        &mut self,
        v: &Value,
        path: &mut Vec<String>,
        depth: usize,
        key: Option<&str>,
        skip_key: Option<&str>,
    ) {
        if self.out.len() >= MAX_LEAVES {
            self.complete = false;
            return;
        }
        if key.is_some_and(is_sensitive_key) && !v.is_null() {
            self.push(path, depth, Shown::secret(v));
            return;
        }
        match v {
            // In a request, a top-level null is an instruction ("clear this
            // field" in a PATCH); deeper, it is a builder's unset default.
            Value::Null => {
                if depth == 1 && self.reading == Reading::Request {
                    self.push(path, depth, Shown::plain(EMPTY, fingerprint(EMPTY)));
                }
            }
            Value::Array(a) => self.array(a, path, depth),
            Value::Object(o) => self.object(o, path, depth, skip_key),
            _ => {
                if let Some(shown) = scalar(v) {
                    self.push(path, depth, shown);
                }
            }
        }
    }

    fn array(&mut self, a: &[Value], path: &mut Vec<String>, depth: usize) {
        let items: Vec<&Value> = a.iter().filter(|x| !is_empty(x)).collect();
        if items.is_empty() {
            return;
        }
        // A list of plain values (or of bare names) reads as one row.
        let values: Vec<&Value> = items.iter().filter_map(|x| bare(x)).collect();
        if values.len() == items.len() {
            let mut h = DefaultHasher::new();
            let shown: Vec<String> = values
                .iter()
                .filter_map(|x| scalar_text(x))
                .inspect(|t| t.hash(&mut h))
                .map(|t| {
                    if looks_like_base64_blob(&t) {
                        format!("<{} chars, base64>", t.chars().count())
                    } else {
                        one_line(&t, MAX_VALUE_LEN)
                    }
                })
                .collect();
            self.push(path, depth, Shown::plain(&shown.join(", "), h.finish()));
            return;
        }
        if depth >= MAX_DEPTH {
            let mut h = DefaultHasher::new();
            items
                .iter()
                .for_each(|x| canonical_fingerprint(x).hash(&mut h));
            self.too_deep(path, depth, h.finish(), format!("{} items", items.len()));
            return;
        }
        for (i, item) in items.iter().enumerate() {
            if let Some(value) = bare(item) {
                path.push(format!("#{}", i + 1));
                if let Some(shown) = scalar(value) {
                    self.push(path, depth + 1, shown);
                }
                path.pop();
                continue;
            }
            let named = item_name(item);
            let pair = item.as_object().is_some_and(|o| pair_of(o).is_some());
            // An element named like a secret (`{"name": "access_token",
            // "value": …}`) hides whatever it carries.
            if let Some((_, name)) = &named {
                if is_sensitive_key(name) {
                    path.push(name.clone());
                    self.push(path, depth + 1, Shown::secret(item));
                    path.pop();
                    continue;
                }
            }
            match (&named, pair) {
                // A `{name, value}` pair labels itself.
                (_, true) => self.walk(item, path, depth + 1, None, None),
                (Some((k, name)), false) => {
                    path.push(name.clone());
                    self.walk(item, path, depth + 1, None, Some(k));
                    path.pop();
                }
                (None, false) if items.len() == 1 => {
                    self.walk(item, path, depth + 1, None, None);
                }
                (None, false) => {
                    path.push(format!("#{}", i + 1));
                    self.walk(item, path, depth + 1, None, None);
                    path.pop();
                }
            }
        }
    }

    fn object(
        &mut self,
        o: &Map<String, Value>,
        path: &mut Vec<String>,
        depth: usize,
        skip_key: Option<&str>,
    ) {
        let mut fields: Vec<(&String, &Value)> = live(o)
            .into_iter()
            .filter(|(k, _)| Some(k.as_str()) != skip_key)
            .collect();
        // At the top of a request, a null field is a "clear it" instruction.
        if depth == 0 && self.reading == Reading::Request {
            fields.extend(o.iter().filter(|(k, c)| c.is_null() && !is_noise(k, c)));
        }
        if fields.is_empty() {
            return;
        }
        if depth >= MAX_DEPTH {
            let mut h = DefaultHasher::new();
            for (k, c) in &fields {
                k.hash(&mut h);
                canonical_fingerprint(c).hash(&mut h);
            }
            self.too_deep(path, depth, h.finish(), format!("{} fields", fields.len()));
            return;
        }
        if let Some((name, value)) = pair_of(o) {
            path.push(name);
            if path.last().is_some_and(|n| is_sensitive_key(n)) {
                self.push(path, depth + 1, Shown::secret(value));
            } else {
                self.walk(value, path, depth + 1, None, None);
            }
            path.pop();
            return;
        }
        // A typed wrapper around one value (`{"stringValue": "x"}`,
        // `{"value": 3}`) reads as the value under its parent's label.
        // Only those: a lone ordinary field keeps its own name, so the
        // same value carries the same label whatever else sits beside it.
        if let [(k, c)] = fields.as_slice() {
            let wrapper = k.as_str() == "value"
                || k.ends_with("Value")
                || matches!(k.as_str(), "elementReference" | "formulaExpression");
            if wrapper
                && skip_key.is_none()
                && is_scalar(c)
                && !path.is_empty()
                && !is_sensitive_key(k)
            {
                self.walk(c, path, depth + 1, Some(k), None);
                return;
            }
        }
        for (k, c) in fields {
            path.push(humanize_key(k));
            self.walk(c, path, depth + 1, Some(k), None);
            path.pop();
        }
    }
}

/// `{"name": "x", "value": …}` (Salesforce input parameters, custom field
/// arrays): one row labeled by the name. Only that exact shape.
fn pair_of(o: &Map<String, Value>) -> Option<(String, &Value)> {
    let fields = live(o);
    if fields.len() != 2 {
        return None;
    }
    let name = fields
        .iter()
        .find(|(k, _)| matches!(k.as_str(), "name" | "Name" | "key" | "field"))?
        .1
        .as_str()?;
    let value = fields
        .iter()
        .find(|(k, _)| matches!(k.as_str(), "value" | "Value" | "values"))?
        .1;
    let name = name.trim();
    (!name.is_empty() && name.chars().count() <= MAX_ITEM_NAME)
        .then(|| (one_line(name, MAX_ITEM_NAME), value))
}

/// The name the body gives the thing it creates or changes, at the top
/// level or one wrapper down. One line, bounded.
pub(crate) fn body_name(v: &Value) -> Option<String> {
    let o = v.as_object()?;
    let direct = |o: &Map<String, Value>| {
        NAME_KEYS.iter().find_map(|k| {
            let s = o.get(*k)?.as_str()?.trim();
            (!s.is_empty() && !s.contains('\n')).then(|| one_line(s, 80))
        })
    };
    direct(o).or_else(|| {
        NAME_CONTAINERS
            .iter()
            .find_map(|c| o.get(*c)?.as_object().and_then(direct))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows(v: &Value) -> Vec<(String, String)> {
        leaves(v, Reading::Request)
            .leaves
            .into_iter()
            .map(|l| (l.label, l.value))
            .collect()
    }

    #[test]
    fn noise_is_dropped_and_false_is_kept() {
        let v = json!({
            "a": null, "b": "", "c": [], "d": {}, "locationX": 4,
            "processMetadataValues": [{"x": 1}],
            "attributes": {"type": "Account", "url": "/x"},
            "nested": {"on": false, "n": 0, "empty": {"x": null}}
        });
        assert_eq!(
            rows(&v),
            [
                ("Nested › N".into(), "0".into()),
                ("Nested › On".into(), "false".into()),
                // A top-level null is a "clear it" instruction: kept.
                ("A".into(), EMPTY.into())
            ]
        );
    }

    #[test]
    fn a_json_api_payload_under_attributes_is_read() {
        let v = json!({"data": {"type": "tickets", "attributes": {"status": "closed"}}});
        assert!(rows(&v).contains(&("Data › Attributes › Status".into(), "closed".into())));
    }

    #[test]
    fn a_read_of_what_stands_drops_every_null() {
        let v = json!({"body": null, "title": "x"});
        let l = leaves(&v, Reading::Current).leaves;
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].label, "Title");
    }

    #[test]
    fn lists_are_labeled_by_their_elements_names() {
        let v = json!({
            "actionCalls": [{
                "name": "Post_to_Sales_Channel",
                "actionName": "slackPostMessage",
                "inputParameters": [
                    {"name": "slackConversationId", "value": {"stringValue": "C0TEST", "numberValue": null}},
                    {"name": "slackMessage", "value": {"elementReference": "slack2"}}
                ]
            }],
            "start": {"filters": [{"field": "LeadSource", "operator": "IsChanged", "value": {"booleanValue": true}}]}
        });
        assert_eq!(
            rows(&v),
            [
                (
                    "Action calls › Post_to_Sales_Channel › Action name".into(),
                    "slackPostMessage".into()
                ),
                (
                    "Action calls › Post_to_Sales_Channel › Input parameters › slackConversationId"
                        .into(),
                    "C0TEST".into()
                ),
                (
                    "Action calls › Post_to_Sales_Channel › Input parameters › slackMessage".into(),
                    "slack2".into()
                ),
                (
                    "Start › Filters › LeadSource › Operator".into(),
                    "IsChanged".into()
                ),
                ("Start › Filters › LeadSource › Value".into(), "true".into()),
            ]
        );
    }

    #[test]
    fn elements_that_are_only_a_name_or_id_read_as_their_value() {
        let v = json!({
            "people": [{"id": "u1"}, {"id": "u2"}],
            "labels": [{"name": "bug"}],
            "mixed": [{"id": "u3"}, {"name": "x", "role": "owner"}]
        });
        let r = rows(&v);
        assert!(r.contains(&("People".into(), "u1, u2".into())), "{r:?}");
        assert!(r.contains(&("Labels".into(), "bug".into())), "{r:?}");
        assert!(r.contains(&("Mixed › #1".into(), "u3".into())), "{r:?}");
        assert!(
            r.contains(&("Mixed › x › Role".into(), "owner".into())),
            "{r:?}"
        );
    }

    #[test]
    fn secrets_and_blobs_never_show() {
        let blob = "QUJD".repeat(60);
        let v = json!({
            "auth": {"api_key": "sk-live-1", "client_secret": {"v": "x"}},
            "params": [{"name": "access_token", "value": "tok-123"}],
            "headers": [{"key": "X-Api-Key", "value": "hdr-1"}],
            "files": [{"name": "a.png", "content": blob}]
        });
        let r = rows(&v);
        let all = format!("{r:?}");
        for leaked in ["sk-live-1", "tok-123", "hdr-1", blob.as_str()] {
            assert!(!all.contains(leaked), "{leaked} in {all}");
        }
        assert!(r.contains(&("Auth › Api key".into(), "***".into())));
        assert!(r.contains(&("Auth › Client secret".into(), "***".into())));
        assert!(r.contains(&("Params › access_token".into(), "***".into())));
        assert!(r.contains(&("Headers › X-Api-Key".into(), "***".into())));
        // A named element whose name is a secret hides every field it has.
        let v = json!({"vars": [{"name": "password", "value": "p", "type": "string"}]});
        assert_eq!(rows(&v), [("Vars › password".into(), "***".into())]);
        assert!(all.contains("chars, base64"), "{all}");
    }

    #[test]
    fn long_text_is_marked_prose_and_kept_whole() {
        let v = json!({"tpl": [{"name": "slack2", "text": "*A*\n*B:* {!x}"}]});
        let l = leaves(&v, Reading::Request).leaves;
        assert_eq!(l[0].label, "Tpl › slack2 › Text");
        assert!(l[0].long);
        let long = "w ".repeat(2_000);
        let l = leaves(&json!({ "body": long }), Reading::Request).leaves;
        assert!(l[0].value.chars().count() <= MAX_SNIPPET_LEN);
        assert_eq!(l[0].text.as_deref(), Some(long.trim()));
    }

    #[test]
    fn equal_values_fingerprint_equal_whatever_the_card_shows() {
        let fp = |v: Value| leaves(&json!({ "a": v }), Reading::Request).leaves[0].fingerprint;
        assert_eq!(fp(json!("5000")), fp(json!(5000)));
        assert_ne!(fp(json!({"api_key": "k1"})), fp(json!({"api_key": "k2"})));
        let head = "x".repeat(3_000);
        assert_ne!(fp(json!(format!("{head}1"))), fp(json!(format!("{head}2"))));
        // A secret sent compact matches the same secret spelled out.
        assert_eq!(
            fp(json!({"token": {"v": "k", "x": null}})),
            fp(json!({"token": {"v": "k"}}))
        );
    }

    #[test]
    fn walks_are_bounded_and_say_so() {
        let mut deep = json!("x");
        for _ in 0..50 {
            deep = json!({"k": {"j": deep, "z": 1}});
        }
        let w = leaves(&deep, Reading::Request);
        assert!(w.leaves.len() < 50);
        assert!(!w.complete);
        let wide = Value::Object(
            (0..5000)
                .map(|i| (format!("k{i}"), json!({"v": i, "w": i})))
                .collect(),
        );
        let w = leaves(&wide, Reading::Request);
        assert_eq!(w.leaves.len(), MAX_LEAVES);
        assert!(!w.complete);
        assert!(leaves(&json!({"a": {"b": 1}}), Reading::Request).complete);
    }

    #[test]
    fn names_come_from_the_body() {
        assert_eq!(
            body_name(&json!({"FullName": "Flow-3", "Metadata": {"label": "x"}})).as_deref(),
            Some("Flow-3")
        );
        assert_eq!(
            body_name(&json!({"properties": {"name": "Big deal"}})).as_deref(),
            Some("Big deal")
        );
        assert_eq!(body_name(&json!({"x": 1})), None);
    }
}
