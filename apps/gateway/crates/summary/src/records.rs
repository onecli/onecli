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

    /// `(id, name)` pairs from the answer to [`names_read`](Self::names_read).
    /// An answer it can't parse yields none.
    fn parse_names(&self, body: &[u8]) -> Vec<(String, String)>;

    /// The record's page on the connection's `host` (https). `None` for an id
    /// it can't link.
    fn record_url(&self, host: &str, id: &str) -> Option<String>;

    /// The spelling every reference to one record shares, so a name answered
    /// for one spelling resolves the other.
    fn canonical_id<'a>(&self, id: &'a str) -> &'a str {
        id
    }
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

    /// Show each resolved record by name, keeping the id after it
    /// (`Initech (001QO…)`) so two same-named records stay apart.
    pub fn name_refs<'n>(&mut self, name_of: impl Fn(&str) -> Option<&'n str>) {
        for r in &mut self.refs {
            let Some(name) = name_of(&r.id).map(str::trim).filter(|n| !n.is_empty()) else {
                continue;
            };
            if let Some(d) = self.details.get_mut(r.detail_index) {
                d.value = clamp(&format!("{name} ({})", r.id), MAX_VALUE_LEN);
            }
            r.name = Some(clamp(name, MAX_VALUE_LEN));
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
