//! What an APPROVED request actually did, read from the upstream's answer,
//! so a person who approved "Create 9 Accounts" learns that Salesforce created
//! none of them (and why) instead of a bare "Approved". Without it the agent's
//! fixed resend looks like a mystery second approval.
//!
//! Pure and bounded like the summarizers: the gateway peeks a prefix of the
//! response body and hands it here; nothing here does I/O. The result is a
//! count line and at most one short error message, never the response body:
//! the message is clamped, secret-masked, and only ever an upstream's own
//! error text (never a record's values).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How many bytes of the response body the gateway peeks for this.
pub const RESULT_BODY_PEEK: usize = 64 * 1024;
/// Longest error message kept (characters).
const MAX_ERROR_LEN: usize = 160;
/// Salesforce's rollback notices: under `allOrNone`, every record that was
/// fine reports one of these instead of its own outcome (sObject
/// Collections: `ALL_OR_NONE_OPERATION_ROLLED_BACK`; a Composite
/// subrequest stopped by another's failure: `PROCESSING_HALTED`). They are
/// never the cause, so the card names the other error when there is one.
const ROLLBACK_CODES: [&str; 2] = ["ALL_OR_NONE_OPERATION_ROLLED_BACK", "PROCESSING_HALTED"];

/// The upstream's verdict on an approved request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestResult {
    /// Every part of the request succeeded.
    pub ok: bool,
    /// For a request over many records: how many succeeded, of how many.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub succeeded: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    /// The first error the upstream gave, short and masked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Whether `provider` answers this request with one outcome per record, so
/// even a 200 must be read before it counts as a success (a Salesforce
/// sObject Collections write or Composite call). Every other success is
/// judged by its status alone, without reading a byte of its body.
#[must_use]
pub fn answers_per_record(provider: &str, method: &str, path: &str) -> bool {
    provider == "salesforce" && super::salesforce::answers_per_record(method, path)
}

/// The result of an approved request, from its status and its body.
/// `per_record` is [`answers_per_record`]. `body` is the whole body, decoded,
/// or `None` when it was not read or could not be (cut, or an encoding the
/// gateway does not inflate). `None` when the answer can't be judged: a
/// per-record success whose breakdown could not be read may hide every
/// failure, so the card then says only "Approved".
#[must_use]
pub fn request_result(per_record: bool, status: u16, body: Option<&[u8]>) -> Option<RequestResult> {
    let json = body.and_then(super::parse_json);
    let success = (200..300).contains(&status);
    if per_record {
        if let Some(r) = json.as_ref().and_then(salesforce_records) {
            return Some(r);
        }
        if success {
            return None;
        }
    } else if success {
        return Some(RequestResult {
            ok: true,
            succeeded: None,
            total: None,
            error: None,
        });
    }
    Some(RequestResult {
        ok: false,
        succeeded: None,
        total: None,
        error: Some(
            json.as_ref()
                .and_then(first_error_message)
                .unwrap_or_else(|| format!("HTTP {status}")),
        ),
    })
}

/// Salesforce sObject Collections answer 200 with one save result per record
/// (`[{"success": false, "errors": [{"message", "fields"}]}, …]`), and a
/// Composite call 200 with one result per subrequest
/// (`{"compositeResponse": [{"httpStatusCode", "body"}]}`). A 200 is NOT
/// success here: every record can have failed.
fn salesforce_records(json: &Value) -> Option<RequestResult> {
    if let Some(items) = json.as_array() {
        let saves = save_results(items)?;
        let succeeded = saves.iter().filter(|s| saved(s)).count();
        let errors = saves
            .iter()
            .filter(|s| !saved(s))
            .flat_map(|s| errors_of(s));
        return Some(counted(succeeded, saves.len(), first_cause(errors)));
    }
    let subs: Vec<(u64, &Value)> = json
        .get("compositeResponse")?
        .as_array()?
        .iter()
        .filter_map(|s| Some((s.get("httpStatusCode")?.as_u64()?, s.get("body")?)))
        .collect();
    if subs.is_empty() {
        return None;
    }
    let mut succeeded = 0;
    let mut errors: Vec<&Value> = Vec::new();
    for (code, body) in &subs {
        let items = body.as_array().map(Vec::as_slice).unwrap_or_default();
        // A nested sObject Collections subrequest answers 200 even when a
        // record failed or was rolled back, so it is judged record by record.
        let (all_saved, failures): (bool, Vec<&Value>) = match save_results(items) {
            Some(saves) => (
                saves.iter().all(|s| saved(s)),
                saves
                    .iter()
                    .filter(|s| !saved(s))
                    .flat_map(|s| errors_of(s))
                    .collect(),
            ),
            None => (true, items.iter().collect()),
        };
        if (200..300).contains(code) && all_saved {
            succeeded += 1;
        } else {
            errors.extend(failures);
        }
    }
    Some(counted(
        succeeded,
        subs.len(),
        first_cause(errors.into_iter()),
    ))
}

/// `items` as save results (every object carries `success`), or `None`.
fn save_results(items: &[Value]) -> Option<Vec<&serde_json::Map<String, Value>>> {
    let saves: Vec<_> = items.iter().filter_map(Value::as_object).collect();
    (!saves.is_empty() && saves.iter().all(|s| s.contains_key("success"))).then_some(saves)
}

fn saved(save: &serde_json::Map<String, Value>) -> bool {
    save.get("success").and_then(Value::as_bool) == Some(true)
}

fn errors_of(save: &serde_json::Map<String, Value>) -> impl Iterator<Item = &Value> {
    save.get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn counted(succeeded: usize, total: usize, error: Option<String>) -> RequestResult {
    RequestResult {
        ok: succeeded == total,
        succeeded: Some(u32::try_from(succeeded).unwrap_or(u32::MAX)),
        total: Some(u32::try_from(total).unwrap_or(u32::MAX)),
        error: if succeeded == total { None } else { error },
    }
}

/// The first Salesforce error that names a cause, across every failed
/// record; a rollback notice only when nothing else was said.
fn first_cause<'a>(errors: impl Iterator<Item = &'a Value>) -> Option<String> {
    let errors: Vec<&Value> = errors.collect();
    let is_rollback = |e: &&Value| {
        ["statusCode", "errorCode"].iter().any(|key| {
            e.get(key)
                .and_then(Value::as_str)
                .is_some_and(|code| ROLLBACK_CODES.contains(&code))
        })
    };
    errors
        .iter()
        .find(|e| !is_rollback(e))
        .or_else(|| errors.first())
        .and_then(|e| salesforce_error(e))
}

/// `{"message": "...", "fields": ["BillingCountry"]}` → "BillingCountry:
/// <message>" (Salesforce often ends the message with the field already).
fn salesforce_error(error: &Value) -> Option<String> {
    let message = error.get("message")?.as_str()?;
    let field = error
        .get("fields")
        .and_then(Value::as_array)
        .and_then(|f| f.first())
        .and_then(Value::as_str);
    Some(short(&match field {
        Some(f) if !message.contains(f) => format!("{f}: {message}"),
        _ => message.to_string(),
    }))
}

/// The usual JSON error shapes: `{"error": {"message"}}`, `{"error": "…"}`,
/// `{"message": "…"}`, `{"errors": [{"message"}]}`, or Salesforce's
/// `[{"message", "errorCode"}]`.
fn first_error_message(json: &Value) -> Option<String> {
    let text = match json {
        Value::Array(items) => items.first()?.get("message")?.as_str()?.to_string(),
        Value::Object(o) => o
            .get("error")
            .and_then(|e| {
                e.as_str()
                    .map(str::to_string)
                    .or_else(|| e.get("message")?.as_str().map(str::to_string))
            })
            .or_else(|| o.get("message")?.as_str().map(str::to_string))
            .or_else(|| {
                o.get("errors")?
                    .as_array()?
                    .first()?
                    .get("message")?
                    .as_str()
                    .map(str::to_string)
            })?,
        _ => return None,
    };
    Some(short(&text))
}

/// One line, token-shaped words masked, clamped. An upstream error can echo
/// what it was sent (a bad key in "invalid api key sk-…"); a long unbroken
/// run of key characters is never readable prose, so it never reaches a card.
fn short(text: &str) -> String {
    let one_line = text
        .split_whitespace()
        .map(|w| if looks_like_token(w) { "***" } else { w })
        .collect::<Vec<_>>()
        .join(" ");
    super::clamp(&one_line, MAX_ERROR_LEN)
}

/// 24+ characters of letters, digits, `-`, `_`, `.`, `/`, `+`, `=` with at
/// least one digit: the shape of API keys, bearer tokens and JWTs, not words.
fn looks_like_token(word: &str) -> bool {
    let core = word.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ':' | '(' | ')'));
    core.len() >= 24
        && core.chars().any(|c| c.is_ascii_digit())
        && core
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '+' | '='))
}

#[cfg(test)]
mod tests {
    use super::*;

    const COUNTRY: &str = r#"{"success":false,"errors":[{"statusCode":"FIELD_INTEGRITY_EXCEPTION","message":"There's a problem with this country, even though it may appear correct. Please select a country/territory from the list of valid countries.: Billing Country","fields":["BillingCountry"]}]}"#;

    /// A Salesforce per-record answer, read whole.
    fn per_record(status: u16, body: &str) -> Option<RequestResult> {
        request_result(true, status, Some(body.as_bytes()))
    }

    #[test]
    fn a_200_where_every_record_failed_is_a_failure() {
        // "Create 9 Accounts" approved, Salesforce answered 200 and created
        // none of them.
        let body = format!("[{}]", [COUNTRY; 9].join(","));
        let r = per_record(200, &body).unwrap();
        assert!(!r.ok);
        assert_eq!((r.succeeded, r.total), (Some(0), Some(9)));
        let error = r.error.unwrap();
        assert!(
            error.starts_with("BillingCountry: There's a problem"),
            "{error}"
        );
        assert!(error.chars().count() <= MAX_ERROR_LEN);
    }

    #[test]
    fn a_partial_success_counts_both() {
        let body = format!(r#"[{{"id":"001","success":true,"errors":[]}},{COUNTRY}]"#);
        let r = per_record(200, &body).unwrap();
        assert_eq!((r.ok, r.succeeded, r.total), (false, Some(1), Some(2)));
    }

    #[test]
    fn a_full_success_has_counts_and_no_error() {
        let body =
            r#"[{"id":"001","success":true,"errors":[]},{"id":"002","success":true,"errors":[]}]"#;
        assert_eq!(
            per_record(200, body),
            Some(RequestResult {
                ok: true,
                succeeded: Some(2),
                total: Some(2),
                error: None
            })
        );
    }

    #[test]
    fn composite_counts_subrequests_by_status() {
        let body = r#"{"compositeResponse":[{"httpStatusCode":204,"body":null},{"httpStatusCode":400,"body":[{"message":"bad value","errorCode":"X","fields":["Industry"]}]}]}"#;
        let r = per_record(200, body).unwrap();
        assert_eq!((r.succeeded, r.total), (Some(1), Some(2)));
        assert_eq!(r.error.as_deref(), Some("Industry: bad value"));
    }

    #[test]
    fn an_all_or_none_rollback_names_the_real_cause() {
        // Salesforce's own example (sObject Collections create, allOrNone
        // true): the valid record reports only that it was rolled back, and
        // it may come first.
        let body = r#"[
            {"success":false,"errors":[{"statusCode":"ALL_OR_NONE_OPERATION_ROLLED_BACK","message":"Record rolled back because not all records were valid and the request was using AllOrNone header","fields":[]}]},
            {"success":false,"errors":[{"statusCode":"DUPLICATES_DETECTED","message":"Use one of these records?","fields":[]}]}
        ]"#;
        let r = per_record(200, body).unwrap();
        assert_eq!((r.succeeded, r.total), (Some(0), Some(2)));
        assert_eq!(r.error.as_deref(), Some("Use one of these records?"));

        // Composite (Salesforce's own example, allOrNone true around a
        // nested sObject Collections create): the collection answers 200 yet
        // one record failed, and the halted subrequest only says it was
        // rolled back. Nothing was created, and the cause is the duplicate.
        let body = r#"{"compositeResponse":[
            {"body":[{"id":"001AA00000AbCdEFGH","success":true,"errors":[]},{"success":false,"errors":[{"statusCode":"DUPLICATES_DETECTED","message":"Use one of these records?","fields":[]}]}],"httpHeaders":{},"httpStatusCode":200,"referenceId":"collection1"},
            {"body":[{"errorCode":"PROCESSING_HALTED","message":"The transaction was rolled back since another operation in the same transaction failed."}],"httpHeaders":{},"httpStatusCode":400,"referenceId":"newContact"}
        ]}"#;
        let r = per_record(200, body).unwrap();
        assert_eq!((r.ok, r.succeeded, r.total), (false, Some(0), Some(2)));
        assert_eq!(r.error.as_deref(), Some("Use one of these records?"));

        // A rolled-back nested collection beside a created record is not
        // "2 of 2": its 200 carries no saved record.
        let body = r#"{"compositeResponse":[
            {"body":[{"success":false,"errors":[{"statusCode":"ALL_OR_NONE_OPERATION_ROLLED_BACK","message":"Record rolled back because not all records were valid and the request was using AllOrNone header","fields":[]}]},{"success":false,"errors":[{"statusCode":"DUPLICATES_DETECTED","message":"Use one of these records?","fields":[]}]}],"httpStatusCode":200},
            {"body":{"id":"003AA00000AbCdEFGH","success":true,"errors":[]},"httpStatusCode":201}
        ]}"#;
        let r = per_record(200, body).unwrap();
        assert_eq!((r.ok, r.succeeded, r.total), (false, Some(1), Some(2)));
        assert_eq!(r.error.as_deref(), Some("Use one of these records?"));

        // Only rollback notices: that is all there is to say.
        let body = r#"[{"success":false,"errors":[{"statusCode":"ALL_OR_NONE_OPERATION_ROLLED_BACK","message":"Record rolled back","fields":[]}]}]"#;
        assert_eq!(
            per_record(200, body).unwrap().error.as_deref(),
            Some("Record rolled back")
        );
    }

    #[test]
    fn a_plain_success_is_judged_by_its_status_alone() {
        let ok = Some(RequestResult {
            ok: true,
            succeeded: None,
            total: None,
            error: None,
        });
        // Never read: the gateway streams a plain success without peeking.
        assert_eq!(request_result(false, 200, None), ok);
        assert_eq!(request_result(false, 204, Some(b"")), ok);
    }

    #[test]
    fn a_per_record_success_that_could_not_be_read_is_not_judged() {
        // A 200 whose per-record list was cut (or does not decode) could hide
        // every failure: unknown, never "ok".
        assert_eq!(request_result(true, 200, None), None);
        assert_eq!(per_record(200, r#"{"id":"001","success":true}"#), None);
    }

    #[test]
    fn an_error_status_names_the_upstream_message() {
        let failed = |status, body: &[u8]| request_result(false, status, Some(body)).unwrap();
        let r = failed(422, br#"{"message":"Validation Failed"}"#);
        assert_eq!(r.error.as_deref(), Some("Validation Failed"));
        assert_eq!(
            failed(500, b"<html>oops</html>").error.as_deref(),
            Some("HTTP 500")
        );
        assert_eq!(
            failed(400, br#"{"error":{"message":"nope"}}"#)
                .error
                .as_deref(),
            Some("nope")
        );
        // Salesforce's top-level error list (a refused single-record call).
        assert_eq!(
            per_record(400, r#"[{"message":"bad","errorCode":"X"}]"#)
                .unwrap()
                .error
                .as_deref(),
            Some("bad")
        );
    }

    #[test]
    fn an_error_never_carries_a_secret() {
        let body = br#"{"message":"invalid api key: sk-ant-api03-Xy7Qa1Bc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9"}"#;
        let r = request_result(false, 401, Some(body)).unwrap();
        assert_eq!(r.error.as_deref(), Some("invalid api key: ***"));
    }

    #[test]
    fn an_unreadable_error_still_names_its_status() {
        let r = request_result(true, 500, None).unwrap();
        assert_eq!((r.ok, r.error.as_deref()), (false, Some("HTTP 500")));
    }
}
