//! Salesforce REST: manual-approval summaries.
//!
//! Turns an sObject write (`POST/PATCH/DELETE /services/data/vXX/sobjects/…`)
//! into a readable card: "Create Contact", then the record's fields with
//! human labels (`LeadSource` → "Lead source", `Deposit_Batch__c` → "Deposit
//! batch"), the record's own name first. Lookup fields that hold a record id
//! (`AccountId`, `OwnerId`, a custom `SDR__c`, …) become record rows
//! (`Account · 001…`) that the gateway can show by name, through this
//! module's [`RecordResolver`].
//!
//! Registered as `"salesforce"` in [`super::summarizer`] and
//! [`super::record_resolver`].

use serde::Deserialize;
use serde_json::{Map, Value};

use super::bulk::{
    BulkChange, BulkField, BulkKind, BulkRow, CellOp, MAX_BULK_FIELDS, MAX_BULK_ROWS,
};
use super::redact::{is_sensitive_key, redact_string};
use super::{
    humanize_key, json_object, ApprovalSummary, ContextField, CurrentRecord, RecordResolver,
    SummaryRequest, Target,
};

pub(super) struct Salesforce;

/// The REST version of the name lookup (every supported org answers it).
const API_VERSION: &str = "v60.0";

impl super::RequestSummarizer for Salesforce {
    /// The card for the request as sent. A request whose `_HttpMethod` names
    /// another method never gets here: the gateway refuses it before any
    /// rule or card (`proxy::method_override`), so the request line is what
    /// Salesforce runs.
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        if let Some(s) = bulk_write(req)
            .or_else(|| bulk_delete(req))
            .or_else(|| composite_updates(req))
        {
            return Some(s);
        }
        let (object, rest) = sobject_path(req.base_path())?;
        let object_label = api_label(object);
        match (req.method_upper().as_str(), rest.as_slice()) {
            ("POST", []) if object == "ContentDocumentLink" => Some(attach_file(req)),
            ("POST", []) if object == "ContentVersion" => Some(upload_file(req)),
            ("POST", []) => {
                let mut s = ApprovalSummary::new(format!("Create {object_label}"));
                let standard_lookups = push_body_fields(&mut s, req);
                s.target = parent_target(&s, &standard_lookups, " in ");
                s.bulk = single_change(BulkKind::Create, object, None, req);
                Some(s)
            }
            // `/sobjects/{Type}/{id}`: an update of an existing record. The
            // record's own row goes first, before the body's fields.
            ("PATCH", [id]) if is_record_id(id) => {
                let mut s = ApprovalSummary::new(format!("Update {object_label}"));
                s.push_record(&object_label, object, id);
                s.target = Some(Target::of(id, " ", None));
                push_body_fields(&mut s, req);
                s.bulk = single_change(BulkKind::Update, object, Some(id), req);
                Some(s)
            }
            // `/sobjects/{Type}/{extIdField}/{value}`: an upsert by external id.
            ("PATCH", [field, value]) => {
                let mut s = ApprovalSummary::new(format!("Upsert {object_label}"));
                s.push(api_label(field), *value);
                push_body_fields(&mut s, req);
                Some(s)
            }
            ("DELETE", [id]) if is_record_id(id) => {
                let mut s = ApprovalSummary::new(format!("Delete {object_label}"));
                s.push_record(&object_label, object, id);
                s.target = Some(Target::of(id, " ", None));
                s.bulk = single_change(BulkKind::Delete, object, Some(id), req);
                Some(s)
            }
            // Anything else under /sobjects (describe, blobs, …) keeps the
            // generic rendering.
            _ => None,
        }
    }
}

impl RecordResolver for Salesforce {
    /// From the id's 3-char key prefix, for the standard objects worth naming
    /// on a card. Custom objects and rarer standard ones keep the raw id.
    fn object_of(&self, id: &str) -> Option<&'static str> {
        if !is_record_id(id) {
            return None;
        }
        Some(match &id[..3] {
            "001" => "Account",
            "003" => "Contact",
            "005" => "User",
            "006" => "Opportunity",
            "00Q" => "Lead",
            "500" => "Case",
            "701" => "Campaign",
            "00G" => "Group",
            "069" => "ContentDocument",
            "068" => "ContentVersion",
            _ => return None,
        })
    }

    /// `/services/data/v60.0/query?q=SELECT Id, <name field> FROM <Object>
    /// WHERE Id IN (…)`: the object comes from [`object_of`](Self::object_of)'s
    /// fixed table and every id is re-checked by [`is_record_id`]
    /// (alphanumerics only), so the SOQL is fully server-built.
    fn names_read(&self, object: &str, ids: &[&str]) -> String {
        let list = ids
            .iter()
            .filter(|id| is_record_id(id))
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",");
        let soql = format!(
            "SELECT Id, {} FROM {object} WHERE Id IN ({list})",
            name_field(object)
        );
        let q: String = form_urlencoded::byte_serialize(soql.as_bytes()).collect();
        format!("/services/data/{API_VERSION}/query?q={q}")
    }

    fn parse_names(&self, object: &str, body: &[u8]) -> Vec<(String, String)> {
        let name = name_field(object);
        query_records(body)
            .filter_map(|r| {
                let id = r.get("Id")?.as_str()?.to_string();
                Some((id, value_text(r.get(name)?)?))
            })
            .collect()
    }

    /// `https://<org host>/<id>`, which the org redirects to the record's
    /// Lightning page.
    fn record_url(&self, host: &str, id: &str) -> Option<String> {
        (!host.is_empty() && is_record_id(id)).then(|| format!("https://{host}/{id}"))
    }

    /// Salesforce answers 18-char ids; a request may carry the 15-char form
    /// of the same record, its first 15 chars. Runs on ids from the read's
    /// answer too, so anything that isn't an 18-char id is kept as is
    /// (`get` never splits a char).
    fn canonical_id<'a>(&self, id: &'a str) -> &'a str {
        id.get(..15).filter(|_| id.len() == 18).unwrap_or(id)
    }

    /// `SELECT Id, <name field>, <fields>, <context> FROM <object> WHERE Id
    /// IN (…)`, fully server-built: the object and every field must be plain
    /// API names (a context column may also be one relationship hop,
    /// `Account.Name`) and every id a well-formed record id, or no read is
    /// built at all. With no `fields` it reads the names alone (a delete of a
    /// type with no preview fields).
    fn current_values_read(
        &self,
        object: &str,
        fields: &[&str],
        context: &[&str],
        ids: &[&str],
    ) -> Option<String> {
        if !is_api_name(object)
            || !fields.iter().all(|f| is_api_name(f))
            || !context.iter().all(|f| is_field_path(f))
            || ids.is_empty()
            || !ids.iter().all(|id| is_record_id(id))
        {
            return None;
        }
        let name = name_field(object);
        let mut select = vec!["Id"];
        for f in std::iter::once(&name).chain(fields).chain(context) {
            if !select.contains(f) {
                select.push(f);
            }
        }
        let list = ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",");
        let soql = format!(
            "SELECT {} FROM {object} WHERE Id IN ({list})",
            select.join(", ")
        );
        let q: String = form_urlencoded::byte_serialize(soql.as_bytes()).collect();
        Some(format!("/services/data/{API_VERSION}/query?q={q}"))
    }

    fn parse_current_values(
        &self,
        object: &str,
        body: &[u8],
        fields: &[&str],
        context: &[&str],
    ) -> Vec<CurrentRecord> {
        let name = name_field(object);
        query_records(body)
            .filter_map(|r| {
                let id = r.get("Id")?.as_str()?.to_string();
                let values = fields
                    .iter()
                    .map(|f| r.get(*f).and_then(|v| shown_value(f, v)))
                    .collect();
                let context = context
                    .iter()
                    .map(|path| {
                        let (leaf, v) = field_at(&r, path)?;
                        shown_value(leaf, v)
                    })
                    .collect();
                Some(CurrentRecord {
                    id,
                    name: r.get(name).and_then(value_text),
                    values,
                    context,
                })
            })
            .collect()
    }

    /// What tells one record of a type from another at a glance, beyond its
    /// name: plain fields or one relationship hop, fixed here. Field names
    /// compare case-insensitively, as Salesforce reads them.
    fn context_fields(&self, object: &str, changed: &[&str]) -> Vec<ContextField> {
        let covered = |api: &str| {
            // `Account.Name` reads through the `AccountId` lookup.
            let lookup = api.split_once('.').map(|(rel, _)| format!("{rel}Id"));
            changed.iter().any(|f| {
                f.eq_ignore_ascii_case(api)
                    || lookup.as_deref().is_some_and(|l| f.eq_ignore_ascii_case(l))
            })
        };
        context_columns(object)
            .iter()
            .filter(|c| !covered(c.api))
            .copied()
            .collect()
    }
}

/// The context columns of `object`'s bulk card, before any is covered by
/// the change (see [`RecordResolver::context_fields`]).
fn context_columns(object: &str) -> &'static [ContextField] {
    const ACCOUNT: ContextField = ContextField {
        api: "Account.Name",
        label: "Account",
    };
    const TITLE: ContextField = ContextField {
        api: "Title",
        label: "Title",
    };
    match object {
        "Contact" => &[ACCOUNT, TITLE],
        "Lead" => &[
            ContextField {
                api: "Company",
                label: "Company",
            },
            TITLE,
        ],
        "Opportunity" => &[
            ACCOUNT,
            ContextField {
                api: "StageName",
                label: "Stage",
            },
        ],
        "Case" => &[
            ACCOUNT,
            ContextField {
                api: "Subject",
                label: "Subject",
            },
        ],
        "Account" => &[
            ContextField {
                api: "Type",
                label: "Type",
            },
            ContextField {
                api: "Owner.Name",
                label: "Owner",
            },
        ],
        _ => &[],
    }
}

/// `Account.Name` in a SOQL answer: `{"Account": {"Name": …}}` (the
/// relationship is `null` when the lookup is empty). The leaf's key and
/// value.
fn field_at<'a>(record: &'a Map<String, Value>, path: &'a str) -> Option<(&'a str, &'a Value)> {
    match path.split_once('.') {
        None => Some((path, record.get(path)?)),
        Some((rel, leaf)) => Some((leaf, record.get(rel)?.as_object()?.get(leaf)?)),
    }
}

/// A field a read may name: a plain API name, or one relationship hop
/// (`Account.Name`), each part a plain API name.
fn is_field_path(s: &str) -> bool {
    match s.split_once('.') {
        None => is_api_name(s),
        Some((rel, leaf)) => is_api_name(rel) && is_api_name(leaf),
    }
}

/// The field that names a record of `object`: `Name` for most, a number or
/// subject for the types that have no `Name` (a SOQL read of `Name` on a
/// Case fails outright).
fn name_field(object: &str) -> &'static str {
    match object {
        "ContentDocument" | "ContentVersion" => "Title",
        "Case" => "CaseNumber",
        "Contract" => "ContractNumber",
        "Order" => "OrderNumber",
        "Task" | "Event" => "Subject",
        "Solution" => "SolutionName",
        _ => "Name",
    }
}

/// The records of a SOQL query answer (none for an answer it can't parse).
fn query_records(body: &[u8]) -> impl Iterator<Item = Map<String, Value>> {
    #[derive(Deserialize)]
    struct QueryResponse {
        records: Vec<Map<String, Value>>,
    }
    serde_json::from_slice::<QueryResponse>(body)
        .map(|r| r.records)
        .unwrap_or_default()
        .into_iter()
}

/// A JSON value as text: `None` for `null`, booleans spelled out.
fn value_text(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => return None,
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "Yes" } else { "No" }.to_string(),
        other => other.to_string(),
    })
}

/// A field's value as a card may show it: `None` for an empty one, a
/// secret-named field's value masked, a long string or blob elided.
fn shown_value(key: &str, v: &Value) -> Option<String> {
    let text = value_text(v)?;
    Some(if is_sensitive_key(key) {
        "***".to_string()
    } else {
        redact_string(&text)
    })
}

/// The resource a REST path names under `/services/data/vXX/`, without its
/// query or a trailing slash (Salesforce documents both spellings):
/// `composite/sobjects` for sObject Collections, `composite` for the
/// Composite API.
fn data_resource(path: &str) -> Option<&str> {
    let base = path.split('?').next().unwrap_or(path).trim_end_matches('/');
    let (version, tail) = base.strip_prefix("/services/data/")?.split_once('/')?;
    version.starts_with('v').then_some(tail)
}

fn is_collections_path(path: &str) -> bool {
    data_resource(path) == Some("composite/sobjects")
}

fn is_composite_path(path: &str) -> bool {
    data_resource(path) == Some("composite")
}

/// A request that writes a whole list of records (an sObject Collections
/// update or create, or a Composite call), whose card reads its body whole.
pub(super) fn is_bulk_write(method: &str, path: &str) -> bool {
    match data_resource(path) {
        Some("composite/sobjects") => {
            method.eq_ignore_ascii_case("PATCH") || method.eq_ignore_ascii_case("POST")
        }
        Some("composite") => method.eq_ignore_ascii_case("POST"),
        _ => false,
    }
}

/// A request Salesforce answers with one outcome per record, as a 200 even
/// when every record failed: any sObject Collections write (a delete too)
/// or a Composite call. See `outcome::answers_per_record`.
pub(super) fn answers_per_record(method: &str, path: &str) -> bool {
    is_bulk_write(method, path)
        || (method.eq_ignore_ascii_case("DELETE") && is_collections_path(path))
}

/// Most subrequests one Composite call may carry (Salesforce's own cap):
/// a longer list is refused by Salesforce, so it never gets a table.
const MAX_COMPOSITE_SUBREQUESTS: usize = 25;

/// `POST /composite` whose every subrequest updates one record
/// (`{"method": "PATCH", "url": "/services/data/vXX/sobjects/<Type>/<id>",
/// "body": {<plain fields>}}`), all of ONE type: the same before → after
/// table as a collections update, each record showing only the fields it
/// sets. Agents reach for it to change different fields per record.
/// Anything the table can't state keeps the generic card: another method
/// (Salesforce reads `method` case-sensitively), a reference to an earlier
/// subrequest's answer (`@{ref.id}`, in the URL or a value), per-subrequest
/// headers, mixed types, or a record named twice.
fn composite_updates(req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
    if req.method_upper() != "POST" || !is_composite_path(req.path) {
        return None;
    }
    let body = json_object(req.body?)?;
    let subs = body.get("compositeRequest")?.as_array()?;
    if subs.is_empty() || subs.len() > MAX_COMPOSITE_SUBREQUESTS {
        return None;
    }
    let mut list = ListWrite::default();
    for sub in subs {
        let sub = sub.as_object()?;
        if sub.get("method")?.as_str()? != "PATCH"
            || sub.keys().any(|k| k.eq_ignore_ascii_case("httpHeaders"))
        {
            return None;
        }
        let (ty, rest) = sobject_path(sub.get("url")?.as_str()?)?;
        let [id] = rest.as_slice() else {
            return None;
        };
        let canonical = Salesforce.canonical_id(id);
        if !is_record_id(id)
            || list
                .records
                .iter()
                .any(|(listed, _)| Salesforce.canonical_id(listed) == canonical)
        {
            return None;
        }
        let fields = sub.get("body")?.as_object()?;
        if fields
            .values()
            .any(|v| v.as_str().is_some_and(|s| s.contains("@{")))
        {
            return None;
        }
        if list.push(ty, (*id).to_string(), fields)? == 0 {
            // A subrequest that sets nothing is no update the table can show.
            return None;
        }
    }
    list.into_summary(BulkKind::Update)
}

/// The records one list write changes, read in full and all of ONE type:
/// each row's id (an update) or place in the list (a create) with its plain
/// field values, and every field any of them sets, in body order. Shared by
/// sObject Collections and Composite, so both tables read alike.
#[derive(Default)]
struct ListWrite {
    object: Option<String>,
    fields: Vec<String>,
    records: Vec<(String, Map<String, Value>)>,
}

impl ListWrite {
    /// Add one record of type `ty`; how many fields it sets. `None` (the
    /// request keeps the generic card) on a second type, a field that isn't
    /// a plain API name, or a nested value.
    fn push(&mut self, ty: &str, id: String, record: &Map<String, Value>) -> Option<usize> {
        if !is_api_name(ty) || self.object.as_deref().is_some_and(|o| o != ty) {
            return None;
        }
        self.object.get_or_insert_with(|| ty.to_string());
        let mut values = Map::new();
        for (k, v) in record {
            if matches!(k.as_str(), "attributes" | "id" | "Id") {
                continue;
            }
            if !is_api_name(k) || matches!(v, Value::Object(_) | Value::Array(_)) {
                return None;
            }
            if !self.fields.contains(k) {
                self.fields.push(k.clone());
            }
            values.insert(k.clone(), v.clone());
        }
        let set = values.len();
        self.records.push((id, values));
        Some(set)
    }

    /// The card: "Update 3 Contacts" over the table of every record. Past
    /// the column cap it still shows the list: the record's name fields
    /// first (so every row stays recognizable), then body order; the rest
    /// are named in a note on the card, never dropped silently. `None` when
    /// no record sets a field.
    fn into_summary(self, kind: BulkKind) -> Option<ApprovalSummary> {
        let Self {
            object,
            mut fields,
            records,
        } = self;
        if fields.is_empty() {
            return None;
        }
        let mut hidden: Vec<String> = Vec::new();
        if fields.len() > MAX_BULK_FIELDS {
            let is_name = |f: &String| matches!(f.as_str(), "Name" | "FirstName" | "LastName");
            let (names, rest): (Vec<String>, Vec<String>) = fields.into_iter().partition(is_name);
            fields = names.into_iter().chain(rest).collect();
            hidden = fields.split_off(MAX_BULK_FIELDS);
        }
        let rows = records
            .into_iter()
            .map(|(id, values)| record_row(kind, id, &values, &fields))
            .collect::<Vec<_>>();
        let count = rows.len();
        let verb = if kind == BulkKind::Create {
            "Create"
        } else {
            "Update"
        };
        let change = change_of(kind, object?, fields, rows, &hidden);
        let mut s = ApprovalSummary::new(format!(
            "{verb} {count} {}",
            plural(&change.object_label, count)
        ));
        // Text-only consumers: the distinct changes, as rows (an update only;
        // a create's values are per record, not one change).
        if kind == BulkKind::Update {
            for (line, n) in change.change_lines(6) {
                s.push("Change", format!("{line} · {n} {}", plural("record", n)));
            }
        }
        s.bulk = Some(change);
        Some(s)
    }
}

/// "Contacts", "Opportunities", "Deposit batches", or the label itself for
/// one. Same rule as the cards' `pluralLabel` (`@onecli/api`).
fn plural(label: &str, count: usize) -> String {
    if count == 1 {
        return label.to_string();
    }
    let lower = label.to_ascii_lowercase();
    let consonant_y = lower.ends_with('y')
        && !matches!(
            lower.chars().rev().nth(1),
            Some('a' | 'e' | 'i' | 'o' | 'u')
        );
    if consonant_y {
        format!("{}ies", &label[..label.len() - 1])
    } else if ["s", "x", "z", "ch", "sh"]
        .iter()
        .any(|e| lower.ends_with(e))
    {
        format!("{label}es")
    } else {
        format!("{label}s")
    }
}

/// sObject Collections write: `PATCH` updates up to 200 records, `POST`
/// creates up to 200 (`{"allOrNone": …, "records": [{"attributes":
/// {"type": …}, ["id": …,] <fields>}, …]}`). The card must show EVERY
/// record, so it reads as a bulk change only when the whole body was read
/// and every record is well-formed (see [`ListWrite::push`]), with, for an
/// update, a record id (a create carries none). Anything else (a truncated
/// body, mixed types, nested values) falls back to the generic card, which
/// never claims to have summarized what it couldn't read. Too many fields
/// is no fallback: the table shows the first [`MAX_BULK_FIELDS`] and names
/// the rest.
fn bulk_write(req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
    let kind = match req.method_upper().as_str() {
        "PATCH" => BulkKind::Update,
        "POST" => BulkKind::Create,
        _ => return None,
    };
    if !is_collections_path(req.path) {
        return None;
    }
    let body = json_object(req.body?)?;
    let records = body.get("records")?.as_array()?;
    if records.is_empty() || records.len() > MAX_BULK_ROWS {
        return None;
    }
    let mut list = ListWrite::default();
    for (n, record) in records.iter().enumerate() {
        let rec = record.as_object()?;
        let ty = rec.get("attributes")?.get("type")?.as_str()?;
        let given = rec.get("id").or_else(|| rec.get("Id"));
        let id = match kind {
            BulkKind::Update => given?.as_str().filter(|id| is_record_id(id))?.to_string(),
            // A create names no record yet (an id would make it an update):
            // the row is its place in the list.
            _ if given.is_some() => return None,
            _ => (n + 1).to_string(),
        };
        list.push(ty, id, rec)?;
    }
    list.into_summary(kind)
}

/// One record of a change as a table row: its new value per field (aligned
/// with `fields`; a `null` is an empty value, a clear). A new record is all
/// fills and is named by what it will be called; a deleted one is a clear
/// (its current values are read later); an update's ops come from its
/// current values, read later.
fn record_row(
    kind: BulkKind,
    id: String,
    values: &Map<String, Value>,
    fields: &[String],
) -> BulkRow {
    let new: Vec<Option<String>> = fields
        .iter()
        .map(|f| values.get(f).map(|v| shown_value(f, v).unwrap_or_default()))
        .collect();
    let (name, ops, op) = if kind == BulkKind::Create {
        let name_of = |k: &str| {
            values
                .get(k)
                .and_then(|v| shown_value(k, v))
                .filter(|s| !s.trim().is_empty())
        };
        let name = name_of("Name").or_else(|| {
            let full = ["FirstName", "LastName"]
                .iter()
                .filter_map(|k| name_of(k))
                .collect::<Vec<_>>()
                .join(" ");
            (!full.is_empty()).then_some(full)
        });
        let ops = new
            .iter()
            .map(|v| {
                if v.is_some() {
                    CellOp::Fill
                } else {
                    CellOp::Untouched
                }
            })
            .collect();
        (name, ops, Some(CellOp::Fill))
    } else if kind == BulkKind::Delete {
        // Every shown value of a deleted record is lost.
        (None, Vec::new(), Some(CellOp::Clear))
    } else {
        (None, Vec::new(), None)
    };
    BulkRow {
        id,
        name,
        url: None,
        new,
        old: Vec::new(),
        ops,
        op,
        context: Vec::new(),
    }
}

/// Where a field sits on a card: the record's name and how to reach it
/// first, the rest in body order (a stable sort keeps it). One order for
/// the detail rows and the change table, so both read alike.
fn field_rank(k: &str) -> u8 {
    match k {
        "Name" => 0,
        "Salutation" => 1,
        "FirstName" => 2,
        "LastName" => 3,
        "Email" => 4,
        "Phone" | "MobilePhone" => 5,
        "Title" => 6,
        _ => 10,
    }
}

/// A single-record write (`/sobjects/{Type}/` create, `/sobjects/{Type}/{id}`
/// update or delete) as a one-row change, so its card shows the same
/// colored table as a bulk one: what each field holds now and becomes (an
/// update), the new record (a create), or what goes (a delete). `None` when
/// the body can't be read in full as plain fields; the detail rows remain.
fn single_change(
    kind: BulkKind,
    object: &str,
    id: Option<&str>,
    req: &SummaryRequest<'_>,
) -> Option<BulkChange> {
    let (mut fields, mut row) = match kind {
        BulkKind::Delete => {
            let fields = delete_preview_fields(object)
                .iter()
                .map(|f| (*f).to_string())
                .collect();
            let row = record_row(kind, id?.to_string(), &Map::new(), &[]);
            (fields, row)
        }
        _ => {
            let body = json_object(req.body?)?;
            let mut fields: Vec<String> = Vec::new();
            for (k, v) in &body {
                if matches!(k.as_str(), "attributes" | "Id" | "id") {
                    continue;
                }
                if !is_api_name(k) || matches!(v, Value::Object(_) | Value::Array(_)) {
                    return None;
                }
                fields.push(k.clone());
            }
            if fields.is_empty() {
                return None;
            }
            // Name and contact fields first, as the detail rows read.
            fields.sort_by_key(|k| field_rank(k));
            let row_id = id.map_or_else(|| "1".to_string(), str::to_string);
            let row = record_row(kind, row_id, &body, &fields);
            (fields, row)
        }
    };
    let hidden = fields.split_off(fields.len().min(MAX_BULK_FIELDS));
    row.new.truncate(fields.len());
    row.ops.truncate(fields.len());
    Some(change_of(
        kind,
        object.to_string(),
        fields,
        vec![row],
        &hidden,
    ))
}

/// A change's table: its columns labeled from their API names, the fields
/// past the column cap named (as labels) in a note.
fn change_of(
    kind: BulkKind,
    object: String,
    fields: Vec<String>,
    rows: Vec<BulkRow>,
    hidden: &[String],
) -> BulkChange {
    BulkChange {
        kind,
        object_label: api_label(&object),
        object,
        fields: fields
            .into_iter()
            .map(|api| BulkField {
                label: api_label(&api),
                api,
            })
            .collect(),
        rows,
        old_values_read: false,
        hidden_fields: hidden.iter().map(|f| api_label(f)).collect(),
        context: Vec::new(),
    }
}

/// `DELETE /services/data/vXX/composite/sobjects?ids=<id>,<id>,…`: deletes
/// up to 200 records in one call. The ids are the whole request, so it
/// reads as a bulk delete only when every id is a well-formed record id and
/// they are all one object type (their key prefix). The gateway then reads
/// each record's name and a few fields so the card shows what goes.
fn bulk_delete(req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
    if req.method_upper() != "DELETE" || !is_collections_path(req.path) {
        return None;
    }
    let query = req.path.split_once('?')?.1;
    let mut ids: Vec<String> = Vec::new();
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        if k == "ids" {
            for id in v.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                if !is_record_id(id) {
                    return None;
                }
                if !ids.iter().any(|x| x == id) {
                    ids.push(id.to_string());
                }
            }
        }
    }
    if ids.is_empty() || ids.len() > MAX_BULK_ROWS {
        return None;
    }
    // One object type, from the ids' key prefix: a known one gets a label
    // and a field read; an unknown prefix keeps the generic card.
    let object = Salesforce.object_of(&ids[0])?;
    if ids
        .iter()
        .any(|id| Salesforce.object_of(id) != Some(object))
    {
        return None;
    }
    let count = ids.len();
    let fields: Vec<String> = delete_preview_fields(object)
        .iter()
        .map(|f| (*f).to_string())
        .collect();
    let rows = ids
        .into_iter()
        .map(|id| record_row(BulkKind::Delete, id, &Map::new(), &[]))
        .collect();
    let change = change_of(BulkKind::Delete, object.to_string(), fields, rows, &[]);
    let mut s = ApprovalSummary::new(format!(
        "Delete {count} {}",
        plural(&change.object_label, count)
    ));
    s.bulk = Some(change);
    Some(s)
}

/// What a delete card shows of each record, besides its name: enough to
/// recognize it, never a long description. Fixed per object (server-built).
fn delete_preview_fields(object: &str) -> &'static [&'static str] {
    match object {
        "Contact" | "Lead" => &["Title", "Email"],
        "Account" => &["Type", "Industry"],
        "Opportunity" => &["StageName", "Amount"],
        "Case" => &["Subject", "Status"],
        _ => &[],
    }
}

/// `ContentDocumentLink`: sharing an uploaded file with a record reads as
/// attaching it, with Salesforce's one-letter codes spelled out.
fn attach_file(req: &SummaryRequest<'_>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new("Attach file");
    push_body_fields(&mut s, req);
    s.target = s
        .refs
        .iter()
        .find(|r| r.object != "ContentDocument" && r.object != "ContentVersion")
        .map(|r| Target::of(&r.id, " to ", Some(api_label(&r.object))));
    for d in &mut s.details {
        d.label = match d.label.as_str() {
            "Content document" => "File".into(),
            "Linked entity" => "Attach to".into(),
            "Share type" => "Access".into(),
            other => other.into(),
        };
        let spelled = match (d.label.as_str(), d.value.as_str()) {
            ("Access", "V") => "Can view",
            ("Access", "C") => "Can edit",
            ("Access", "I") => "Same as the record",
            ("Visibility", "AllUsers") => "Everyone who can see the record",
            ("Visibility", "InternalUsers") => "Internal users only",
            ("Visibility", "SharedUsers") => "Users it's shared with",
            _ => continue,
        };
        d.value = spelled.into();
    }
    s
}

/// `ContentVersion`: a file upload reads as one: the file's name, where it
/// lands, and its size decoded from the base64 length (never the bytes).
/// Real uploads outgrow the gateway's body peek, so the JSON is usually cut
/// inside `VersionData`: the small string fields are then read from the
/// prefix, and the size reads "at least".
fn upload_file(req: &SummaryRequest<'_>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new("Upload file");
    let body = req.body.unwrap_or_default();
    let obj = json_object(body);
    let field = |k: &str| -> Option<String> {
        let v = match &obj {
            Some(o) => o.get(k).and_then(Value::as_str).map(str::to_string),
            None => prefix_string_field(body, k),
        };
        v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    };
    let title = field("Title");
    let path = field("PathOnClient");
    if let Some(name) = path.as_deref().or(title.as_deref()) {
        s.push("File", name);
    }
    // The Title only when it adds something: not the file name again, with
    // or without its extension ("DR Procedure" for "DR Procedure.pdf").
    if let (Some(title), Some(path)) = (&title, &path) {
        let stem = path.rsplit_once('.').map(|(stem, _)| stem);
        if title != path && Some(title.as_str()) != stem {
            s.push("Title", title);
        }
    }
    let parent =
        field("FirstPublishLocationId").and_then(|id| Some((Salesforce.object_of(&id)?, id)));
    if let Some((object, parent)) = parent {
        s.push_record("Attach to", object, &parent);
        s.target = Some(Target::of(&parent, " to ", Some(api_label(object))));
    } else if let Some(doc) =
        field("ContentDocumentId").filter(|id| Salesforce.object_of(id) == Some("ContentDocument"))
    {
        // A new VERSION of an existing file (Salesforce's "update a file"):
        // the file it replaces is the record the change lands on.
        s.push_record("Replaces", "ContentDocument", &doc);
        s.action = "Update file".into();
        s.target = Some(Target::of(&doc, " ", None));
    } else {
        // A bare upload: the record it's for comes in a later request.
        s.action = "Upload file (not attached to a record yet)".into();
    }
    let data_len = match &obj {
        Some(o) => o.get("VersionData").and_then(Value::as_str).map(str::len),
        None => prefix_open_string_len(body, "VersionData"),
    };
    if let Some(len) = data_len {
        let size = human_size(len / 4 * 3);
        s.push(
            "Size",
            if obj.is_some() {
                size
            } else {
                format!("at least {size}")
            },
        );
    }
    if s.details.is_empty() {
        push_body_fields(&mut s, req);
    }
    s
}

/// A create's parent record: the Account when there is one, else the first
/// record a standard lookup names (`standard_lookups`, indices into
/// `s.refs`). Owners (`User`) and groups are not a parent, and neither is a
/// custom lookup: a Contact with an `AE_Account__c` is still created in its
/// `AccountId`.
fn parent_target(
    s: &ApprovalSummary,
    standard_lookups: &[usize],
    join: &'static str,
) -> Option<Target> {
    let parents = || {
        standard_lookups
            .iter()
            .filter_map(|&i| s.refs.get(i))
            .filter(|r| !matches!(r.object.as_str(), "User" | "Group"))
    };
    let r = parents()
        .find(|r| r.object == "Account")
        .or_else(|| parents().next())?;
    Some(Target::of(&r.id, join, Some(api_label(&r.object))))
}

/// `(object, remaining segments)` for `/services/data/v{N}/sobjects/{Type}[/…]`.
/// A trailing slash is ignored (Salesforce accepts both spellings).
fn sobject_path(base: &str) -> Option<(&str, Vec<&str>)> {
    let rest = base.strip_prefix("/services/data/v")?;
    let (_version, rest) = rest.split_once('/')?;
    let rest = rest.strip_prefix("sobjects/")?;
    let mut segs = rest.split('/').filter(|s| !s.is_empty());
    let object = segs.next()?;
    if !is_api_name(object) {
        return None;
    }
    Some((object, segs.collect()))
}

/// The value of a top-level `"key": "…"` string in a (possibly truncated)
/// JSON prefix. Escapes are honored; `None` unless the string closes.
fn prefix_string_field(body: &[u8], key: &str) -> Option<String> {
    let start = value_start(body, key)?;
    let mut i = start;
    while i < body.len() {
        match body[i] {
            b'\\' => i += 2,
            b'"' => return serde_json::from_slice(&body[start - 1..=i]).ok(),
            _ => i += 1,
        }
    }
    None
}

/// How much of a top-level `"key": "…"` a truncated prefix holds (the
/// string need not close): a lower bound on the value's length.
fn prefix_open_string_len(body: &[u8], key: &str) -> Option<usize> {
    let rest = &body[value_start(body, key)?..];
    Some(rest.iter().position(|b| *b == b'"').unwrap_or(rest.len()))
}

/// Index just past the opening quote of a TOP-LEVEL `"key": "`: the key is
/// preceded (past whitespace) by `{` or `,`, so a `"Title"` quoted inside
/// some other field's text never matches.
fn value_start(body: &[u8], key: &str) -> Option<usize> {
    let needle = format!("\"{key}\"");
    let mut from = 0;
    let at = loop {
        let rel = body[from..]
            .windows(needle.len())
            .position(|w| w == needle.as_bytes())?;
        let at = from + rel;
        let before = body[..at].iter().rev().find(|b| !b.is_ascii_whitespace());
        if matches!(before, Some(b'{' | b',')) {
            break at;
        }
        from = at + 1;
    };
    let i = at
        + needle.len()
        + body[at + needle.len()..]
            .iter()
            .take_while(|b| b.is_ascii_whitespace() || **b == b':')
            .count();
    (body.get(i) == Some(&b'"')).then_some(i + 1)
}

fn human_size(bytes: usize) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{:.1} MB", b / KB / KB)
    }
}

/// Push the JSON body's fields: the record's name first, then contact points,
/// then the rest in body order. Nested objects/arrays (Salesforce's own
/// `attributes`, anything not a field write) are not paraphrased. Returns
/// which of the refs it pushed are standard (`…Id`) lookups, as indices
/// into `s.refs`, for [`parent_target`].
fn push_body_fields(s: &mut ApprovalSummary, req: &SummaryRequest<'_>) -> Vec<usize> {
    let mut standard_lookups = Vec::new();
    let Some(obj) = req.body.and_then(json_object) else {
        return standard_lookups;
    };
    let mut fields: Vec<(&String, &Value)> = obj
        .iter()
        .filter(|(_, v)| !matches!(v, Value::Object(_) | Value::Array(_)))
        .collect();
    fields.sort_by_key(|(k, _)| field_rank(k));
    s.push_fields(fields, |s, key, value| {
        let text = value_text(value).unwrap_or_else(|| "(cleared)".to_string());
        if is_sensitive_key(key) {
            s.push(api_label(key), "***");
        } else if let Some(object) = value.as_str().and_then(|id| lookup_object(key, id)) {
            if !key.ends_with("__c") {
                standard_lookups.push(s.refs.len());
            }
            // `OwnerId` reads "Owner", `SDR__c` reads "SDR".
            s.push_record(
                api_label(key.strip_suffix("Id").unwrap_or(key)),
                object,
                &text,
            );
        } else {
            s.push(api_label(key), redact_string(&text));
        }
    });
    standard_lookups
}

/// The sObject a lookup field points at: a field that can be a lookup (a
/// standard `…Id` other than the record's own `Id`, or a custom `…__c`,
/// since custom lookups like `SDR__c` carry no `Id` suffix) holding a
/// well-formed id of a known type. Never an external-id field. Ids arrive
/// as JSON strings, so a number never reaches this.
fn lookup_object(key: &str, value: &str) -> Option<&'static str> {
    let is_lookup_name = (key.ends_with("Id") && key != "Id") || key.ends_with("__c");
    if !is_lookup_name || key.to_ascii_lowercase().contains("external") {
        return None;
    }
    Salesforce.object_of(value)
}

/// A Salesforce record id: 15 or 18 alphanumerics.
fn is_record_id(s: &str) -> bool {
    matches!(s.len(), 15 | 18) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// A Salesforce API name (object or field): letters, digits, underscores.
fn is_api_name(s: &str) -> bool {
    s.len() <= 80
        && s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// An API name as a label: the `__c` / `__r` suffix and a managed package's
/// `ns__` namespace dropped, then humanized. `Deposit_Batch__c` → "Deposit
/// batch", `npo02__TotalOppAmount__c` → "Total opp amount".
fn api_label(api: &str) -> String {
    let base = api
        .strip_suffix("__c")
        .or_else(|| api.strip_suffix("__r"))
        .unwrap_or(api);
    humanize_key(base.rsplit("__").next().unwrap_or(base))
}

#[cfg(test)]
mod tests {
    use super::super::summarize_request;
    use super::*;

    fn sf(method: &str, path: &str, body: Option<&str>) -> ApprovalSummary {
        summarize_request(
            "salesforce",
            method,
            path,
            Some("application/json"),
            body.map(str::as_bytes),
        )
    }

    fn rows(s: &ApprovalSummary) -> Vec<(String, String)> {
        s.details
            .iter()
            .map(|d| (d.label.clone(), d.value.clone()))
            .collect()
    }

    fn row<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    fn titled(method: &str, path: &str, body: Option<&str>) -> ApprovalSummary {
        let mut s = sf(method, path, body);
        s.finalize_title();
        s
    }

    fn upload(body: &[u8]) -> ApprovalSummary {
        summarize_request(
            "salesforce",
            "POST",
            "/services/data/v59.0/sobjects/ContentVersion",
            Some("application/json"),
            Some(body),
        )
    }

    /// A typical Contact create: plain fields plus an account reference.
    #[test]
    fn create_contact_is_readable_and_names_its_account() {
        let body = r#"{"AccountId":"001QO000010eH0cYAF","Email":"jordan.rivera@initech.example","FirstName":"Jordan K","LastName":"Rivera","LeadSource":"Partner","Title":"Operations Lead"}"#;
        for path in [
            "/services/data/v59.0/sobjects/Contact",
            "/services/data/v59.0/sobjects/Contact/",
        ] {
            let s = sf("POST", path, Some(body));
            assert_eq!(s.action, "Create Contact", "{path}");
            assert_eq!(
                rows(&s),
                vec![
                    ("First name".into(), "Jordan K".into()),
                    ("Last name".into(), "Rivera".into()),
                    ("Email".into(), "jordan.rivera@initech.example".into()),
                    ("Title".into(), "Operations Lead".into()),
                    ("Account".into(), "Account · 001QO000010eH0cYAF".into()),
                    ("Lead source".into(), "Partner".into()),
                ],
                "{path}"
            );
            assert_eq!(s.ref_ids().collect::<Vec<_>>(), ["001QO000010eH0cYAF"]);
            assert_eq!(s.refs[0].object, "Account");
            assert_eq!(s.details[s.refs[0].detail_index].label, "Account");
        }
    }

    /// One Composite subrequest updating `id` with `body`.
    fn composite_patch(object: &str, id: &str, body: &str) -> String {
        format!(
            r#"{{"method":"PATCH","url":"/services/data/v62.0/sobjects/{object}/{id}","referenceId":"r{id}","body":{body}}}"#
        )
    }

    fn composite(subs: &[String]) -> String {
        format!(
            r#"{{"allOrNone":false,"compositeRequest":[{}]}}"#,
            subs.join(",")
        )
    }

    const COMPOSITE: &str = "/services/data/v62.0/composite";

    #[test]
    fn composite_updates_of_one_type_are_a_table_with_each_records_fields() {
        // An agent changing a different field on each of 3 contacts through
        // /composite gets a table, never raw "Composite request (first) ›
        // Body › Department" rows.
        let body = composite(&[
            composite_patch(
                "Contact",
                "003AA00001AbCdEAAA",
                r#"{"Department":"Systems Research"}"#,
            ),
            composite_patch("Contact", "003AA00002AbCdEAAA", r#"{"Title":"Lead"}"#),
            composite_patch("Contact", "003AA00003AbCdEAAA", r#"{"Phone":"555-0100"}"#),
        ]);
        let s = sf("POST", COMPOSITE, Some(&body));
        assert_eq!(s.action, "Update 3 Contacts");
        let bulk = s.bulk.as_ref().expect("table");
        assert_eq!(bulk.kind, BulkKind::Update);
        // Body order, exactly like a collections update of the same fields.
        let cols: Vec<_> = bulk.fields.iter().map(|f| f.api.as_str()).collect();
        assert_eq!(cols, ["Department", "Title", "Phone"]);
        let ids: Vec<_> = bulk.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "003AA00001AbCdEAAA",
                "003AA00002AbCdEAAA",
                "003AA00003AbCdEAAA"
            ]
        );
        // A record shows only what it sets; the other columns stay blank.
        assert_eq!(
            bulk.rows[0].new,
            vec![Some("Systems Research".into()), None, None]
        );
        assert!(rows(&s).contains(&("Change".into(), "Title → Lead · 1 record".into())));
        assert!(crate::reads_whole_body("salesforce", "POST", COMPOSITE));
        assert!(crate::reads_whole_body(
            "salesforce",
            "POST",
            "/services/data/v62.0/composite/"
        ));
        assert!(!crate::reads_whole_body("salesforce", "PATCH", COMPOSITE));
    }

    /// What the table can't state keeps the generic card, read against
    /// Salesforce's Composite reference: `method` is case-sensitive, a call
    /// holds at most 25 subrequests, and a reference to an earlier answer
    /// (`@{ref.id}`) may sit in the URL or the body.
    #[test]
    fn a_composite_the_table_cannot_state_keeps_the_generic_card() {
        let ok = |id: &str| composite_patch("Contact", id, r#"{"Title":"X"}"#);
        let ids: Vec<String> = (0..26).map(|n| format!("003AA0000{n:03}AbCAAA")).collect();
        let cases: Vec<(&str, String)> = vec![
            (
                "a read",
                r#"{"compositeRequest":[{"method":"GET","url":"/services/data/v62.0/sobjects/Contact/003AA00001AbCdEAAA"}]}"#.into(),
            ),
            (
                "a create",
                r#"{"compositeRequest":[{"method":"POST","url":"/services/data/v62.0/sobjects/Contact","body":{"LastName":"X"}}]}"#.into(),
            ),
            (
                "lower-case method",
                composite(&[ok("003AA00001AbCdEAAA").replace("PATCH", "patch")]),
            ),
            (
                "a reference in the url",
                composite(&[composite_patch("Contact", "@{ref.id}", r#"{"Title":"X"}"#)]),
            ),
            (
                "a reference in a value",
                composite(&[composite_patch(
                    "Contact",
                    "003AA00001AbCdEAAA",
                    r#"{"AccountId":"@{newAccount.id}"}"#,
                )]),
            ),
            (
                "per-subrequest headers",
                composite(&[ok("003AA00001AbCdEAAA").replace(
                    r#""body""#,
                    r#""httpHeaders":{"If-Match":"x"},"body""#,
                )]),
            ),
            (
                "mixed types",
                composite(&[
                    ok("003AA00001AbCdEAAA"),
                    composite_patch("Account", "001AA00001AbCdEAAA", r#"{"Name":"Y"}"#),
                ]),
            ),
            (
                "one record twice (15 and 18 chars)",
                composite(&[ok("003AA00001AbCdEAAA"), ok("003AA00001AbCdE")]),
            ),
            (
                "a subrequest that sets nothing",
                composite(&[composite_patch("Contact", "003AA00001AbCdEAAA", "{}")]),
            ),
            (
                "more than 25 subrequests",
                composite(&ids.iter().map(|id| ok(id)).collect::<Vec<_>>()),
            ),
        ];
        for (why, body) in cases {
            assert!(sf("POST", COMPOSITE, Some(&body)).bulk.is_none(), "{why}");
        }
        // 25 is still a table.
        let at_cap = composite(&ids[..25].iter().map(|id| ok(id)).collect::<Vec<_>>());
        assert_eq!(
            sf("POST", COMPOSITE, Some(&at_cap))
                .bulk
                .map(|b| b.rows.len()),
            Some(25)
        );
    }

    #[test]
    fn update_names_the_record_and_shows_only_changed_fields() {
        let s = sf(
            "PATCH",
            "/services/data/v59.0/sobjects/Opportunity/006QO00000vBB5lYAG",
            Some(r#"{"Amount":40000,"CloseDate":"2026-10-31"}"#),
        );
        assert_eq!(s.action, "Update Opportunity");
        assert_eq!(
            rows(&s),
            vec![
                (
                    "Opportunity".into(),
                    "Opportunity · 006QO00000vBB5lYAG".into()
                ),
                ("Amount".into(), "40000".into()),
                ("Close date".into(), "2026-10-31".into()),
            ]
        );
        assert_eq!(s.refs[0].detail_index, 0);
    }

    /// Every ref points at the row it labels, including a lookup field in an
    /// update body that follows the record's own row.
    #[test]
    fn ref_indices_match_their_rows_on_update_and_upsert() {
        for (path, first_label) in [
            (
                "/services/data/v60.0/sobjects/Contact/003QO00001kGjuEYAS",
                "Contact",
            ),
            (
                "/services/data/v60.0/sobjects/Contact/External_Key__c/K-1",
                "External key",
            ),
        ] {
            let s = sf(
                "PATCH",
                path,
                Some(r#"{"AccountId":"001QO000010eH0cYAF","LastName":"X"}"#),
            );
            assert_eq!(s.details[0].label, first_label, "{path}");
            for r in &s.refs {
                let row = &s.details[r.detail_index];
                assert!(row.value.ends_with(&r.id), "{path}: {r:?} -> {row:?}");
            }
            assert!(s.refs.iter().any(|r| r.object == "Account"), "{path}");
        }
    }

    #[test]
    fn secret_named_fields_and_blobs_are_redacted() {
        let blob = "A".repeat(4000);
        let body = format!(
            r#"{{"Title":"t","Api_Token__c":"sk-live-123","VersionData":"{blob}","PathOnClient":"a.pdf"}}"#
        );
        let s = sf(
            "POST",
            "/services/data/v60.0/sobjects/Document__c",
            Some(&body),
        );
        assert!(rows(&s).contains(&("Api token".into(), "***".into())));
        assert!(row(&s, "Version data").unwrap().contains("base64"));
        assert!(!s.render_text().contains("sk-live-123"));
    }

    #[test]
    fn delete_names_the_record() {
        let s = sf(
            "DELETE",
            "/services/data/v60.0/sobjects/Contact/003QO00001kGjuEYAS",
            None,
        );
        assert_eq!(s.action, "Delete Contact");
        assert_eq!(s.refs.len(), 1);
    }

    #[test]
    fn upsert_by_external_id_shows_the_key() {
        let s = sf(
            "PATCH",
            "/services/data/v60.0/sobjects/Account/External_Key__c/ACME-1",
            Some(r#"{"Name":"Acme"}"#),
        );
        assert_eq!(s.action, "Upsert Account");
        assert_eq!(rows(&s)[0], ("External key".into(), "ACME-1".into()));
        assert_eq!(rows(&s)[1], ("Name".into(), "Acme".into()));
    }

    #[test]
    fn custom_objects_and_fields_get_human_labels() {
        let s = sf(
            "POST",
            "/services/data/v60.0/sobjects/Deposit_Batch__c",
            Some(
                r#"{"Deposit_Amount__c":1200,"npo02__TotalOppAmount__c":5,"Is_Active__c":true,"Notes__c":null}"#,
            ),
        );
        assert_eq!(s.action, "Create Deposit batch");
        assert!(rows(&s).contains(&("Deposit amount".into(), "1200".into())));
        assert!(rows(&s).contains(&("Total opp amount".into(), "5".into())));
        assert!(rows(&s).contains(&("Is active".into(), "Yes".into())));
        assert!(rows(&s).contains(&("Notes".into(), "(cleared)".into())));
    }

    #[test]
    fn api_labels_drop_suffixes_and_namespaces() {
        assert_eq!(api_label("SLAExpirationDate__c"), "SLA expiration date");
        assert_eq!(
            api_label("npe03__Recurring_Donation__c"),
            "Recurring donation"
        );
        assert_eq!(api_label("Account__r"), "Account");
    }

    #[test]
    fn field_list_is_capped() {
        let fields: Vec<String> = (0..20).map(|i| format!("\"F{i}__c\":\"v\"")).collect();
        let s = sf(
            "POST",
            "/services/data/v60.0/sobjects/Lead",
            Some(&format!("{{{}}}", fields.join(","))),
        );
        assert_eq!(s.details.len(), super::super::MAX_FIELD_ROWS + 1);
        assert_eq!(s.details.last().unwrap().value, "+8 more fields");
    }

    #[test]
    fn only_well_formed_lookup_ids_with_known_prefixes_become_refs() {
        let s = sf(
            "POST",
            "/services/data/v60.0/sobjects/Contact",
            Some(
                r#"{"AccountId":"001' OR Name!='","OwnerId":"005QO00000AbCdEfGh","Custom__c":"a0B000000000001","ExternalId":"001QO000010eH0cYAF"}"#,
            ),
        );
        assert_eq!(s.ref_ids().collect::<Vec<_>>(), ["005QO00000AbCdEfGh"]);
        // A malformed id is shown verbatim, never resolved.
        assert!(rows(&s).contains(&("Account id".into(), "001' OR Name!='".into())));
    }

    fn bulk_body(records: &[(&str, &str, &str)]) -> String {
        let recs: Vec<String> = records
            .iter()
            .map(|(ty, id, country)| {
                format!(
                    r#"{{"attributes":{{"type":"{ty}"}},"id":"{id}","MailingCountry":"{country}"}}"#
                )
            })
            .collect();
        format!(r#"{{"allOrNone":false,"records":[{}]}}"#, recs.join(","))
    }

    const BULK: &str = "/services/data/v62.0/composite/sobjects";

    #[test]
    fn a_bulk_update_reads_every_record_and_its_change() {
        let body = bulk_body(&[
            ("Contact", "003AA00000AbCdEFGH", "Canada"),
            ("Contact", "003AA00000AbCdEFGJ", "Canada"),
            ("Contact", "003AA00000AbCdEFGK", "United States"),
        ]);
        let s = sf("PATCH", BULK, Some(&body));
        assert_eq!(s.action, "Update 3 Contacts");
        let b = s.bulk.as_ref().expect("bulk");
        assert_eq!(b.object, "Contact");
        assert_eq!(b.fields[0].label, "Mailing country");
        assert_eq!(b.rows.len(), 3);
        assert_eq!(b.rows[2].new, vec![Some("United States".to_string())]);
        // Text-only consumers get the distinct changes.
        assert!(rows(&s).contains(&(
            "Change".into(),
            "Mailing country → Canada · 2 records".into()
        )));
    }

    #[test]
    fn a_bulk_body_it_cannot_fully_read_is_never_summarized() {
        let ok = bulk_body(&[("Contact", "003AA00000AbCdEFGH", "Canada")]);
        let cases: Vec<(&str, String)> = vec![
            // Cut mid-stream: not every record was read.
            ("truncated", ok[..ok.len() - 5].to_string()),
            // Two record types in one call.
            (
                "mixed types",
                bulk_body(&[
                    ("Contact", "003AA00000AbCdEFGH", "Canada"),
                    ("Lead", "00QAA00000AbCdEFGH", "Canada"),
                ]),
            ),
            // A record without a valid id.
            ("bad id", bulk_body(&[("Contact", "nope", "Canada")])),
            // A nested value the card can't show as a field.
            (
                "nested",
                r#"{"records":[{"attributes":{"type":"Contact"},"id":"003AA00000AbCdEFGH","X":{"a":1}}]}"#
                    .to_string(),
            ),
            ("no records", r#"{"records":[]}"#.to_string()),
        ];
        for (why, body) in cases {
            let s = sf("PATCH", BULK, Some(&body));
            assert!(s.bulk.is_none(), "{why}");
        }
        // A POST carrying record ids is no create (an id means an update),
        // and a DELETE names its records in the URL, never the body.
        assert!(sf("POST", BULK, Some(&ok)).bulk.is_none());
        assert!(sf("DELETE", BULK, Some(&ok)).bulk.is_none());
    }

    #[test]
    fn a_bulk_create_lists_every_new_record_by_its_name() {
        let body = r#"{"allOrNone":false,"records":[
            {"attributes":{"type":"Contact"},"FirstName":"Dana","LastName":"Reyes","Title":"CTO"},
            {"attributes":{"type":"Contact"},"LastName":"Okafor","Email":"x@example.com"}]}"#;
        let s = sf("POST", BULK, Some(body));
        assert_eq!(s.action, "Create 2 Contacts");
        let b = s.bulk.as_ref().expect("bulk");
        assert_eq!(b.kind, BulkKind::Create);
        assert_eq!(
            b.fields.iter().map(|f| f.api.as_str()).collect::<Vec<_>>(),
            ["FirstName", "LastName", "Title", "Email"]
        );
        assert_eq!(b.rows[0].name.as_deref(), Some("Dana Reyes"));
        assert_eq!(b.rows[1].name.as_deref(), Some("Okafor"));
        assert_eq!(b.rows[0].id, "1", "a new record's row is its place");
        assert_eq!(
            b.rows[1].ops,
            [
                CellOp::Untouched,
                CellOp::Fill,
                CellOp::Untouched,
                CellOp::Fill
            ]
        );
        assert_eq!(b.rows[0].op, Some(CellOp::Fill));
        // A create isn't one change: no "Change" rows.
        assert!(rows(&s).iter().all(|(k, _)| k != "Change"));
    }

    #[test]
    fn a_bulk_create_of_full_records_is_still_one_table() {
        // "Fill in everything": a contact with 25 fields, lookups and dates.
        let fields = [
            ("AccountId", "\"001AA00000AbCdEFGH\""),
            ("AssistantName", "\"Leo Park\""),
            ("AssistantPhone", "\"(415) 555-0151\""),
            ("Birthdate", "\"1984-03-12\""),
            ("Department", "\"Operations\""),
            ("Description", "\"Demo contact\""),
            ("Email", "\"demo@example.com\""),
            ("Fax", "\"(415) 555-0152\""),
            ("FirstName", "\"Ava\""),
            ("HomePhone", "\"(415) 555-0153\""),
            ("LastName", "\"Demo01\""),
            ("LeadSource", "\"Web\""),
            ("MailingCity", "\"San Francisco\""),
            ("MailingCountry", "\"United States\""),
            ("MailingPostalCode", "\"94105\""),
            ("MailingState", "\"CA\""),
            ("MailingStreet", "\"1 Market St\""),
            ("MobilePhone", "\"(415) 555-0154\""),
            ("OtherCity", "\"Oakland\""),
            ("OtherPhone", "\"(415) 555-0155\""),
            ("Phone", "\"(415) 555-0156\""),
            ("Salutation", "\"Ms.\""),
            ("Title", "\"VP Operations\""),
            ("HasOptedOutOfEmail", "false"),
            ("DoNotCall", "true"),
        ];
        let record = fields
            .iter()
            .map(|(k, v)| format!("\"{k}\":{v}"))
            .collect::<Vec<_>>()
            .join(",");
        let body = format!(
            r#"{{"allOrNone":false,"records":[{{"attributes":{{"type":"Contact"}},{record}}},{{"attributes":{{"type":"Contact"}},{record}}}]}}"#
        );
        let s = sf("POST", BULK, Some(&body));
        let b = s.bulk.as_ref().expect("a full-record create is a table");
        assert_eq!(b.fields.len(), 25);
        assert_eq!(b.rows[0].name.as_deref(), Some("Ava Demo01"));
        assert!(b.hidden_fields.is_empty());
    }

    #[test]
    fn past_the_column_cap_the_table_shows_the_names_first_and_names_the_rest() {
        let mut record = (0..MAX_BULK_FIELDS + 3)
            .map(|i| format!("\"Field{i:02}__c\":\"v\""))
            .collect::<Vec<_>>();
        record.push("\"LastName\":\"Demo01\"".into());
        let body = format!(
            r#"{{"records":[{{"attributes":{{"type":"Contact"}},{}}}]}}"#,
            record.join(",")
        );
        let s = sf("POST", BULK, Some(&body));
        let b = s.bulk.as_ref().expect("still one table");
        assert_eq!(b.fields.len(), MAX_BULK_FIELDS);
        assert_eq!(
            b.fields[0].api, "LastName",
            "the name column survives the cut"
        );
        assert_eq!(b.hidden_fields.len(), 4);
        assert_eq!(b.hidden_fields[0], "Field39");
        // Each row's values line up with the shown columns.
        assert_eq!(b.rows[0].new.len(), MAX_BULK_FIELDS);
        assert_eq!(b.rows[0].new[0].as_deref(), Some("Demo01"));
    }

    #[test]
    fn a_custom_lookup_is_a_named_row_and_its_id_a_table_value() {
        // The detail row names the record; the change table shows
        // the value the field is set to, so the two read consistently and
        // the table never claims a name it didn't read.
        let s = sf(
            "PATCH",
            "/services/data/v60.0/sobjects/Contact/003AA00000AbCdEFGH",
            Some(r#"{"SDR__c":"005QO00000QrStUvWx"}"#),
        );
        assert_eq!(
            row(&s, "SDR"),
            Some("User · 005QO00000QrStUvWx"),
            "a record row the gateway can name"
        );
        let b = s.bulk.as_ref().expect("a one-row change");
        assert_eq!(b.fields[0].label, "SDR");
        assert_eq!(b.rows[0].new, vec![Some("005QO00000QrStUvWx".to_string())]);
        // Once the gateway names the user, the table reads as the row does,
        // so a one-record card (which shows the table) keeps the name.
        let mut s = s;
        s.name_refs(|_| Some("Alex Kim"));
        s.name_change_values();
        assert_eq!(row(&s, "SDR"), Some("Alex Kim (005QO00000QrStUvWx)"));
        assert_eq!(
            s.bulk.unwrap().rows[0].new,
            vec![Some("Alex Kim (005QO00000QrStUvWx)".to_string())]
        );
    }

    #[test]
    fn a_single_record_write_is_a_one_row_change() {
        let upd = sf(
            "PATCH",
            "/services/data/v60.0/sobjects/Contact/003AA00000AbCdEFGH",
            Some(r#"{"Title":"VP of Procurement","Department":"Strategic Sourcing"}"#),
        );
        let b = upd.bulk.as_ref().expect("an update is a one-row change");
        assert_eq!(b.kind, BulkKind::Update);
        assert_eq!(b.rows.len(), 1);
        assert_eq!(b.rows[0].id, "003AA00000AbCdEFGH");
        assert_eq!(
            b.fields.iter().map(|f| f.api.as_str()).collect::<Vec<_>>(),
            ["Title", "Department"]
        );
        // The detail rows stay for text-only consumers.
        assert!(rows(&upd).iter().any(|(k, _)| k == "Title"));

        let new = sf(
            "POST",
            "/services/data/v60.0/sobjects/Contact/",
            Some(r#"{"FirstName":"Ava","LastName":"Demo01","Title":"CTO"}"#),
        );
        let b = new.bulk.as_ref().expect("a create is a one-row change");
        assert_eq!(b.kind, BulkKind::Create);
        assert_eq!(b.rows[0].name.as_deref(), Some("Ava Demo01"));
        assert_eq!(b.rows[0].op, Some(CellOp::Fill));

        let del = sf(
            "DELETE",
            "/services/data/v60.0/sobjects/Contact/003AA00000AbCdEFGH",
            None,
        );
        let b = del.bulk.as_ref().expect("a delete is a one-row change");
        assert_eq!(b.kind, BulkKind::Delete);
        assert_eq!(b.rows[0].op, Some(CellOp::Clear));
        assert_eq!(b.fields.len(), 2, "Title and Email are read for the card");

        // A body it can't read as plain fields keeps only the detail rows.
        let nested = sf(
            "PATCH",
            "/services/data/v60.0/sobjects/Contact/003AA00000AbCdEFGH",
            Some(r#"{"Title":"x","Extra":{"a":1}}"#),
        );
        assert!(nested.bulk.is_none());
    }

    #[test]
    fn a_bulk_delete_reads_its_ids_from_the_url() {
        let s = sf(
            "DELETE",
            "/services/data/v62.0/composite/sobjects?ids=003AA00000AbCdEFGH,003AA00000AbCdEFGJ,003AA00000AbCdEFGH&allOrNone=false",
            None,
        );
        assert_eq!(s.action, "Delete 2 Contacts", "ids are deduped");
        let b = s.bulk.as_ref().expect("bulk");
        assert_eq!(b.kind, BulkKind::Delete);
        assert_eq!(b.rows.len(), 2);
        assert_eq!(b.rows[0].op, Some(CellOp::Clear));
        assert_eq!(
            b.fields.iter().map(|f| f.api.as_str()).collect::<Vec<_>>(),
            ["Title", "Email"]
        );
    }

    #[test]
    fn a_bulk_delete_it_cannot_read_in_full_keeps_the_generic_card() {
        let base = "/services/data/v62.0/composite/sobjects";
        for (why, q) in [
            ("no ids", ""),
            ("a bad id", "?ids=003AA00000AbCdEFGH,DROP"),
            ("mixed types", "?ids=003AA00000AbCdEFGH,001AA00000AbCdEFGH"),
            ("an unknown type", "?ids=a0BAA00000AbCdEFGH"),
        ] {
            assert!(
                sf("DELETE", &format!("{base}{q}"), None).bulk.is_none(),
                "{why}"
            );
        }
        let many = (0..201)
            .map(|i| format!("003AA00000AbC{i:05}"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(sf("DELETE", &format!("{base}?ids={many}"), None)
            .bulk
            .is_none());
    }

    #[test]
    fn a_bulk_update_masks_secret_named_fields() {
        let body = r#"{"records":[{"attributes":{"type":"Contact"},"id":"003AA00000AbCdEFGH","Api_Token__c":"s3cr3t"}]}"#;
        let s = sf("PATCH", BULK, Some(body));
        let b = s.bulk.expect("bulk");
        assert_eq!(b.rows[0].new, vec![Some("***".to_string())]);
    }

    #[test]
    fn the_documented_trailing_slash_is_the_same_bulk_path() {
        let body = bulk_body(&[("Contact", "003AA00000AbCdEFGH", "Canada")]);
        let s = sf("PATCH", &format!("{BULK}/"), Some(&body));
        assert_eq!(s.action, "Update 1 Contact");
        assert!(super::super::reads_whole_body(
            "salesforce",
            "PATCH",
            &format!("{BULK}/")
        ));
    }

    #[test]
    fn only_a_salesforce_bulk_write_reads_its_body_whole() {
        use super::super::reads_whole_body;
        assert!(reads_whole_body("salesforce", "PATCH", BULK));
        assert!(reads_whole_body("salesforce", "post", BULK));
        // A bulk delete names its records in the URL: no body to read.
        assert!(!reads_whole_body("salesforce", "DELETE", BULK));
        // The same path on another app, or none, keeps the short peek.
        assert!(!reads_whole_body("github", "PATCH", BULK));
        assert!(!reads_whole_body("api.example.com", "PATCH", BULK));
        assert!(!reads_whole_body(
            "salesforce",
            "PATCH",
            "/services/data/v62.0/sobjects/Contact/003AA00000AbCdEFGH"
        ));
    }

    #[test]
    fn a_custom_lookup_field_is_named_like_the_standard_owner_beside_it() {
        // The reported card: an SDR owner set through a custom lookup. The
        // standard `OwnerId` already read as a person; `SDR__c` showed the
        // bare user id, so the approver could not tell who they were making
        // the SDR. Both now resolve the same way.
        let s = sf(
            "PATCH",
            "/services/data/v59.0/sobjects/Contact/003QO00000XyZaBcDe",
            Some(r#"{"OwnerId":"005QO00000QrStUvWx","SDR__c":"005QO00000QrStUvWx"}"#),
        );
        assert_eq!(
            rows(&s),
            [
                ("Contact".into(), "Contact · 003QO00000XyZaBcDe".into()),
                ("Owner".into(), "User · 005QO00000QrStUvWx".into()),
                ("SDR".into(), "User · 005QO00000QrStUvWx".into()),
            ]
        );
        let refs: Vec<(&str, &str)> = s
            .refs
            .iter()
            .map(|r| (r.object.as_str(), r.id.as_str()))
            .collect();
        assert_eq!(
            refs,
            [
                ("Contact", "003QO00000XyZaBcDe"),
                ("User", "005QO00000QrStUvWx"),
                ("User", "005QO00000QrStUvWx"),
            ]
        );
    }

    #[test]
    fn custom_fields_are_named_only_for_known_record_ids() {
        let s = sf(
            "POST",
            "/services/data/v60.0/sobjects/Contact",
            Some(
                r#"{"LastName":"Tal","CSM__c":"005QO00000AbCdEfGh","Partner_Account__c":"001QO000010eH0cYAF","Notes__c":"005QO00000AbCdEfGhXYZ","Ticket__c":"ABCDEFGHIJKLMNO","Custom_Obj__c":"a0B000000000001","Legacy_External_Ref__c":"001QO000010eH0cYAF","Score__c":500123456789012}"#,
            ),
        );
        // Lookups to known objects become named rows.
        assert!(rows(&s).contains(&("CSM".into(), "User · 005QO00000AbCdEfGh".into())));
        assert!(rows(&s).contains(&(
            "Partner account".into(),
            "Account · 001QO000010eH0cYAF".into()
        )));
        // Plain text stays text: wrong length, an unknown prefix, a custom
        // object (no name read for it), anything named external, and a
        // number (ids are strings) shaped like a Case id.
        assert!(rows(&s).contains(&("Notes".into(), "005QO00000AbCdEfGhXYZ".into())));
        assert!(rows(&s).contains(&("Ticket".into(), "ABCDEFGHIJKLMNO".into())));
        assert!(rows(&s).contains(&("Custom obj".into(), "a0B000000000001".into())));
        assert!(rows(&s).contains(&("Legacy external ref".into(), "001QO000010eH0cYAF".into())));
        assert!(rows(&s).contains(&("Score".into(), "500123456789012".into())));
        assert_eq!(
            s.ref_ids().collect::<Vec<_>>(),
            ["005QO00000AbCdEfGh", "001QO000010eH0cYAF"]
        );
    }

    #[test]
    fn non_sobject_paths_fall_back_to_generic() {
        for (m, p) in [
            ("POST", "/services/data/v60.0/composite/sobjects"),
            ("GET", "/services/data/v60.0/sobjects/Contact/describe"),
            ("POST", "/services/data/v60.0/tooling/sobjects/CustomField/"),
            ("POST", "/services/data/v60.0/sobjects/Bad-Name"),
        ] {
            let s = sf(m, p, Some("{}"));
            assert!(s.action.ends_with(" request"), "{m} {p}: {}", s.action);
            assert!(s.refs.is_empty());
        }
    }

    // ── The record resolver ──────────────────────────────────────────────

    #[test]
    fn the_name_read_is_server_built_from_validated_ids_only() {
        let decode = |path: &str| -> String {
            form_urlencoded::parse(path.split_once("?q=").unwrap().1.as_bytes())
                .map(|(k, v)| format!("{k}{v}"))
                .collect()
        };
        let path = Salesforce.names_read("Account", &["001QO000010eH0cYAF", "001' OR Name != '"]);
        assert!(path.starts_with("/services/data/v60.0/query?q="));
        assert_eq!(
            decode(&path),
            "SELECT Id, Name FROM Account WHERE Id IN ('001QO000010eH0cYAF')"
        );
        // Files are named by Title, a Case (no Name field) by its number.
        let path = Salesforce.names_read("ContentDocument", &["069fn000005ekPSAAY"]);
        assert_eq!(
            decode(&path),
            "SELECT Id, Title FROM ContentDocument WHERE Id IN ('069fn000005ekPSAAY')"
        );
        let path = Salesforce.names_read("Case", &["500QO00000AbCdEfGh"]);
        assert_eq!(
            decode(&path),
            "SELECT Id, CaseNumber FROM Case WHERE Id IN ('500QO00000AbCdEfGh')"
        );
    }

    #[test]
    fn names_parse_from_the_types_name_field_and_junk_yields_none() {
        assert_eq!(
            Salesforce.parse_names(
                "Account",
                br#"{"records":[{"Id":"001A","Name":"Initech"},{"Id":"001C"}]}"#
            ),
            [("001A".into(), "Initech".into())]
        );
        assert_eq!(
            Salesforce.parse_names(
                "ContentDocument",
                br#"{"records":[{"Id":"069B","Title":"DR"}]}"#
            ),
            [("069B".into(), "DR".into())]
        );
        assert_eq!(
            Salesforce.parse_names(
                "Case",
                br#"{"records":[{"Id":"500A","CaseNumber":"00001026"}]}"#
            ),
            [("500A".into(), "00001026".into())]
        );
        assert!(Salesforce.parse_names("Account", b"[]").is_empty());
        assert!(Salesforce.parse_names("Account", b"<html>").is_empty());
    }

    #[test]
    fn the_current_values_read_names_records_by_their_types_name_field() {
        let decode = |path: &str| -> String {
            form_urlencoded::parse(path.split_once("?q=").unwrap().1.as_bytes())
                .map(|(k, v)| format!("{k}{v}"))
                .collect()
        };
        let ids = ["500QO000010eH0cYAF"];
        let read = Salesforce
            .current_values_read("Case", &["Subject", "Status"], &[], &ids)
            .unwrap();
        assert_eq!(
            decode(&read),
            "SELECT Id, CaseNumber, Subject, Status FROM Case WHERE Id IN ('500QO000010eH0cYAF')"
        );
        // No preview fields: the names alone.
        let read = Salesforce.current_values_read("Contact", &[], &[], &["003QO000010eH0cYAF"]);
        assert_eq!(
            decode(&read.unwrap()),
            "SELECT Id, Name FROM Contact WHERE Id IN ('003QO000010eH0cYAF')"
        );
        // Anything not a plain API name or a record id builds no read.
        assert!(Salesforce
            .current_values_read("Contact", &["Name, (SELECT"], &[], &ids)
            .is_none());
        assert!(Salesforce
            .current_values_read("Contact", &["Title"], &[], &["003' OR"])
            .is_none());
        let answer = br#"{"records":[{"Id":"500A","CaseNumber":"00001026","Subject":"Broken","Api_Key__c":"k","Status":null}]}"#;
        assert_eq!(
            Salesforce.parse_current_values(
                "Case",
                answer,
                &["Subject", "Api_Key__c", "Status"],
                &[]
            ),
            [CurrentRecord {
                id: "500A".to_string(),
                name: Some("00001026".to_string()),
                values: vec![Some("Broken".to_string()), Some("***".to_string()), None],
                context: Vec::new(),
            }]
        );
    }

    /// A contact card reads who each record is (its account and title) in
    /// the same read, one relationship hop at most, every part a plain API
    /// name; nothing else can be smuggled in as a "context" column.
    #[test]
    fn the_context_read_names_each_records_account_and_title() {
        let decode = |path: &str| -> String {
            form_urlencoded::parse(path.split_once("?q=").unwrap().1.as_bytes())
                .map(|(k, v)| format!("{k}{v}"))
                .collect()
        };
        let ids = ["003QO000010eH0cYAF"];
        let api = |cols: Vec<ContextField>| cols.into_iter().map(|c| c.api).collect::<Vec<_>>();
        let context = api(Salesforce.context_fields("Contact", &["Status__c"]));
        assert_eq!(context, ["Account.Name", "Title"]);
        let read = Salesforce
            .current_values_read("Contact", &["Status__c"], &context, &ids)
            .unwrap();
        assert_eq!(
            decode(&read),
            "SELECT Id, Name, Status__c, Account.Name, Title FROM Contact WHERE Id IN ('003QO000010eH0cYAF')"
        );
        // A column the change covers is left off: the field itself (already
        // a change column), or the lookup a relationship column reads
        // through (its old record beside the new one). Field names compare
        // as Salesforce reads them, case-insensitively.
        assert_eq!(
            api(Salesforce.context_fields("Contact", &["title"])),
            ["Account.Name"]
        );
        assert_eq!(
            api(Salesforce.context_fields("Contact", &["AccountId"])),
            ["Title"]
        );
        assert_eq!(
            api(Salesforce.context_fields("Account", &["OwnerId", "Type"])),
            Vec::<&str>::new()
        );
        // A field in both lists is read once, not twice.
        let read = Salesforce
            .current_values_read("Contact", &["Title"], &["Account.Name", "Title"], &ids)
            .unwrap();
        assert_eq!(
            decode(&read),
            "SELECT Id, Name, Title, Account.Name FROM Contact WHERE Id IN ('003QO000010eH0cYAF')"
        );
        for bad in ["Account.Owner.Name", "Account.(SELECT", ".Name", "Account."] {
            assert!(
                Salesforce
                    .current_values_read("Contact", &[], &[bad], &ids)
                    .is_none(),
                "{bad}"
            );
        }
        let answer = br#"{"records":[
            {"Id":"003A","Name":"Dana","Account":{"attributes":{},"Name":"Acme"},"Title":"CFO"},
            {"Id":"003B","Name":"Lee","Account":null,"Title":null}
        ]}"#;
        let read = Salesforce.parse_current_values("Contact", answer, &[], &context);
        assert_eq!(
            read[0].context,
            [Some("Acme".to_string()), Some("CFO".to_string())]
        );
        assert_eq!(read[1].context, [None, None], "no account: an empty cell");
        assert!(Salesforce
            .context_fields("Deposit_Batch__c", &[])
            .is_empty());
    }

    #[test]
    fn plurals_read_as_english() {
        for (one, many) in [
            ("Contact", "Contacts"),
            ("Opportunity", "Opportunities"),
            ("Deposit batch", "Deposit batches"),
            ("Address", "Addresses"),
            ("Survey", "Surveys"),
        ] {
            assert_eq!(plural(one, 2), many);
            assert_eq!(plural(one, 1), one);
        }
        let ids = "006AA00000AbCdEFGH,006AA00000AbCdEFGJ";
        let s = sf("DELETE", &format!("{BULK}?ids={ids}"), None);
        assert_eq!(s.action, "Delete 2 Opportunities");
    }

    #[test]
    fn record_links_are_https_on_the_org_host_with_a_valid_id_only() {
        assert_eq!(
            Salesforce
                .record_url("acme.my.salesforce.com", "001QO000010eH0cYAF")
                .as_deref(),
            Some("https://acme.my.salesforce.com/001QO000010eH0cYAF")
        );
        assert_eq!(
            Salesforce.record_url("acme.my.salesforce.com", "001/../x"),
            None
        );
        assert_eq!(Salesforce.record_url("", "001QO000010eH0cYAF"), None);
    }

    #[test]
    fn both_id_spellings_share_one_canonical_form() {
        assert_eq!(
            Salesforce.canonical_id("001QO000010eH0cYAF"),
            Salesforce.canonical_id("001QO000010eH0c")
        );
        // An answer's id that isn't an 18-char id is kept, never sliced
        // (a byte cut through a multi-byte char would panic).
        for odd in ["ééééééééé", "001", "001QO000010eH0cYAFX"] {
            assert_eq!(Salesforce.canonical_id(odd), odd);
        }
        assert_eq!(Salesforce.object_of("001QO000010eH0c"), Some("Account"));
        assert_eq!(Salesforce.object_of("a0B000000000001"), None);
        assert_eq!(Salesforce.object_of("001'xx"), None);
    }

    // ── Files ────────────────────────────────────────────────────────────

    #[test]
    fn a_file_upload_reads_as_one_never_as_base64() {
        let data = "A".repeat(16_212);
        let body = format!(
            r#"{{"Title":"DR Procedure.docx (1)","PathOnClient":"DR Procedure.docx (1).pdf","FirstPublishLocationId":"006fn00000AbCdEAAZ","VersionData":"{data}"}}"#
        );
        let s = upload(body.as_bytes());
        assert_eq!(s.action, "Upload file");
        let mut titled = s.clone();
        titled.finalize_title();
        assert_eq!(
            titled.action,
            "Upload file to Opportunity 006fn00000AbCdEAAZ"
        );
        assert_eq!(row(&s, "File"), Some("DR Procedure.docx (1).pdf"));
        // The Title only restates the file name without its extension.
        assert_eq!(row(&s, "Title"), None);
        assert_eq!(
            row(&s, "Attach to"),
            Some("Opportunity · 006fn00000AbCdEAAZ")
        );
        assert_eq!(row(&s, "Size"), Some("12 KB"));
        assert!(!s.render_text().contains("AAAA"));
        assert_eq!(s.refs.len(), 1);
    }

    #[test]
    fn a_content_document_id_reads_as_a_new_version_not_a_loose_upload() {
        let body = br#"{"Title":"DR Procedure","PathOnClient":"DR Procedure.pdf","ContentDocumentId":"069fn000005ekPSAAY","VersionData":"QUJD"}"#;
        let s = upload(body);
        assert_eq!(s.action, "Update file");
        assert_eq!(
            row(&s, "Replaces"),
            Some("Content document · 069fn000005ekPSAAY")
        );
        assert_eq!(s.refs[0].object, "ContentDocument");
        let mut titled = s.clone();
        titled.finalize_title();
        assert_eq!(titled.action, "Update file 069fn000005ekPSAAY");
        // File, then Replaces: the Title only restates the file name.
        assert_eq!(titled.subject.expect("the file is the subject").row, 1);
    }

    #[test]
    fn a_new_version_is_recognized_in_a_truncated_body_too() {
        let body = format!(
            r#"{{"Title":"DR Procedure","PathOnClient":"DR Procedure.pdf","ContentDocumentId":"069fn000005ekPSAAY","VersionData":"{}"#,
            "B".repeat(20_000)
        );
        let s = upload(&body.as_bytes()[..16 * 1024]);
        assert_eq!(s.action, "Update file");
    }

    #[test]
    fn a_truncated_upload_still_names_the_file_and_bounds_the_size() {
        // Real uploads outgrow the gateway's 16 KiB peek, cut mid-VersionData.
        let body = format!(
            r#"{{"Title":"Board deck \"Q3\"","PathOnClient":"deck.pdf","VersionData":"{}"#,
            "B".repeat(20_000)
        );
        let s = upload(&body.as_bytes()[..16 * 1024]);
        assert_eq!(s.action, "Upload file (not attached to a record yet)");
        assert_eq!(row(&s, "File"), Some("deck.pdf"));
        assert_eq!(row(&s, "Title"), Some("Board deck \"Q3\""));
        assert!(row(&s, "Size").unwrap().starts_with("at least "));
    }

    #[test]
    fn attaching_a_file_reads_as_one_with_resolvable_names() {
        let s = sf(
            "POST",
            "/services/data/v59.0/sobjects/ContentDocumentLink",
            Some(
                r#"{"ContentDocumentId":"069fn000005ekPSAAY","LinkedEntityId":"001fn00000cTWhpAAG","ShareType":"V","Visibility":"AllUsers"}"#,
            ),
        );
        assert_eq!(s.action, "Attach file");
        assert_eq!(
            rows(&s),
            vec![
                (
                    "File".into(),
                    "Content document · 069fn000005ekPSAAY".into()
                ),
                ("Attach to".into(), "Account · 001fn00000cTWhpAAG".into()),
                ("Access".into(), "Can view".into()),
                (
                    "Visibility".into(),
                    "Everyone who can see the record".into()
                ),
            ]
        );
        let objects: Vec<_> = s.refs.iter().map(|r| r.object.as_str()).collect();
        assert_eq!(objects, ["ContentDocument", "Account"]);
    }

    #[test]
    fn a_key_quoted_inside_another_value_never_matches() {
        // A description mentioning "Title" must not become the file's title.
        let body = format!(
            r#"{{"Description":"see \"Title\": \"evil\"","PathOnClient":"real.pdf","VersionData":"{}"#,
            "C".repeat(20_000)
        );
        let s = upload(&body.as_bytes()[..16 * 1024]);
        assert_eq!(row(&s, "File"), Some("real.pdf"));
        assert_eq!(row(&s, "Title"), None);
    }

    // ── Titles ───────────────────────────────────────────────────────────

    #[test]
    fn the_title_says_which_record_an_action_is_about() {
        let id = "003fn00000Fa7bpAAB";
        let path = format!("/services/data/v60.0/sobjects/Contact/{id}");
        assert_eq!(
            titled("PATCH", &path, Some(r#"{"Email":"a@b.co"}"#)).action,
            format!("Update Contact {id}")
        );
        assert_eq!(
            titled("DELETE", &path, None).action,
            format!("Delete Contact {id}")
        );
        // A create names its parent; the owner is not a parent.
        assert_eq!(
            titled(
                "POST",
                "/services/data/v60.0/sobjects/Contact",
                Some(r#"{"LastName":"Tal","OwnerId":"005fn000007szC9AAI","AccountId":"001fn00000cTWhpAAG"}"#),
            )
            .action,
            "Create Contact in Account 001fn00000cTWhpAAG"
        );
        // No parent: the title stays as it was, and there is no subject.
        let plain = titled(
            "POST",
            "/services/data/v60.0/sobjects/Contact",
            Some(r#"{"LastName":"Tal"}"#),
        );
        assert_eq!(plain.action, "Create Contact");
        assert_eq!(plain.subject, None);
        // Attaching a file names the record, not the file.
        assert_eq!(
            titled(
                "POST",
                "/services/data/v60.0/sobjects/ContentDocumentLink",
                Some(r#"{"ContentDocumentId":"069fn000005ekPSAAY","LinkedEntityId":"001fn00000cTWhpAAG"}"#),
            )
            .action,
            "Attach file to Account 001fn00000cTWhpAAG"
        );
    }

    #[test]
    fn a_custom_lookup_is_never_a_creates_parent() {
        // Listed before the standard AccountId, a custom Account lookup
        // still leaves the AccountId as the parent.
        assert_eq!(
            titled(
                "POST",
                "/services/data/v60.0/sobjects/Contact",
                Some(r#"{"LastName":"Tal","AE_Account__c":"001QO000010eH0cYAF","AccountId":"001QO00000AbCdEfGh"}"#),
            )
            .action,
            "Create Contact in Account 001QO00000AbCdEfGh"
        );
        // On its own it names no parent: a Lead is not created in a partner.
        let lead = titled(
            "POST",
            "/services/data/v60.0/sobjects/Lead",
            Some(r#"{"LastName":"Tal","Partner_Account__c":"001QO000010eH0cYAF"}"#),
        );
        assert_eq!(lead.action, "Create Lead");
        assert_eq!(lead.subject, None);
    }

    #[test]
    fn the_subject_names_the_row_it_came_from() {
        let mut s = upload(
            br#"{"PathOnClient":"a.pdf","FirstPublishLocationId":"001fn00000cTWhpAAG","VersionData":"QUJD"}"#,
        );
        s.link_refs(|id| Salesforce.record_url("acme.my.salesforce.com", id));
        s.name_refs(|_| Some("OneCLI Demo Acme Robotics"));
        s.finalize_title();
        let subject = s.subject.clone().unwrap();
        assert_eq!(subject.lead, "Upload file to ");
        assert_eq!(subject.record, "Account OneCLI Demo Acme Robotics");
        assert_eq!(s.details[subject.row].label, "Attach to");
        assert_eq!(
            subject.url.as_deref(),
            Some("https://acme.my.salesforce.com/001fn00000cTWhpAAG")
        );
    }
}
