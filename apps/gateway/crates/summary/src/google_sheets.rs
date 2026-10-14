//! Google Sheets: manual-approval summaries for writes.
//!
//! A cell write reads as WHERE and WHAT: one row per range (`Sheet1!C5`)
//! with the values it writes, so the approver checks the change without
//! decoding the API's nested arrays. Values read as the API applies them:
//! `""` empties a cell, `null` leaves it as it is, and `majorDimension:
//! COLUMNS` lists columns, read back here row by row. A body the gateway
//! could not read whole (cut at its peek, or not JSON) gets the generic card,
//! never a partial list passed off as the whole write. The spreadsheet is a
//! record the gateway names (its title) and links, through this module's
//! [`RecordResolver`]. Registered as the `"google-sheets"` summarizer in
//! [`super::summarizer`].

use serde::Deserialize;
use serde_json::{Map, Value};

use super::record_links::is_token;
use super::records::{Named, Target};
use super::redact::{redact_string, redact_value};
use super::{
    clamp, decode_segment, humanize_key, json_object, one_line, ApprovalSummary, RecordResolver,
    RequestSummarizer, SummaryRequest, MAX_FIELD_ROWS, MAX_VALUE_LEN,
};

pub(super) struct GoogleSheets;

/// A `null` cell in a write: the API skips it, so the cell keeps its value.
const UNCHANGED: &str = "(unchanged)";

impl RequestSummarizer for GoogleSheets {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let segs: Vec<&str> = req
            .base_path()
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        // Every write here carries its values in a JSON body: one it can't
        // parse whole is shown as sent (the generic card) instead.
        let body = match req.body {
            Some(b) => Some(json_object(b)?),
            None => None,
        };
        let body = body.as_ref();
        let m = req.method_upper();
        match (m.as_str(), segs.as_slice()) {
            ("POST", ["v4", "spreadsheets"]) => Some(create(body)),
            // `{id}:batchUpdate` is one segment; `values:batchUpdate` another.
            ("POST", ["v4", "spreadsheets", id_op]) => {
                let (id, op) = id_op.split_once(':')?;
                (op == "batchUpdate").then(|| structural(id, body))
            }
            ("POST", ["v4", "spreadsheets", id, "values:batchUpdate"]) => {
                let mut s = sheet_card("Update cells", id);
                let data: Vec<(&str, &Map<String, Value>)> = body
                    .and_then(|b| b.get("data"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|d| {
                        let d = d.as_object()?;
                        Some((d.get("range")?.as_str()?, d))
                    })
                    .collect();
                for (range, values) in data.iter().take(MAX_FIELD_ROWS) {
                    s.push(range_label(range), preview(Some(values)));
                }
                if data.len() > MAX_FIELD_ROWS {
                    let hidden = data.len() - MAX_FIELD_ROWS;
                    s.push("More", format!("+{hidden} more ranges"));
                }
                Some(s)
            }
            ("POST", ["v4", "spreadsheets", id, "values:batchClear"]) => {
                let mut s = sheet_card("Clear cells", id);
                let ranges: Vec<String> = body
                    .and_then(|b| b.get("ranges"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(range_label)
                    .collect();
                if !ranges.is_empty() {
                    s.push("Ranges", ranges.join(", "));
                }
                Some(s)
            }
            ("PUT", ["v4", "spreadsheets", id, "values", range]) => {
                let mut s = sheet_card("Update cells", id);
                s.push(range_label(&decode_segment(range)), preview(body));
                Some(s)
            }
            ("POST", ["v4", "spreadsheets", id, "values", range_op]) => {
                let (range, op) = range_op.rsplit_once(':')?;
                let range = range_label(&decode_segment(range));
                match op {
                    "append" => {
                        let mut s = sheet_card("Append rows", id);
                        s.push(range, preview(body));
                        Some(s)
                    }
                    "clear" => {
                        let mut s = sheet_card("Clear cells", id);
                        s.push("Range", range);
                        Some(s)
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

/// A card about spreadsheet `id`: its row (named and linked by the
/// gateway), and the title says which one once named.
fn sheet_card(action: &str, id: &str) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(action);
    if is_token(id) {
        s.push_named(SPREADSHEET, SPREADSHEET, id, id, Named::WithId);
        s.target = Some(Target::of(id, " in ", Some("spreadsheet".into())));
    }
    s
}

fn create(body: Option<&Map<String, Value>>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new("Create spreadsheet");
    let props = body.and_then(|b| b.get("properties"));
    if let Some(title) = props.and_then(|p| p.get("title")).and_then(Value::as_str) {
        s.push("Title", title);
    }
    let sheets = body
        .and_then(|b| b.get("sheets"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if sheets > 0 {
        s.push("Sheets", sheets.to_string());
    }
    s
}

/// `{id}:batchUpdate`: structural edits, listed by kind ("Add sheet,
/// Delete rows or columns ×2").
fn structural(id: &str, body: Option<&Map<String, Value>>) -> ApprovalSummary {
    let mut s = sheet_card("Edit spreadsheet", id);
    let requests = body
        .and_then(|b| b.get("requests"))
        .and_then(Value::as_array);
    let mut kinds: Vec<(String, usize)> = Vec::new();
    for kind in requests
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|r| r.keys().next())
    {
        let label = request_label(kind);
        match kinds.iter_mut().find(|(k, _)| *k == label) {
            Some((_, n)) => *n += 1,
            None => kinds.push((label, 1)),
        }
    }
    if !kinds.is_empty() {
        let list = kinds
            .iter()
            .map(|(k, n)| {
                if *n > 1 {
                    format!("{k} ×{n}")
                } else {
                    k.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push("Changes", list);
    }
    s
}

/// A `batchUpdate` request kind in words. The common ones are spelled out;
/// the rest read from the API name (`updateBorders` → "Update borders"),
/// on one line since the agent writes the key.
fn request_label(kind: &str) -> String {
    match kind {
        "addSheet" => "Add sheet".into(),
        "deleteSheet" => "Delete sheet".into(),
        "duplicateSheet" => "Duplicate sheet".into(),
        "updateSheetProperties" => "Update sheet settings".into(),
        "insertDimension" => "Insert rows or columns".into(),
        "deleteDimension" => "Delete rows or columns".into(),
        "appendDimension" => "Add rows or columns".into(),
        "updateCells" | "appendCells" => "Write cells".into(),
        "repeatCell" => "Format cells".into(),
        "findReplace" => "Find and replace".into(),
        "sortRange" => "Sort range".into(),
        "deleteRange" => "Delete cells".into(),
        other => one_line(&humanize_key(other), MAX_VALUE_LEN),
    }
}

/// A range as a row label: the agent writes it, so it stays on one line.
fn range_label(range: &str) -> String {
    one_line(range, MAX_VALUE_LEN)
}

/// The values a range gets (a `ValueRange`), as the approver checks them:
/// one cell is just its value; a block says its size, then reads row by row
/// (`a | b; c | d`). Only what fits on the card is rendered, however big the
/// block.
fn preview(range: Option<&Map<String, Value>>) -> String {
    let lines: Vec<&[Value]> = range
        .and_then(|r| r.get("values"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|line| line.as_array().map_or(&[][..], Vec::as_slice))
        .collect();
    let by_column = range
        .and_then(|r| r.get("majorDimension"))
        .and_then(Value::as_str)
        == Some("COLUMNS");
    let longest = lines.iter().map(|l| l.len()).max().unwrap_or(0);
    let (rows, cols) = if by_column {
        (longest, lines.len())
    } else {
        (lines.len(), longest)
    };
    // Row `r` as the sheet gets it: a line, or (by column) the `r`-th cell
    // of each column, where a column too short to reach it leaves it as is.
    // A line with no cells writes nothing.
    let row = |r: usize| -> String {
        let cells: Vec<String> = if by_column {
            let width = lines
                .iter()
                .rposition(|col| col.len() > r)
                .map_or(0, |c| c + 1);
            lines
                .iter()
                .take(width)
                .map(|col| col.get(r).map_or_else(|| UNCHANGED.to_string(), cell))
                .collect()
        } else {
            lines
                .get(r)
                .into_iter()
                .flat_map(|l| l.iter())
                .map(cell)
                .collect()
        };
        if cells.is_empty() {
            UNCHANGED.into()
        } else {
            cells.join(" | ")
        }
    };
    match (rows, cols) {
        (0, _) | (_, 0) => "(no values)".into(),
        (1, 1) => row(0),
        (r, c) => {
            let mut text = format!("{} × {}: ", plural(r, "row"), plural(c, "column"));
            for i in 0..r {
                if text.chars().count() > MAX_VALUE_LEN {
                    break;
                }
                if i > 0 {
                    text.push_str("; ");
                }
                text.push_str(&row(i));
            }
            clamp(&text, MAX_VALUE_LEN)
        }
    }
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

fn cell(v: &Value) -> String {
    match v {
        Value::Null => UNCHANGED.into(),
        Value::String(s) if s.trim().is_empty() => "(blank)".into(),
        Value::String(s) => one_line(&redact_string(s), MAX_VALUE_LEN),
        // Not a cell the API takes (it writes strings, numbers and bools),
        // but shown masked as the generic card would.
        other => redact_string(&redact_value(None, other).to_string()),
    }
}

// ── Naming the spreadsheet ───────────────────────────────────────────────

const SPREADSHEET: &str = "Spreadsheet";

impl RecordResolver for GoogleSheets {
    fn object_of(&self, id: &str) -> Option<&'static str> {
        is_token(id).then_some(SPREADSHEET)
    }

    /// The spreadsheet's title, one read for the first id (a card names one
    /// spreadsheet). The id is re-checked as a plain token, so the path is
    /// fully server-built.
    fn names_read(&self, _object: &str, ids: &[&str]) -> String {
        let id = ids.iter().copied().find(|id| is_token(id)).unwrap_or("-");
        format!("/v4/spreadsheets/{id}?fields=spreadsheetId,properties.title")
    }

    fn parse_names(&self, _object: &str, body: &[u8]) -> Vec<(String, String)> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Sheet {
            spreadsheet_id: String,
            properties: Props,
        }
        #[derive(Deserialize)]
        struct Props {
            title: String,
        }
        serde_json::from_slice::<Sheet>(body)
            .map(|s| vec![(s.spreadsheet_id, s.properties.title)])
            .unwrap_or_default()
    }

    fn record_url(&self, _host: &str, id: &str) -> Option<String> {
        is_token(id).then(|| format!("https://docs.google.com/spreadsheets/d/{id}/edit"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::summarize_request;
    use super::*;

    const ID: &str = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdE";

    fn sheets(method: &str, path: &str, body: Option<&str>) -> ApprovalSummary {
        summarize_request(
            "google-sheets",
            method,
            path,
            Some("application/json"),
            body.map(str::as_bytes),
        )
    }

    fn rows(s: &ApprovalSummary) -> Vec<(&str, &str)> {
        s.details
            .iter()
            .map(|d| (d.label.as_str(), d.value.as_str()))
            .collect()
    }

    #[test]
    fn a_values_batch_update_reads_range_by_range() {
        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}/values:batchUpdate"),
            Some(
                r#"{"valueInputOption":"USER_ENTERED","data":[
                {"range":"Sheet1!C5","values":[[4200]]},
                {"range":"Budget!A1:B2","values":[["Item","Cost"],["Ads",""]]},
                {"range":"Notes!A1","values":[]}]}"#,
            ),
        );
        assert_eq!(s.action, "Update cells");
        assert_eq!(
            rows(&s),
            [
                ("Spreadsheet", ID),
                ("Sheet1!C5", "4200"),
                (
                    "Budget!A1:B2",
                    "2 rows × 2 columns: Item | Cost; Ads | (blank)"
                ),
                ("Notes!A1", "(no values)"),
            ]
        );
        assert_eq!(s.ref_ids().collect::<Vec<_>>(), [ID]);
    }

    /// The API skips a `null` cell (it keeps its value) and empties a `""`
    /// one: the card says which, never "(blank)" for both.
    #[test]
    fn a_null_cell_reads_as_unchanged_not_blank() {
        let s = sheets(
            "PUT",
            &format!("/v4/spreadsheets/{ID}/values/A1:C1"),
            Some(r#"{"values":[["x",null,""]]}"#),
        );
        assert_eq!(
            rows(&s)[1],
            ("A1:C1", "1 row × 3 columns: x | (unchanged) | (blank)")
        );
        // A secret-named key never shows, even in a cell the API would refuse.
        let s = sheets(
            "PUT",
            &format!("/v4/spreadsheets/{ID}/values/A1"),
            Some(r#"{"values":[[{"password":"hunter2"}]]}"#),
        );
        assert_eq!(rows(&s)[1], ("A1", r#"{"password":"***"}"#));
    }

    /// `majorDimension: COLUMNS` lists columns: the card still reads row by
    /// row, as the sheet will show it.
    #[test]
    fn a_column_major_write_reads_row_by_row() {
        let s = sheets(
            "PUT",
            &format!("/v4/spreadsheets/{ID}/values/A1:B2"),
            Some(r#"{"majorDimension":"COLUMNS","values":[[1,2],[3]]}"#),
        );
        assert_eq!(rows(&s)[1], ("A1:B2", "2 rows × 2 columns: 1 | 3; 2"));
        let s = sheets(
            "PUT",
            &format!("/v4/spreadsheets/{ID}/values/A1:A3"),
            Some(r#"{"majorDimension":"COLUMNS","values":[["a","b","c"]]}"#),
        );
        assert_eq!(rows(&s)[1], ("A1:A3", "3 rows × 1 column: a; b; c"));
    }

    #[test]
    fn many_ranges_collapse_and_long_values_are_bounded() {
        let data: Vec<String> = (1..=15)
            .map(|i| {
                format!(
                    r#"{{"range":"S!A{i}","values":[["{}"]]}}"#,
                    "a note. ".repeat(50)
                )
            })
            .collect();
        let body = format!(r#"{{"data":[{}]}}"#, data.join(","));
        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}/values:batchUpdate"),
            Some(&body),
        );
        assert_eq!(s.details.len(), 1 + MAX_FIELD_ROWS + 1);
        assert_eq!(rows(&s)[1], ("S!A1", "<400 chars>"));
        assert_eq!(rows(&s).last().unwrap(), &("More", "+3 more ranges"));
        // A huge block renders only what fits.
        let block: Vec<String> = (0..5000).map(|i| format!("[{i},{i}]")).collect();
        let body = format!(r#"{{"values":[{}]}}"#, block.join(","));
        let s = sheets(
            "PUT",
            &format!("/v4/spreadsheets/{ID}/values/A1:B5000"),
            Some(&body),
        );
        let value = rows(&s)[1].1;
        assert!(value.starts_with("5000 rows × 2 columns: 0 | 0; 1 | 1"));
        assert!(value.chars().count() <= MAX_VALUE_LEN);
    }

    /// A body cut at the gateway's peek (or not JSON) would list only some
    /// of the write: the card shows it as sent instead.
    #[test]
    fn a_body_it_cannot_read_whole_gets_the_generic_card() {
        let whole = r#"{"data":[{"range":"A1","values":[[1]]},{"range":"B1","values":[[2]]}]}"#;
        let cut = &whole[..whole.len() - 20];
        let path = format!("/v4/spreadsheets/{ID}/values:batchUpdate");
        assert_eq!(sheets("POST", &path, Some(cut)).action, "POST request");
        assert_eq!(sheets("POST", &path, Some("[1]")).action, "POST request");
        assert_eq!(sheets("POST", &path, Some(whole)).action, "Update cells");
    }

    /// A range is agent text: it can't forge a second row on the card.
    #[test]
    fn a_range_stays_on_one_line() {
        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}/values:batchUpdate"),
            Some(r#"{"data":[{"range":"A1\nApproved by: admin","values":[["x\ny"]]}]}"#),
        );
        assert_eq!(rows(&s)[1], ("A1 Approved by: admin", "x y"));
        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}/values/A1%0Ab:clear"),
            None,
        );
        assert_eq!(rows(&s)[1], ("Range", "A1 b"));
    }

    #[test]
    fn single_range_writes_decode_the_range() {
        let s = sheets(
            "PUT",
            &format!("/v4/spreadsheets/{ID}/values/My%20Sheet!A1%3AB1?valueInputOption=RAW"),
            Some(r#"{"values":[["a","b"]]}"#),
        );
        assert_eq!(s.action, "Update cells");
        assert_eq!(rows(&s)[1], ("My Sheet!A1:B1", "1 row × 2 columns: a | b"));

        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}/values/Log!A:C:append"),
            Some(r#"{"values":[["2026-10-01","ok",3]]}"#),
        );
        assert_eq!(s.action, "Append rows");
        assert_eq!(
            rows(&s)[1],
            ("Log!A:C", "1 row × 3 columns: 2026-10-01 | ok | 3")
        );

        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}/values/A1:Z2000:clear"),
            None,
        );
        assert_eq!(s.action, "Clear cells");
        assert_eq!(rows(&s)[1], ("Range", "A1:Z2000"));
        // An escape that isn't UTF-8 keeps the range as sent.
        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}/values/A%FF1:clear"),
            None,
        );
        assert_eq!(rows(&s)[1], ("Range", "A%FF1"));
    }

    #[test]
    fn structural_edits_are_listed_by_kind() {
        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}:batchUpdate"),
            Some(
                r#"{"requests":[{"addSheet":{}},{"deleteDimension":{}},
                {"deleteDimension":{}},{"updateBorders":{}},{"x\nApproved":{}}]}"#,
            ),
        );
        assert_eq!(s.action, "Edit spreadsheet");
        assert_eq!(
            rows(&s)[1],
            (
                "Changes",
                "Add sheet, Delete rows or columns ×2, Update borders, X approved"
            )
        );
    }

    /// Named, the row keeps the id after the title, so two spreadsheets of
    /// one name never read as one.
    #[test]
    fn the_title_names_the_spreadsheet_once_named() {
        let mut s = sheets(
            "PUT",
            &format!("/v4/spreadsheets/{ID}/values/A1"),
            Some(r#"{"values":[[1]]}"#),
        );
        s.name_refs(|_| Some("Q4 Budget"));
        s.finalize_title();
        assert_eq!(s.action, "Update cells in spreadsheet Q4 Budget");
        assert_eq!(rows(&s)[0], ("Spreadsheet", &*format!("Q4 Budget ({ID})")));
    }

    #[test]
    fn create_and_unknown_shapes() {
        let s = sheets(
            "POST",
            "/v4/spreadsheets",
            Some(r#"{"properties":{"title":"Plan"},"sheets":[{},{}]}"#),
        );
        assert_eq!(s.action, "Create spreadsheet");
        assert_eq!(rows(&s), [("Title", "Plan"), ("Sheets", "2")]);
        // Not a write this module knows: the generic card.
        let s = sheets(
            "POST",
            &format!("/v4/spreadsheets/{ID}:getByDataFilter"),
            None,
        );
        assert_eq!(s.action, "POST request");
        // An id that isn't a plain token is never a record.
        let s = sheets("PUT", "/v4/spreadsheets/a%2Fb/values/A1", Some("{}"));
        assert_eq!(s.ref_ids().count(), 0);
    }

    #[test]
    fn the_name_read_is_server_built_and_parsed_strictly() {
        let r = GoogleSheets;
        assert_eq!(r.object_of(ID), Some(SPREADSHEET));
        assert_eq!(r.object_of("a/b?c"), None);
        assert_eq!(
            r.names_read(SPREADSHEET, &[ID]),
            format!("/v4/spreadsheets/{ID}?fields=spreadsheetId,properties.title")
        );
        let body = format!(r#"{{"spreadsheetId":"{ID}","properties":{{"title":"Q4"}}}}"#);
        assert_eq!(
            r.parse_names(SPREADSHEET, body.as_bytes()),
            [(ID.to_string(), "Q4".to_string())]
        );
        assert!(r.parse_names(SPREADSHEET, b"{\"error\":{}}").is_empty());
        assert_eq!(
            r.record_url("sheets.googleapis.com", ID).as_deref(),
            Some(&*format!(
                "https://docs.google.com/spreadsheets/d/{ID}/edit"
            ))
        );
    }
}
