//! What a change looks like next to what it replaces: the before → after of
//! a card for an edit of something that already exists.
//!
//! A summarizer that can tell WHERE the current state lives sets a
//! [`ChangeHint`] on its summary: a read, on the held request's own host,
//! that answers the thing as it stands. The gateway makes that read under
//! the same guards as a record-name read (`proxy::approval_enrich`), then
//! hands the answer to [`ApprovalSummary::apply_current`], which compares
//! it with the request body and leads the card with what changes:
//!
//! - a multi-line text (a message template, a description) as the new text
//!   with every line marked against the old one;
//! - every other changed value as `old → new`;
//! - a count of the values that stay as they are, so the approver knows the
//!   rest was compared, not skipped.
//!
//! Values compare by what was sent, never by what the card shows: a secret
//! (`***` on both sides) or a text longer than the card still reads as
//! changed when it changes, and a secret's value is never shown. A body or
//! an answer too big to read whole gets no comparison at all: the card never
//! says a value it did not read stays as it is. Pure and bounded, like every
//! summarizer.

use std::collections::HashMap;

use serde_json::Value;

use super::nested::{self, Leaf, Reading};
use super::{clamp, one_line, ApprovalDetail, ApprovalSummary, MAX_SNIPPET_LEN, MAX_VALUE_LEN};

/// Most changed values a card leads with.
const MAX_CHANGED_ROWS: usize = 8;
/// Most lines one text change shows.
const MAX_DIFF_LINES: usize = 24;
/// Most lines of each text a line diff reads (its table is n × m).
const MAX_DIFF_INPUT_LINES: usize = 200;
/// Characters kept before the first difference of a long one-line value.
const ARROW_CONTEXT: usize = 20;

/// Where the current state of what a request changes can be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeHint {
    /// Path and query of the read, on the held request's own host. Built
    /// only from validated pieces, never raw request text.
    pub read_path: String,
    /// How the answer is laid out.
    pub(crate) shape: CurrentShape,
}

/// Where in the read's answer the thing as it stands sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CurrentShape {
    /// The answer is the resource itself, in the request body's own shape,
    /// and the body sets only some of its fields (a `PATCH` / `PUT`).
    Same,
    /// A Salesforce Tooling query for a Flow's active version: the request
    /// body's `Metadata` (a whole new version) compares with the one
    /// record's `Metadata`.
    SalesforceFlowQuery,
}

impl ChangeHint {
    /// `PATCH` / `PUT` of one resource whose own path answers a `GET` in the
    /// body's shape. Only for a path with no query, dot segment or escape.
    pub(crate) fn same_path(method: &str, path: &str, body: &Value) -> Option<Self> {
        let m = method.to_ascii_uppercase();
        if !(m == "PATCH" || m == "PUT") || !body.is_object() || !safe_path(path) {
            return None;
        }
        Some(Self {
            read_path: path.to_string(),
            shape: CurrentShape::Same,
        })
    }
}

/// A path the gateway may read back as is: plain segments only.
fn safe_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains("//")
        && path.split('/').all(|s| {
            s != "."
                && s != ".."
                && s.bytes().all(|b| {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'-' | b'_' | b'.' | b'~' | b':' | b'@')
                })
        })
}

impl ApprovalSummary {
    /// Where the card's before → after can be read, if anywhere.
    #[must_use]
    pub fn change_hint(&self) -> Option<&ChangeHint> {
        self.change.as_ref()
    }

    /// Compare `current` (the answer to [`ChangeHint::read_path`]) with the
    /// request `body`, and lead the card with what changes. Does nothing on
    /// an answer it can't read whole, so the card keeps its plain rows.
    pub fn apply_current(&mut self, body: &[u8], current: &[u8]) {
        let Some(hint) = self.change.take() else {
            return;
        };
        let (Ok(new), Ok(old)) = (
            serde_json::from_slice::<Value>(body),
            serde_json::from_slice::<Value>(current),
        ) else {
            return;
        };
        let (new, old) = match hint.shape {
            CurrentShape::Same => (new, old),
            CurrentShape::SalesforceFlowQuery => {
                // The query asks for one record; any other answer is not
                // the version it names.
                let records = old.get("records").and_then(Value::as_array);
                let [record] = records.map(Vec::as_slice).unwrap_or_default() else {
                    return;
                };
                let (Some(old), Some(new)) = (record.get("Metadata"), new.get("Metadata")) else {
                    return;
                };
                (new.clone(), old.clone())
            }
        };
        let old = align(&new, old);
        if let Some(rows) = changed_rows(&new, &old, hint.shape == CurrentShape::Same) {
            self.lead_with(rows);
        }
    }

    /// Lead the card with `rows` alone: once compared, a value that stays
    /// as it is only hides what moves (the Unchanged row counts them).
    /// Provider context before the Endpoint row, the Endpoint itself, every linked
    /// row and every record row stay, and each record keeps naming its own row.
    /// Context may carry safety warnings that are not values compared against state.
    fn lead_with(&mut self, rows: Vec<ApprovalDetail>) {
        let record_rows: Vec<usize> = self.refs.iter().map(|r| r.detail_index).collect();
        let fallback_rows = self.fallback.clone().unwrap_or(0..0);
        let context_end = self
            .details
            .iter()
            .position(|d| d.label == "Endpoint")
            .unwrap_or(0);
        let mut moved: Vec<Option<usize>> = vec![None; self.details.len()];
        let old = std::mem::take(&mut self.details);
        for (i, d) in old.into_iter().enumerate() {
            if i < context_end
                || d.label == "Endpoint"
                || d.url.is_some()
                || record_rows.contains(&i)
                || fallback_rows.contains(&i)
            {
                moved[i] = Some(self.details.len());
                self.details.push(d);
            }
        }
        let at = self
            .details
            .iter()
            .position(|d| d.label == "Endpoint")
            .map_or(0, |i| i + 1);
        let inserted = rows.len();
        self.details.splice(at..at, rows);
        if let Some(range) = self.fallback.as_mut() {
            let positions: Vec<usize> = fallback_rows
                .filter_map(|i| moved[i])
                .map(|p| if p >= at { p + inserted } else { p })
                .collect();
            *range = match (positions.first(), positions.last()) {
                (Some(first), Some(last)) => *first..last + 1,
                _ => 0..0,
            };
        }
        for r in &mut self.refs {
            if let Some(&Some(p)) = moved.get(r.detail_index) {
                r.detail_index = if p >= at { p + inserted } else { p };
            }
        }
    }
}

/// The rows that lead a card with what changes: each changed value, then
/// how many more changed and how many stay as they are. `None` when nothing
/// changes, when nothing could be compared, or when either side was too big
/// to read whole. `partial`: the body sets only some fields (a `PATCH`), and
/// the read may leave fields out, so a field it does not answer is neither
/// new nor removed.
fn changed_rows(new: &Value, old: &Value, partial: bool) -> Option<Vec<ApprovalDetail>> {
    // A partial edit's top-level null is an instruction ("clear it"); a
    // whole version's nulls, like the read's, are values never set.
    let reading = if partial {
        Reading::Request
    } else {
        Reading::Current
    };
    let new = nested::leaves(new, reading);
    let old = nested::leaves(old, Reading::Current);
    if !new.complete || !old.complete {
        return None;
    }
    let new_by: HashMap<_, _> = keyed(&new.leaves).collect();
    let old_by: HashMap<_, _> = keyed(&old.leaves).collect();
    let mut rows: Vec<(String, String)> = Vec::new();
    let (mut same, mut changed, mut compared) = (0usize, 0usize, 0usize);
    let mut keep = |rows: &mut Vec<(String, String)>, label: &str, value: String| {
        changed += 1;
        if rows.len() < MAX_CHANGED_ROWS {
            rows.push((label.to_string(), value));
        }
    };
    for (key, n) in keyed(&new.leaves) {
        match old_by.get(&key) {
            Some(o) if o.fingerprint == n.fingerprint => {
                compared += 1;
                same += 1;
            }
            Some(o) => {
                compared += 1;
                keep(&mut rows, &n.label, changed_value(o, n));
            }
            // What the read does not answer is set, not new: a partial read
            // (HubSpot's default properties) may leave it out.
            None if partial => keep(&mut rows, &n.label, n.value.clone()),
            // A whole version that spells out a builder default the stored
            // one leaves unset is not a change.
            None if is_default(&n.value) => same += 1,
            None => keep(&mut rows, &n.label, added_value(n)),
        }
    }
    if !partial {
        for (key, o) in keyed(&old.leaves) {
            if new_by.contains_key(&key) {
                continue;
            }
            if is_default(&o.value) {
                same += 1;
            } else {
                keep(&mut rows, &o.label, removed_value(o));
            }
        }
    }
    if changed == 0 || compared == 0 {
        return None;
    }
    let shown = rows.len();
    let mut out: Vec<ApprovalDetail> = short_labels(rows)
        .into_iter()
        .map(|(label, value)| detail(label, clamp(&value, MAX_SNIPPET_LEN)))
        .collect();
    if changed > shown {
        out.push(detail("More", format!("+{} more values", changed - shown)));
    }
    if same > 0 {
        out.push(detail(
            "Unchanged",
            if same == 1 {
                "1 other setting stays as it is".to_string()
            } else {
                format!("{same} other settings stay as they are")
            },
        ));
    }
    Some(out)
}

/// Each leaf keyed by its label and which occurrence of that label it is,
/// so two values that share a label compare in order, never by accident.
fn keyed(leaves: &[Leaf]) -> impl Iterator<Item = ((&str, usize), &Leaf)> {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    leaves.iter().map(move |l| {
        let n = seen.entry(l.label.as_str()).or_default();
        let key = (l.label.as_str(), *n);
        *n += 1;
        (key, l)
    })
}

/// `old` in `new`'s shape where the two spell one thing differently: a list
/// the request sends as names (`"labels": ["bug"]`) that the read answers as
/// objects (`[{"id": 1, "name": "bug", "color": "f00"}]`) reads as those
/// objects' names (or ids, whichever the request's values match). Anything
/// else is left as it is. Bounded by the request's own nesting.
fn align(new: &Value, old: Value) -> Value {
    match (new, old) {
        (Value::Object(n), Value::Object(mut o)) => {
            for (k, nv) in n {
                if let Some(ov) = o.remove(k) {
                    o.insert(k.clone(), align(nv, ov));
                }
            }
            Value::Object(o)
        }
        (Value::Array(n), Value::Array(o))
            if !n.is_empty()
                && n.iter().all(|x| x.is_string() || x.is_number())
                && o.iter().all(Value::is_object) =>
        {
            let pick = |key: &str| -> Option<Vec<Value>> {
                o.iter().map(|x| x.get(key).cloned()).collect()
            };
            let as_str = |v: &Value| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let wanted: Vec<String> = n.iter().map(as_str).collect();
            ["name", "id", "key", "login", "email", "label", "title"]
                .iter()
                .filter_map(|k| pick(k))
                .find(|vals| vals.iter().any(|v| wanted.contains(&as_str(v))))
                .map_or(Value::Array(o), Value::Array)
        }
        (_, old) => old,
    }
}

fn detail(label: impl Into<String>, value: String) -> ApprovalDetail {
    ApprovalDetail {
        label: label.into(),
        value,
        url: None,
    }
}

/// One changed value: a secret only says it changes, a text with line
/// breaks reads as a line diff, anything else as `old → new`.
fn changed_value(old: &Leaf, new: &Leaf) -> String {
    if old.secret || new.secret {
        return "changes (value hidden)".to_string();
    }
    let (o, n) = (full_text(old), full_text(new));
    if o.contains('\n') || n.contains('\n') {
        line_diff(o, n)
    } else {
        arrow(o, n, MAX_VALUE_LEN / 2)
    }
}

/// A value a whole new version adds.
fn added_value(new: &Leaf) -> String {
    if new.secret {
        "(new) ***".to_string()
    } else if new.long {
        full_text(new).to_string()
    } else {
        format!("(new) {}", one_line(&new.value, MAX_VALUE_LEN))
    }
}

/// A value a whole new version leaves out.
fn removed_value(old: &Leaf) -> String {
    if old.secret {
        "(removed) ***".to_string()
    } else {
        format!("(removed) {}", one_line(&old.value, MAX_VALUE_LEN))
    }
}

/// A value's whole text: a long one is kept whole for the diff.
fn full_text(l: &Leaf) -> &str {
    l.text.as_deref().unwrap_or(&l.value)
}

/// `old → new` for two one-line values, each starting just before where
/// they first differ when that point would not fit, so a change past what
/// the card shows still shows.
fn arrow(old: &str, new: &str, max: usize) -> String {
    let (o, n): (Vec<char>, Vec<char>) = (old.chars().collect(), new.chars().collect());
    let common = o.iter().zip(&n).take_while(|(a, b)| a == b).count();
    let start = if common + ARROW_CONTEXT > max {
        common.saturating_sub(ARROW_CONTEXT)
    } else {
        0
    };
    let from = |c: &[char]| {
        let tail: String = c[start.min(c.len())..].iter().collect();
        let tail = one_line(&tail, max);
        if start > 0 {
            format!("…{tail}")
        } else {
            tail
        }
    };
    format!("{} → {}", from(&o), from(&n))
}

/// Changed values' labels as a person would say them: the last two parts
/// ("Properties › Amount" stays; "Start › Filters › LeadSource › Value"
/// becomes "LeadSource › Value"), unless two rows would then read alike,
/// which keep their whole label. A Flow message template reads as the
/// card's own "Message <name>" row.
fn short_labels(rows: Vec<(String, String)>) -> Vec<(String, String)> {
    let short = |label: &str| -> String {
        let parts: Vec<&str> = label.split(" › ").collect();
        if let [.., "Text templates", name, "Text"] = parts.as_slice() {
            return format!("Message {name}");
        }
        parts[parts.len().saturating_sub(2)..].join(" › ")
    };
    let shorts: Vec<String> = rows.iter().map(|(l, _)| short(l)).collect();
    rows.into_iter()
        .zip(&shorts)
        .map(|((label, value), s)| {
            let alike = shorts.iter().filter(|o| *o == s).count() > 1;
            (if alike { label } else { s.clone() }, value)
        })
        .collect()
}

/// The removed line `line` most likely replaces: the one sharing the most
/// words with it, if at least half of the shorter one's words. A line with
/// nothing in common is new.
fn most_similar(line: &str, candidates: &[&str]) -> Option<usize> {
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric() && c != '$' && c != '.')
            .filter(|w| w.len() > 1)
            .map(str::to_lowercase)
            .collect()
    };
    let mine = words(line);
    candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let theirs = words(c);
            let shared = mine.iter().filter(|w| theirs.contains(w)).count();
            let base = mine.len().min(theirs.len()).max(1);
            (i, shared, shared * 2 >= base)
        })
        .filter(|(_, shared, enough)| *enough && *shared > 0)
        .max_by_key(|(_, shared, _)| *shared)
        .map(|(i, _, _)| i)
}

/// A value the request only spells out where the current state leaves it
/// unset: a zero or `false` default is not a change.
fn is_default(v: &str) -> bool {
    matches!(v, "0" | "0.0" | "false")
}

/// The new text as it will read, every line marked against `old`: a new
/// line ends `← new`, a line that changed place ends `← moved`, an edited
/// line ends `← was: <old line>`, the rest read as they are; then each
/// removed line, struck as `(removed) …`. A short text reads whole, so the
/// approver sees where every line ends up; a long one keeps one line of
/// context around each change. Plain-text markers on purpose: they read the
/// same on every surface (a symbol can turn into an emoji in chat).
fn line_diff(old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().take(MAX_DIFF_INPUT_LINES).collect();
    let b: Vec<&str> = new.lines().take(MAX_DIFF_INPUT_LINES).collect();
    let cut = old.lines().nth(MAX_DIFF_INPUT_LINES).is_some()
        || new.lines().nth(MAX_DIFF_INPUT_LINES).is_some();
    // Longest common subsequence over at most 200 × 200 lines.
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    // Which lines of `new` stay in place, and which of `old` are kept.
    let (mut i, mut j) = (0, 0);
    let mut kept_new = vec![false; m];
    let mut kept_old = vec![false; n];
    while i < n && j < m {
        if a[i] == b[j] {
            kept_old[i] = true;
            kept_new[j] = true;
            i += 1;
            j += 1;
        } else if lcs[i][j + 1] >= lcs[i + 1][j] {
            j += 1;
        } else {
            i += 1;
        }
    }
    let removed: Vec<&str> = (0..n).filter(|&i| !kept_old[i]).map(|i| a[i]).collect();
    // A changed line takes the place of the most similar removed one: it is
    // an edit ("was: …"), not a new line plus a removed one.
    let mut unpaired: Vec<&str> = removed.iter().copied().filter(|l| !b.contains(l)).collect();
    // (line, marked): a marked line is part of the change.
    let mut out: Vec<(String, bool)> = Vec::new();
    for (j, line) in b.iter().enumerate() {
        if kept_new[j] {
            out.push(((*line).to_string(), false));
        } else if removed.contains(line) {
            out.push((format!("{line}   ← moved"), true));
        } else if let Some(k) = most_similar(line, &unpaired) {
            let was = unpaired.remove(k);
            out.push((format!("{line}   ← was: {was}"), true));
        } else {
            out.push((format!("{line}   ← new"), true));
        }
    }
    for line in unpaired {
        out.push((format!("(removed) {line}"), true));
    }
    let mut lines = if out.len() > MAX_DIFF_LINES {
        around_changes(&out)
    } else {
        out.into_iter().map(|(l, _)| l).collect()
    };
    if lines.len() > MAX_DIFF_LINES {
        let more = lines.len() - MAX_DIFF_LINES;
        lines.truncate(MAX_DIFF_LINES);
        lines.push(format!("… +{more} more lines"));
    }
    if cut {
        lines.push(format!(
            "… longer than {MAX_DIFF_INPUT_LINES} lines: the rest is not compared"
        ));
    }
    lines.join("\n")
}

/// The marked lines with one line of context each; every run of unchanged
/// lines between them reads as one `…`.
fn around_changes(out: &[(String, bool)]) -> Vec<String> {
    let near = |i: usize| {
        out[i.saturating_sub(1)..(i + 2).min(out.len())]
            .iter()
            .any(|(_, marked)| *marked)
    };
    let mut lines = Vec::new();
    let mut skipped = false;
    for (i, (line, _)) in out.iter().enumerate() {
        if near(i) {
            lines.push(line.clone());
            skipped = false;
        } else if !skipped {
            lines.push("…".to_string());
            skipped = true;
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary_with(shape: CurrentShape) -> ApprovalSummary {
        let mut s = ApprovalSummary::new("Update Deal");
        s.push("Endpoint", "/crm/v3/objects/deals/1");
        s.push("Properties › Amount", "500");
        s.change = Some(ChangeHint {
            read_path: "/crm/v3/objects/deals/1".into(),
            shape,
        });
        s
    }

    fn rows(s: &ApprovalSummary) -> Vec<(&str, &str)> {
        s.details
            .iter()
            .map(|d| (d.label.as_str(), d.value.as_str()))
            .collect()
    }

    fn diff(new: Value, old: Value, partial: bool) -> Option<Vec<(String, String)>> {
        changed_rows(&new, &old, partial)
            .map(|r| r.into_iter().map(|d| (d.label, d.value)).collect())
    }

    #[test]
    fn a_patch_shows_old_to_new_and_counts_the_rest() {
        let mut s = summary_with(CurrentShape::Same);
        let body = br#"{"properties":{"amount":"500","stage":"won"}}"#;
        let current = br#"{"id":"1","properties":{"amount":"300","stage":"won","name":"Big"}}"#;
        s.apply_current(body, current);
        assert_eq!(
            rows(&s),
            [
                ("Endpoint", "/crm/v3/objects/deals/1"),
                ("Properties › Amount", "300 → 500"),
                ("Unchanged", "1 other setting stays as it is"),
            ]
        );
        assert!(s.change_hint().is_none());
    }

    #[test]
    fn a_changed_secret_says_so_without_showing_it() {
        let r = diff(
            json!({"auth": {"api_key": "new-secret"}, "x": {"y": 1}}),
            json!({"auth": {"api_key": "old-secret"}, "x": {"y": 1}}),
            true,
        )
        .unwrap();
        assert_eq!(
            r[0],
            ("Auth › Api key".into(), "changes (value hidden)".into())
        );
        let all = format!("{r:?}");
        assert!(
            !all.contains("new-secret") && !all.contains("old-secret"),
            "{all}"
        );
        // The same secret is the same value.
        assert!(diff(
            json!({"api_key": "k", "n": 2}),
            json!({"api_key": "k", "n": 2}),
            true
        )
        .is_none());
    }

    #[test]
    fn a_change_past_what_the_card_shows_still_shows() {
        let head = "the same words again ".repeat(100);
        let r = diff(
            json!({ "title": format!("{head}NEW") }),
            json!({ "title": format!("{head}old") }),
            true,
        )
        .unwrap();
        assert!(
            r[0].1.contains("NEW") && r[0].1.contains("old"),
            "{:?}",
            r[0]
        );
        assert!(r[0].1.starts_with('…'), "{:?}", r[0]);
        // A blob too big to show still reads as changed.
        let blob = |c: &str| json!({ "file": c.repeat(400) });
        assert!(diff(blob("A"), blob("B"), true).is_some());
    }

    #[test]
    fn a_side_too_big_to_read_whole_gets_no_comparison() {
        let wide: serde_json::Map<String, Value> =
            (0..3_000).map(|i| (format!("k{i}"), json!(i))).collect();
        let mut changed = wide.clone();
        changed.insert("k1".into(), json!("x"));
        assert!(diff(Value::Object(changed), Value::Object(wide), true).is_none());
    }

    #[test]
    fn a_partial_read_never_calls_a_field_new_and_must_answer_something() {
        // HubSpot answers its default properties only.
        let r = diff(
            json!({"properties": {"amount": "5000", "hs_next_step": "Send contract"}}),
            json!({"properties": {"amount": "3000", "dealname": "Acme"}}),
            true,
        )
        .unwrap();
        assert_eq!(
            r,
            [
                ("Properties › Amount".into(), "3000 → 5000".into()),
                ("Properties › Hs next step".into(), "Send contract".into()),
            ]
        );
        // An answer that shares nothing with the body is not its record.
        assert!(diff(json!({"a": 1}), json!({"b": 2}), true).is_none());
    }

    #[test]
    fn unset_values_and_spelled_out_defaults_are_not_changes() {
        let new = json!({"call": {"offset": 0, "auto": false, "label": "x"}});
        let old = json!({"call": {"label": "x", "note": null, "on": false}});
        assert!(diff(new, old.clone(), false).is_none());
        let r = diff(json!({"call": {"offset": 5, "label": "x"}}), old, false).unwrap();
        assert_eq!(r[0].1, "(new) 5");
        // A text the read answers as null reads as set, not as a removal.
        let r = diff(
            json!({"body": "one\ntwo"}),
            json!({"body": null, "n": 1}),
            true,
        );
        assert!(r.is_none(), "nothing compared: {r:?}");
    }

    #[test]
    fn values_that_share_a_label_compare_in_order() {
        let r = diff(
            json!({"tags": [{"n": "a"}, {"n": "b"}]}),
            json!({"tags": [{"n": "a"}, {"n": "c"}]}),
            true,
        )
        .unwrap();
        assert_eq!(r[0].1, "c → b");
    }

    #[test]
    fn two_changes_that_would_read_alike_keep_their_whole_label() {
        let r = diff(
            json!({"a": {"x": {"name": 1}}, "b": {"x": {"name": 2}}}),
            json!({"a": {"x": {"name": 0}}, "b": {"x": {"name": 0}}}),
            true,
        )
        .unwrap();
        assert_eq!(r[0].0, "A › X › Name");
        assert_eq!(r[1].0, "B › X › Name");
    }

    #[test]
    fn record_rows_keep_their_place_and_their_link() {
        let mut s = ApprovalSummary::new("Update Contact");
        s.push("Endpoint", "/x/1");
        s.push("Note", "old");
        s.push_record("Account", "Account", "001AA000000AbCdEFG");
        s.push("Title", "Boss");
        s.change = Some(ChangeHint {
            read_path: "/x/1".into(),
            shape: CurrentShape::Same,
        });
        s.apply_current(
            br#"{"title":"Boss","note":"new"}"#,
            br#"{"title":"Boss","note":"old"}"#,
        );
        let r = &s.refs[0];
        assert_eq!(s.details[r.detail_index].label, "Account");
        assert!(s.details.iter().any(|d| d.value == "old → new"));
    }

    #[test]
    fn provider_context_stays_ahead_of_comparison_without_keeping_stale_body_rows() {
        let mut s = ApprovalSummary::new("Update record");
        s.push("Safety context", "Provider warning, not a compared field");
        s.push("Endpoint", "/x/1");
        s.push("Title", "Same title");
        s.push_record("Account", "Account", "001AA000000AbCdEFG");
        s.fallback = Some(3..4);
        s.change = Some(ChangeHint {
            read_path: "/x/1".into(),
            shape: CurrentShape::Same,
        });
        s.apply_current(
            br#"{"title":"Same title","note":"new"}"#,
            br#"{"title":"Same title","note":"old"}"#,
        );
        assert_eq!(s.details[0].label, "Safety context");
        assert_eq!(s.details[1].label, "Endpoint");
        assert!(s.details.iter().any(|d| d.value == "old → new"));
        assert!(!s.details.iter().any(|d| d.label == "Title"));
        let index = s.refs[0].detail_index;
        assert_eq!(s.details[index].label, "Account");
        assert_eq!(s.fallback, Some(index..index + 1));
    }

    #[test]
    fn an_unreadable_answer_keeps_the_card() {
        let mut s = summary_with(CurrentShape::Same);
        let before = s.details.clone();
        s.apply_current(b"{\"a\":{\"b\":1}}", b"<html>");
        assert_eq!(s.details, before);
        for current in [
            &br#"{"records":[]}"#[..],
            br#"{"records":[{"Metadata":{}},{"Metadata":{}}]}"#,
        ] {
            s.change = Some(ChangeHint {
                read_path: "/x".into(),
                shape: CurrentShape::SalesforceFlowQuery,
            });
            s.apply_current(b"{\"Metadata\":{\"a\":1}}", current);
            assert_eq!(s.details, before);
        }
    }

    #[test]
    fn text_changes_read_as_a_line_diff() {
        let d = line_diff(
            "*T*\n*Lead:* x\n*Dept:* y\n*Desc:* z",
            "*T*\n*Dept:* y\n*Desc:* z\n*Lead:* x",
        );
        assert_eq!(d, "*T*\n*Dept:* y\n*Desc:* z\n*Lead:* x   ← moved");
        assert_eq!(
            line_diff("a\nb\nc", "a\nB\nc"),
            "a\nB   ← new\nc\n(removed) b"
        );
        // An edited line reads next to what it replaces; nothing pairs with
        // a line it shares no words with.
        assert_eq!(
            line_diff(
                "*Name:* {!$Record.FirstName}\n*Old:* x",
                "*Contact:* {!$Record.FirstName}\n*Fresh:* y"
            ),
            "*Contact:* {!$Record.FirstName}   ← was: *Name:* {!$Record.FirstName}\n*Fresh:* y   ← new\n(removed) *Old:* x"
        );
    }

    #[test]
    fn a_long_text_keeps_every_change_in_view() {
        let old: Vec<String> = (0..60).map(|i| format!("line {i}")).collect();
        let mut new = old.clone();
        new[45] = "line forty-five, edited".into();
        let d = line_diff(&old.join("\n"), &new.join("\n"));
        assert!(
            d.contains("line forty-five, edited   ← was: line 45"),
            "{d}"
        );
        assert!(d.lines().count() <= MAX_DIFF_LINES + 1, "{d}");
        assert!(d.starts_with('…'), "{d}");
        // Past the lines it reads, it says so.
        let long: Vec<String> = (0..250).map(|i| format!("l{i}")).collect();
        let mut edited = long.clone();
        edited[240] = "changed".into();
        let d = line_diff(&long.join("\n"), &edited.join("\n"));
        assert!(d.ends_with("the rest is not compared"), "{d}");
    }

    #[test]
    fn only_plain_paths_are_read_back() {
        assert!(safe_path("/crm/v3/objects/deals/123"));
        for bad in [
            "/a/../b",
            "/a/%2e%2e/b",
            "/a?x=1",
            "//evil.com/x",
            "/a/b c",
            "rel/path",
        ] {
            assert!(!safe_path(bad), "{bad}");
        }
        let body = json!({"a": {"b": 1}});
        assert!(ChangeHint::same_path("POST", "/x/1", &body).is_none());
        assert!(ChangeHint::same_path("PATCH", "/x/1", &body).is_some());
    }
}
