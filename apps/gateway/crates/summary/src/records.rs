//! Records a card names by id, and the per-provider seam that resolves them.
//!
//! A summarizer that shows a record id (Salesforce `AccountId: 001…`)
//! registers the row as a [`RecordRef`] and may mark the record the action is
//! about as the card's [`Target`]. Before the card is stored, the gateway may
//! link each such row to its record and swap the id for the record's name,
//! through the provider's [`RecordResolver`]; [`ApprovalSummary::finalize_title`]
//! then folds the target into the title ("Update Contact Dana Reyes"). A record
//! the gateway could not name keeps its id.
//!
//! Resolvers are pure, like summarizers: they build the name read and parse
//! its answer. The I/O and every guard around it (policy probe, credential,
//! budget, cache) live in the gateway's `proxy::approval_enrich`.

use serde::{Deserialize, Serialize};

use super::{clamp, ApprovalSummary, MAX_VALUE_LEN};

/// A provider whose cards name records by id. Implement on the provider's
/// summarizer struct and register it in [`super::record_resolver`].
pub trait RecordResolver: Sync {
    /// The object type `id` names, decided by the id itself (never by request
    /// text). `None`: the id is malformed or its type has no name lookup.
    fn object_of(&self, id: &str) -> Option<&'static str>;

    /// The read (path and query, on the connection's own host) that answers
    /// the display names of `ids`, all of type `object`.
    fn names_read(&self, object: &str, ids: &[&str]) -> String;

    /// `(id, name)` pairs from the answer to [`names_read`](Self::names_read)
    /// for `object`. An answer it can't parse yields none.
    fn parse_names(&self, object: &str, body: &[u8]) -> Vec<(String, String)>;

    /// The record's page on the connection's `host` (https). `None` for an id
    /// it can't link.
    fn record_url(&self, host: &str, id: &str) -> Option<String>;

    /// The spelling every reference to one record shares, so a name answered
    /// for one spelling resolves the other.
    fn canonical_id<'a>(&self, id: &'a str) -> &'a str {
        id
    }

    /// The read that answers, for a bulk change, each record's name, the
    /// CURRENT value of every field in `fields` (none: names only), and
    /// every `context` column (from [`context_fields`](Self::context_fields)).
    /// `None` when this provider can't build one safely (the card then shows
    /// new values only).
    fn current_values_read(
        &self,
        _object: &str,
        _fields: &[&str],
        _context: &[&str],
        _ids: &[&str],
    ) -> Option<String> {
        None
    }

    /// What the answer to [`current_values_read`](Self::current_values_read)
    /// for `object` says of each record.
    fn parse_current_values(
        &self,
        _object: &str,
        _body: &[u8],
        _fields: &[&str],
        _context: &[&str],
    ) -> Vec<CurrentRecord> {
        Vec::new()
    }

    /// Read-only columns a bulk card of `object` shows beside the changes so
    /// a reviewer can tell WHICH record each row is (a contact's account and
    /// title). Fixed per object, never from the request. A column the change
    /// itself covers is left off: a field in `changed` is already a change
    /// column, and a column read through a lookup in `changed` would show
    /// the old record beside the new one.
    fn context_fields(&self, _object: &str, _changed: &[&str]) -> Vec<ContextField> {
        Vec::new()
    }
}

/// A read-only column on a bulk card: its read path (`Account.Name`) and
/// label (`Account`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextField {
    pub api: &'static str,
    pub label: &'static str,
}

/// One record of a bulk change's current-values read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentRecord {
    pub id: String,
    pub name: Option<String>,
    /// Value now per changed field, aligned with the read's `fields`.
    pub values: Vec<Option<String>>,
    /// Value per context column, aligned with the read's `context`.
    pub context: Vec<Option<String>>,
}

/// A detail row that names a record by id.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RecordRef {
    /// Index into [`ApprovalSummary::details`] of the row naming it.
    pub(crate) detail_index: usize,
    /// Provider object type, e.g. Salesforce `"Account"`.
    pub(crate) object: String,
    /// The record id as the request carries it.
    pub(crate) id: String,
    /// Its display name, once the gateway resolved it.
    pub(crate) name: Option<String>,
    /// How its row reads once named.
    pub(crate) named: Named,
}

/// How a record row reads once the gateway has named its record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Named {
    /// `Initech (001QO…)`: the id keeps two same-named records apart, which
    /// a card leading with its record relies on (two `Plan.docx` deleted in
    /// one batch must not read as one file).
    WithId,
    /// The name alone, for a record its name already identifies and no
    /// title leads with: the person behind a Drive permission, shown with
    /// their email.
    Alone,
}

/// The record an action is about, and how the title joins it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Target {
    /// The record's id; its [`RecordRef`] carries the row and the name.
    pub(crate) id: String,
    /// `" "` (Update Contact Dana Reyes), `" to "` (Upload file to Account
    /// Acme), `" in "` (Create Contact in Account Acme).
    pub(crate) join: &'static str,
    /// The record's type, repeated in the title when the action names a
    /// different one ("Upload file to Account Acme").
    pub(crate) with_type: Option<String>,
}

impl Target {
    pub(crate) fn of(id: &str, join: &'static str, with_type: Option<String>) -> Self {
        Self {
            id: id.to_string(),
            join,
            with_type,
        }
    }
}

/// The title split around the record it names, so a card can make the record
/// the link: `lead + record == action`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Subject {
    /// The action without its record ("Create Contact", "Upload file"), so
    /// cards can group per-record titles under one action. Defaulted for
    /// approvals stored before it existed.
    #[serde(default)]
    pub verb: String,
    /// "Upload file to ", "Update Contact ".
    pub lead: String,
    /// "Account OneCLI Demo Acme Robotics", "Dana Reyes".
    pub record: String,
    /// Index into `details` of the row naming the record, so a card that
    /// shows the subject can drop the row that only repeats it.
    pub row: usize,
    /// The record's page: gateway-built, https only (same rule as
    /// [`super::ApprovalDetail::url`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl ApprovalSummary {
    /// The ids of every record the card names.
    pub fn ref_ids(&self) -> impl Iterator<Item = &str> {
        self.refs.iter().map(|r| r.id.as_str())
    }

    /// Make each record row open its record: `url_of(id)` is the provider's
    /// page for it, built by the gateway (never request text).
    pub fn link_refs(&mut self, url_of: impl Fn(&str) -> Option<String>) {
        for r in &self.refs {
            if let Some(d) = self.details.get_mut(r.detail_index) {
                d.url = url_of(&r.id);
            }
        }
    }

    /// Show each resolved record by name, as its row says ([`Named`]).
    pub fn name_refs<'n>(&mut self, name_of: impl Fn(&str) -> Option<&'n str>) {
        for r in &mut self.refs {
            let Some(name) = name_of(&r.id).map(str::trim).filter(|n| !n.is_empty()) else {
                continue;
            };
            if let Some(d) = self.details.get_mut(r.detail_index) {
                d.value = match r.named {
                    Named::WithId => clamp(&format!("{name} ({})", r.id), MAX_VALUE_LEN),
                    Named::Alone => clamp(name, MAX_VALUE_LEN),
                };
            }
            r.name = Some(clamp(name, MAX_VALUE_LEN));
        }
    }

    /// The change table names the records its values point at, as the
    /// detail rows do: a lookup set to a record id reads "Alex Kim (005…)".
    /// Runs once each cell's op is set, so ops still compare ids, never a
    /// name against an id.
    pub fn name_change_values(&mut self) {
        let Self { refs, bulk, .. } = self;
        let Some(bulk) = bulk.as_mut() else { return };
        for r in refs.iter() {
            let Some(name) = r.name.as_deref() else {
                continue;
            };
            let shown = clamp(&format!("{name} ({})", r.id), MAX_VALUE_LEN);
            for row in &mut bulk.rows {
                for v in row.new.iter_mut().chain(row.old.iter_mut()).flatten() {
                    if *v == r.id {
                        v.clone_from(&shown);
                    }
                }
            }
        }
    }

    /// Fold the target record into the title, once names are resolved:
    /// "Update Contact" becomes "Update Contact Dana Reyes", "Upload file"
    /// becomes "Upload file to Account Acme Robotics". An unnamed record
    /// shows its id, so the title always says WHICH one. Bounded to
    /// [`MAX_VALUE_LEN`]; runs once (the target is consumed).
    pub fn finalize_title(&mut self) {
        let Some(t) = self.target.take() else { return };
        let Some(r) = self.refs.iter().find(|r| r.id == t.id) else {
            return;
        };
        let name = r.name.as_deref().unwrap_or(&r.id);
        let typed = match &t.with_type {
            Some(ty) => format!("{ty} {name}"),
            None => name.to_string(),
        };
        let lead = format!("{}{}", self.action, t.join);
        let room = MAX_VALUE_LEN.saturating_sub(lead.chars().count()).max(1);
        let record = clamp(&typed, room);
        let verb = std::mem::replace(&mut self.action, format!("{lead}{record}"));
        self.subject = Some(Subject {
            verb,
            lead,
            record,
            row: r.detail_index,
            url: self.details.get(r.detail_index).and_then(|d| d.url.clone()),
        });
    }
}
