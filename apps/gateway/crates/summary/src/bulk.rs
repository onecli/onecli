//! A change to records, as a table: one request that creates, updates or
//! deletes one record or a whole list (Salesforce `/sobjects/…`, sObject
//! Collections `/composite/sobjects`, and a Composite call that only
//! updates records). One request means one approval, so the card shows
//! every record: what each field holds now, what it becomes, and what kind
//! of change that is ([`CellOp`]).
//!
//! The summarizer fills each row's `id` and `new` values from the request.
//! The gateway then fills `name`, `old` and the read-only `context` columns
//! from one read of the records, held to the agent's own read permission
//! (see `proxy::approval_enrich`), and sets each cell's `op` from the two.

use serde::{Deserialize, Serialize};

/// Most records one bulk card carries (Salesforce's own cap per sObject
/// Collections call).
pub const MAX_BULK_ROWS: usize = 200;
/// Most fields a bulk card shows as columns. A request setting more still
/// gets the card: the first ones are shown and the rest are named in a note
/// (`BulkChange::hidden_fields`), never dropped silently.
pub const MAX_BULK_FIELDS: usize = 40;

/// The whole list a bulk request changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkChange {
    /// What the request does to every record in the list.
    #[serde(default)]
    pub kind: BulkKind,
    /// The records' type, as an API name (`Contact`).
    pub object: String,
    /// The type as a human label (`Contact`, `Deposit batch`).
    pub object_label: String,
    /// The fields the request sets, in body order: `(api name, label)`.
    pub fields: Vec<BulkField>,
    /// One row per record, in body order.
    pub rows: Vec<BulkRow>,
    /// The records' current values were read, so `old` and each cell's
    /// `op` mean something. `false`: the card shows new values only.
    #[serde(default)]
    pub old_values_read: bool,
    /// Fields the request also sets that the table leaves out (past
    /// [`MAX_BULK_FIELDS`]), as labels, in body order. The card names them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_fields: Vec<String>,
    /// Read-only columns that say WHICH record each row is (a contact's
    /// account and title), so the reviewer can tell the right people are
    /// being changed. Never changed by the request, never counted: values
    /// per row in [`BulkRow::context`]. Empty when they weren't read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<BulkField>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BulkField {
    pub api: String,
    pub label: String,
}

/// What a bulk request does to its records.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BulkKind {
    /// Sets `fields` on existing records: `new` per field, `old` read.
    #[default]
    Update,
    /// New records: `new` is each record's values, there is no `old`, and a
    /// row's `id` is only its place in the list.
    Create,
    /// Existing records removed: `old` is what they hold now (read for the
    /// card), `new` is empty.
    Delete,
}

/// One record in the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkRow {
    pub id: String,
    /// The record's name, when the gateway could read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The record's page (gateway-built, https only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// New value per field, aligned with `BulkChange::fields`. `None`: the
    /// row doesn't set that field.
    pub new: Vec<Option<String>>,
    /// Current value per field, aligned with `fields`, when read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub old: Vec<Option<String>>,
    /// What happens to each field, aligned with `fields` (set once current
    /// values are known; `Fill` for every set field when they aren't).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ops: Vec<CellOp>,
    /// The row's strongest op, for its color and sort: clear > overwrite >
    /// fill > same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<CellOp>,
    /// Value per [`BulkChange::context`] column, aligned with it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<Option<String>>,
}

/// What a change does to one field of one record. Drives the card's colors
/// (the same on every surface): clear red, overwrite blue, fill green, same
/// gray.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CellOp {
    /// Not changed by this request (the row doesn't set the field).
    Untouched,
    /// The value stays what it is now.
    Same,
    /// An empty field gets a value.
    Fill,
    /// An existing value is replaced by a different one.
    Overwrite,
    /// An existing value is cleared.
    Clear,
}

impl CellOp {
    /// How much a reviewer should look at it (higher = sooner).
    fn weight(self) -> u8 {
        match self {
            Self::Clear => 4,
            Self::Overwrite => 3,
            Self::Fill => 2,
            Self::Same => 1,
            Self::Untouched => 0,
        }
    }

    /// `old` is `None` when current values weren't read.
    fn of(old: Option<Option<&str>>, new: Option<&str>) -> Self {
        let empty = |v: Option<&str>| v.is_none_or(|s| s.trim().is_empty());
        let Some(new) = new else {
            return Self::Untouched;
        };
        match old {
            None => {
                if empty(Some(new)) {
                    Self::Clear
                } else {
                    Self::Fill
                }
            }
            Some(old) => match (empty(old), empty(Some(new))) {
                (true, true) => Self::Same,
                (true, false) => Self::Fill,
                (false, true) => Self::Clear,
                (false, false) if old == Some(new) => Self::Same,
                (false, false) => Self::Overwrite,
            },
        }
    }
}

impl BulkChange {
    /// Record the current values read for the rows: `current(id, field)`
    /// answers a field's value now (`None` when empty or not read). Sets
    /// each cell's op and each row's strongest op, and sorts the rows a
    /// reviewer must look at first (clear, overwrite, fill, same).
    pub fn apply_current(&mut self, current: impl Fn(&str, &str) -> Option<Option<String>>) {
        let mut any = false;
        for row in &mut self.rows {
            let mut old = Vec::with_capacity(self.fields.len());
            for field in &self.fields {
                let now = current(&row.id, &field.api);
                any |= now.is_some();
                old.push(now);
            }
            row.ops = self
                .fields
                .iter()
                .enumerate()
                .map(|(i, _)| {
                    let new = row.new.get(i).and_then(|v| v.as_deref());
                    CellOp::of(old[i].as_ref().map(|o| o.as_deref()), new)
                })
                .collect();
            row.old = old.into_iter().map(Option::flatten).collect();
            row.op = row.ops.iter().copied().max_by_key(|o| o.weight());
        }
        self.old_values_read = any;
        if !any {
            // Nothing was read: no claim about what is replaced.
            for row in &mut self.rows {
                row.old.clear();
            }
        }
        self.rows
            .sort_by_key(|r| std::cmp::Reverse(r.op.map_or(0, CellOp::weight)));
    }

    /// One line per distinct change ("Mailing country → Canada · 95"), most
    /// common first: the detail rows the approvals list previews. At most
    /// `max` lines.
    #[must_use]
    pub fn change_lines(&self, max: usize) -> Vec<(String, usize)> {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for row in &self.rows {
            let text = self
                .fields
                .iter()
                .zip(&row.new)
                .filter_map(|(f, v)| {
                    v.as_ref().map(|v| {
                        format!(
                            "{} → {}",
                            f.label,
                            if v.is_empty() { "(cleared)" } else { v }
                        )
                    })
                })
                .collect::<Vec<_>>()
                .join(" · ");
            match counts.iter_mut().find(|(t, _)| *t == text) {
                Some((_, n)) => *n += 1,
                None => counts.push((text, 1)),
            }
        }
        counts.sort_by_key(|c| std::cmp::Reverse(c.1));
        counts.truncate(max);
        counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(rows: &[(&str, &str)]) -> BulkChange {
        BulkChange {
            kind: BulkKind::Update,
            object: "Contact".into(),
            object_label: "Contact".into(),
            fields: vec![BulkField {
                api: "MailingCountry".into(),
                label: "Mailing country".into(),
            }],
            rows: rows
                .iter()
                .map(|(id, v)| BulkRow {
                    id: (*id).into(),
                    name: None,
                    url: None,
                    new: vec![Some((*v).into())],
                    old: Vec::new(),
                    ops: Vec::new(),
                    op: None,
                    context: Vec::new(),
                })
                .collect(),
            old_values_read: false,
            hidden_fields: Vec::new(),
            context: Vec::new(),
        }
    }

    #[test]
    fn overwrites_are_non_empty_values_that_change_and_come_first() {
        let mut c = change(&[("a", "Canada"), ("b", "Canada"), ("c", "Canada")]);
        c.apply_current(|id, _| match id {
            "a" => Some(None),                   // empty now: a fill
            "b" => Some(Some("Germany".into())), // replaced: overwrite
            "c" => Some(Some("Canada".into())),  // same value: no change
            _ => None,
        });
        assert!(c.old_values_read);
        assert_eq!(c.rows[0].id, "b", "overwrites lead");
        assert_eq!(c.rows[0].old, vec![Some("Germany".to_string())]);
        let op = |id: &str| c.rows.iter().find(|r| r.id == id).unwrap().op;
        assert_eq!(op("a"), Some(CellOp::Fill));
        assert_eq!(op("b"), Some(CellOp::Overwrite));
        assert_eq!(op("c"), Some(CellOp::Same));
        // Order: overwrite, fill, same.
        assert_eq!(
            c.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["b", "a", "c"]
        );
    }

    #[test]
    fn clearing_an_existing_value_is_a_clear_and_leads() {
        let mut c = change(&[("a", "Canada"), ("b", "")]);
        c.apply_current(|id, _| match id {
            "a" => Some(Some("Germany".into())),
            "b" => Some(Some("Israel".into())),
            _ => None,
        });
        assert_eq!(c.rows[0].id, "b");
        assert_eq!(c.rows[0].op, Some(CellOp::Clear));
        assert_eq!(c.rows[1].op, Some(CellOp::Overwrite));
    }

    #[test]
    fn nothing_read_means_no_overwrites_claimed() {
        let mut c = change(&[("a", "Canada")]);
        c.apply_current(|_, _| None);
        assert!(!c.old_values_read);
        assert!(c.rows[0].old.is_empty());
        assert_eq!(c.rows[0].op, Some(CellOp::Fill));
    }

    #[test]
    fn change_lines_group_identical_changes() {
        let c = change(&[("a", "Canada"), ("b", "Canada"), ("c", "United States")]);
        assert_eq!(
            c.change_lines(6),
            vec![
                ("Mailing country → Canada".to_string(), 2),
                ("Mailing country → United States".to_string(), 1)
            ]
        );
    }
}
