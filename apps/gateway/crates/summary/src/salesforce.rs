//! Salesforce REST: manual-approval summaries.
//!
//! Turns an sObject write (`POST/PATCH/DELETE /services/data/vXX/sobjects/…`)
//! into a readable card: "Create Contact", then the record's fields with
//! human labels (`LeadSource` → "Lead source", `Deposit_Batch__c` → "Deposit
//! batch"), the record's own name first. Lookup fields that hold a record id
//! (`AccountId`, `OwnerId`, …) become record rows (`Account · 001…`) that
//! the gateway can show by name, through this module's [`RecordResolver`].
//!
//! Registered as `"salesforce"` in [`super::summarizer`] and
//! [`super::record_resolver`].

use serde::Deserialize;
use serde_json::Value;

use super::redact::{is_sensitive_key, redact_string};
use super::{humanize_key, json_object, ApprovalSummary, RecordResolver, SummaryRequest, Target};

pub(super) struct Salesforce;

/// The REST version of the name lookup (every supported org answers it).
const API_VERSION: &str = "v60.0";

impl super::RequestSummarizer for Salesforce {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let (object, rest) = sobject_path(req.base_path())?;
        let object_label = api_label(object);
        match (req.method_upper().as_str(), rest.as_slice()) {
            ("POST", []) if object == "ContentDocumentLink" => Some(attach_file(req)),
            ("POST", []) if object == "ContentVersion" => Some(upload_file(req)),
            ("POST", []) => {
                let mut s = ApprovalSummary::new(format!("Create {object_label}"));
                push_body_fields(&mut s, req);
                s.target = parent_target(&s, " in ");
                Some(s)
            }
            // `/sobjects/{Type}/{id}`: an update of an existing record. The
            // record's own row goes first, before the body's fields.
            ("PATCH", [id]) if is_record_id(id) => {
                let mut s = ApprovalSummary::new(format!("Update {object_label}"));
                s.push_record(&object_label, object, id);
                s.target = Some(Target::of(id, " ", None));
                push_body_fields(&mut s, req);
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

    /// `/services/data/v60.0/query?q=SELECT Id, Name FROM <Object> WHERE Id
    /// IN (…)`: the object comes from [`object_of`](Self::object_of)'s fixed
    /// table and every id is re-checked by [`is_record_id`] (alphanumerics
    /// only), so the SOQL is fully server-built. Files are named by `Title`.
    fn names_read(&self, object: &str, ids: &[&str]) -> String {
        let list = ids
            .iter()
            .filter(|id| is_record_id(id))
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(",");
        let name_field = match object {
            "ContentDocument" | "ContentVersion" => "Title",
            _ => "Name",
        };
        let soql = format!("SELECT Id, {name_field} FROM {object} WHERE Id IN ({list})");
        let q: String = form_urlencoded::byte_serialize(soql.as_bytes()).collect();
        format!("/services/data/{API_VERSION}/query?q={q}")
    }

    fn parse_names(&self, body: &[u8]) -> Vec<(String, String)> {
        #[derive(Deserialize)]
        struct QueryResponse {
            records: Vec<QueryRecord>,
        }
        #[derive(Deserialize)]
        struct QueryRecord {
            #[serde(rename = "Id")]
            id: String,
            #[serde(rename = "Name", alias = "Title")]
            name: Option<String>,
        }
        serde_json::from_slice::<QueryResponse>(body)
            .map(|r| {
                r.records
                    .into_iter()
                    .filter_map(|r| Some((r.id, r.name?)))
                    .collect()
            })
            .unwrap_or_default()
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
/// lookup the body names. Owners (`User`) and groups are not a parent.
fn parent_target(s: &ApprovalSummary, join: &'static str) -> Option<Target> {
    let parents = || {
        s.refs
            .iter()
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
/// `attributes`, anything not a field write) are not paraphrased.
fn push_body_fields(s: &mut ApprovalSummary, req: &SummaryRequest<'_>) {
    let Some(obj) = req.body.and_then(json_object) else {
        return;
    };
    let rank = |k: &str| match k {
        "Name" => 0,
        "Salutation" => 1,
        "FirstName" => 2,
        "LastName" => 3,
        "Email" => 4,
        "Phone" | "MobilePhone" => 5,
        "Title" => 6,
        _ => 10,
    };
    let mut fields: Vec<(&String, &Value)> = obj
        .iter()
        .filter(|(_, v)| !matches!(v, Value::Object(_) | Value::Array(_)))
        .collect();
    fields.sort_by_key(|(k, _)| rank(k));
    s.push_fields(fields, |s, key, value| {
        let text = match value {
            Value::String(v) => v.clone(),
            Value::Bool(b) => if *b { "Yes" } else { "No" }.to_string(),
            Value::Null => "(cleared)".to_string(),
            other => other.to_string(),
        };
        if is_sensitive_key(key) {
            s.push(api_label(key), "***");
        } else if let Some(object) = lookup_object(key, &text) {
            s.push_record(
                api_label(key.strip_suffix("Id").unwrap_or(key)),
                object,
                &text,
            );
        } else {
            s.push(api_label(key), redact_string(&text));
        }
    });
}

/// The sObject a lookup field points at: only for fields named like a lookup
/// (`…Id`, never the record's own `Id` or an external-id field) holding a
/// well-formed record id of a known type.
fn lookup_object(key: &str, value: &str) -> Option<&'static str> {
    let is_lookup_name =
        key.ends_with("Id") && key != "Id" && !key.to_ascii_lowercase().contains("external");
    if !is_lookup_name {
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
        // Files are named by Title.
        let path = Salesforce.names_read("ContentDocument", &["069fn000005ekPSAAY"]);
        assert_eq!(
            decode(&path),
            "SELECT Id, Title FROM ContentDocument WHERE Id IN ('069fn000005ekPSAAY')"
        );
    }

    #[test]
    fn names_parse_from_name_or_title_and_junk_yields_none() {
        assert_eq!(
            Salesforce.parse_names(
                br#"{"records":[{"Id":"001A","Name":"Initech"},{"Id":"069B","Title":"DR"},{"Id":"005C"}]}"#
            ),
            [("001A".into(), "Initech".into()), ("069B".into(), "DR".into())]
        );
        assert!(Salesforce.parse_names(b"[]").is_empty());
        assert!(Salesforce.parse_names(b"<html>").is_empty());
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
