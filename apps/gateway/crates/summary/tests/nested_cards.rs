//! Real-world request bodies through the public summary API: the card each
//! one produces must say what the request does, without a summarizer written
//! for that endpoint. The Flow fixtures have the shape Salesforce sends and
//! answers, with made-up names and ids.

use summary::summarize_request;

const FLOW_NEW: &str = include_str!("fixtures/salesforce_flow_new_version.json");
const FLOW_ACTIVE: &str = include_str!("fixtures/salesforce_flow_active_query.json");
const FLOW_PATH: &str = "/services/data/v62.0/tooling/sobjects/Flow";

fn rows(s: &summary::ApprovalSummary) -> Vec<(String, String)> {
    s.details
        .iter()
        .map(|d| (d.label.clone(), d.value.clone()))
        .collect()
}

fn find<'a>(s: &'a summary::ApprovalSummary, label: &str) -> Option<&'a str> {
    s.details
        .iter()
        .find(|d| d.label == label)
        .map(|d| d.value.as_str())
}

/// An agent moves the Lead Source line to the end of a Flow's Slack message
/// by publishing a new version.
#[test]
fn a_flow_version_reads_as_what_it_changes() {
    let mut s = summarize_request(
        "salesforce",
        "POST",
        FLOW_PATH,
        Some("application/json"),
        Some(FLOW_NEW.as_bytes()),
    );
    assert_eq!(s.action, "Create Flow version Lead_Source_Alert-3");
    // Before the read: the message, then three plain facts. Nothing else.
    assert_eq!(
        rows(&s).iter().map(|(l, _)| l.as_str()).collect::<Vec<_>>(),
        ["Message slack2", "Trigger", "Actions", "Status"],
        "{:?}",
        rows(&s)
    );
    let template = find(&s, "Message slack2").expect("template row");
    assert!(template.contains("*Lead Source:* {!$Record.LeadSource}"));
    assert_eq!(
        find(&s, "Trigger"),
        Some("Contact, when Lead source is changed")
    );
    assert_eq!(find(&s, "Actions"), Some("Post to Sales Channel"));
    let noise = format!("{:?}", rows(&s));
    for gone in [
        "null",
        "Location x",
        "Process metadata values",
        "dataTypeMappings",
    ] {
        assert!(!noise.contains(gone), "{gone} in {noise}");
    }
    // The read the gateway makes: server-built, for this Flow only.
    let hint = s.change_hint().expect("a read for the active version");
    assert!(hint
        .read_path
        .starts_with("/services/data/v60.0/tooling/query?q="));
    assert!(hint.read_path.contains("Lead_Source_Alert"));

    // After the read: the card leads with the one line that moved.
    s.apply_current(FLOW_NEW.as_bytes(), FLOW_ACTIVE.as_bytes());
    let diff = find(&s, "Message slack2").expect("text diff");
    assert_eq!(
        diff,
        "*Lead Source Alert*\n*Name:* {!$Record.FirstName} {!$Record.LastName}\n*Title:* {!$Record.Title}\n*Department:* {!$Record.Department}\n*Description:* {!$Record.Description}\n*Lead Source:* {!$Record.LeadSource}   ← moved"
    );
    // A default the agent spelled out (Offset 0) is not a change.
    assert!(!s.details.iter().any(|d| d.label.contains("Offset")));
    // Only the change leads: the settings that stay as they are are counted.
    assert!(find(&s, "Action calls › Post_to_Sales_Channel › Action name").is_none());
    let unchanged = find(&s, "Unchanged").expect("unchanged count");
    assert!(
        unchanged.ends_with("other settings stay as they are"),
        "{unchanged}"
    );
    // The template is shown once: as the change.
    assert_eq!(
        s.details
            .iter()
            .filter(|d| d.label == "Message slack2")
            .count(),
        1
    );
    assert!(s.render_text().chars().count() <= summary::MAX_RENDER_LEN);
}

/// Drop every `null` (an agent's compact body omits what it leaves unset).
fn without_nulls(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(o) => {
            o.retain(|_, c| !c.is_null());
            o.values_mut().for_each(without_nulls);
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(without_nulls),
        _ => {}
    }
}

/// The same edit, sent compact: the settings the active version answers as
/// `null` are unset on both sides, never "removed".
#[test]
fn a_compact_flow_version_compares_without_phantom_removals() {
    let mut body: serde_json::Value = serde_json::from_str(FLOW_NEW).unwrap();
    without_nulls(&mut body);
    let body = serde_json::to_vec(&body).unwrap();
    let mut s = summarize_request("salesforce", "POST", FLOW_PATH, None, Some(&body));
    s.apply_current(&body, FLOW_ACTIVE.as_bytes());
    let labels: Vec<&str> = s.details.iter().map(|d| d.label.as_str()).collect();
    assert_eq!(labels, ["Message slack2", "Unchanged"], "{:?}", rows(&s));
    assert!(!format!("{:?}", rows(&s)).contains("(removed)"));
}

#[test]
fn activating_and_deactivating_a_flow_say_so() {
    let path = "/services/data/v62.0/tooling/sobjects/FlowDefinition/300AA000000Def1AAA";
    let s = summarize_request(
        "salesforce",
        "PATCH",
        path,
        Some("application/json"),
        Some(br#"{"Metadata":{"activeVersionNumber":0}}"#),
    );
    assert_eq!(s.action, "Deactivate Flow");
    assert!(find(&s, "Effect").unwrap().contains("stops running"));
    let s = summarize_request(
        "salesforce",
        "PATCH",
        path,
        Some("application/json"),
        Some(br#"{"Metadata":{"activeVersionNumber":3}}"#),
    );
    assert_eq!(s.action, "Activate Flow version 3");
}

#[test]
fn a_flow_name_that_is_not_an_api_name_gets_no_read() {
    for name in ["x' OR Name != '", "a b", "", "../x", "acme__Lead_Alert-2"] {
        let body = format!(
            r#"{{"FullName":"{name}","Metadata":{{"label":"x","start":{{"object":"Contact"}}}}}}"#
        );
        let s = summarize_request("salesforce", "POST", FLOW_PATH, None, Some(body.as_bytes()));
        assert!(s.change_hint().is_none(), "{name}");
    }
}

/// Other apps' nested writes, through the same generic reader.
#[test]
fn nested_writes_from_other_apps_read_without_a_summarizer() {
    let cases: &[(&str, &str, &str, &str, &str, &str)] = &[
        (
            "hubspot",
            "PATCH",
            "/crm/v3/objects/deals/123456",
            r#"{"properties":{"amount":"5000","dealstage":"closedwon","hs_next_step":"Send contract"}}"#,
            "Update deal",
            "Properties › Dealstage",
        ),
        (
            "notion",
            "PATCH",
            "/v1/pages/59833787-2cf9-4fdf-8782-e53db20768a5",
            r#"{"properties":{"Status":{"select":{"name":"Done"}},"Owner":{"people":[{"id":"u1"}]}}}"#,
            "Update page",
            "Properties › Status › Select › Name",
        ),
        (
            "jira",
            "PUT",
            "/rest/api/3/issue/10042",
            r#"{"fields":{"summary":"Fix login","priority":{"name":"High"},"labels":["auth","p1"]}}"#,
            "Update issue Fix login",
            "Fields › Labels",
        ),
        (
            "github",
            "POST",
            "/repos/acme/web/issues",
            r#"{"title":"Crash on save","labels":["bug"],"assignees":["dana"],"milestone":null}"#,
            "Create issue Crash on save",
            "Labels",
        ),
    ];
    for (app, m, p, body, title, row) in cases {
        let s = summarize_request(app, m, p, Some("application/json"), Some(body.as_bytes()));
        assert_eq!(&s.action, title, "{app}");
        assert!(find(&s, row).is_some(), "{app}: {:?}", rows(&s));
        assert!(find(&s, "Body").is_none(), "{app}: {:?}", rows(&s));
    }
}

#[test]
fn a_patch_asks_to_read_its_own_path_and_shows_old_to_new() {
    let body = br#"{"properties":{"amount":"5000","dealstage":"closedwon"}}"#;
    let mut s = summarize_request(
        "hubspot",
        "PATCH",
        "/crm/v3/objects/deals/123456",
        Some("application/json"),
        Some(body),
    );
    assert_eq!(
        s.change_hint().unwrap().read_path,
        "/crm/v3/objects/deals/123456"
    );
    s.apply_current(
        body,
        br#"{"id":"123456","properties":{"amount":"3000","dealstage":"closedwon","dealname":"Acme"}}"#,
    );
    assert_eq!(find(&s, "Properties › Amount"), Some("3000 → 5000"));
    assert_eq!(
        find(&s, "Unchanged"),
        Some("1 other setting stays as it is")
    );
}

#[test]
fn secrets_never_reach_a_nested_card() {
    let body = br#"{"config":{"url":"https://hook.example","secret":"whsec_live_1","headers":[{"name":"Authorization","value":"Bearer abc"}]}}"#;
    let s = summarize_request("whatever", "POST", "/v1/webhooks", None, Some(body));
    let all = format!("{:?}", rows(&s));
    assert!(
        !all.contains("whsec_live_1") && !all.contains("Bearer abc"),
        "{all}"
    );
    assert_eq!(s.action, "Create webhook");
}

/// Three more shapes agents write with, through the same reader.
#[test]
fn graphql_form_and_reshaped_lists_read_plainly() {
    // GraphQL: one endpoint for every write; the operation names the action
    // and its arguments read as rows, variables filled in.
    let s = summarize_request(
        "monday",
        "POST",
        "/v2",
        Some("application/json"),
        Some(br#"{"query":"mutation ($id: ID!, $v: JSON!, $t: String) { change_column_value(item_id: $id, column_id: \"status\", value: $v, api_token: $t) { id } }","variables":{"id":"123","v":"{\"label\":\"Done\"}","t":"t-1"}}"#),
    );
    assert_eq!(s.action, "Change column value");
    assert_eq!(find(&s, "Item id"), Some("123"));
    assert_eq!(find(&s, "Column id"), Some("status"));
    assert_eq!(find(&s, "Value"), Some(r#"{"label":"Done"}"#));
    assert_eq!(find(&s, "Api token"), Some("***"));
    assert!(find(&s, "GraphQL").is_none(), "{:?}", rows(&s));
    // Literal arguments, nothing to look up.
    let s = summarize_request(
        "monday",
        "POST",
        "/v2",
        Some("application/json"),
        Some(br#"{"query":"mutation { change_simple_column_value(board_id: 1234567890, item_id: 9876543210, column_id: \"status\", value: \"Done\") { id } }"}"#),
    );
    assert_eq!(s.action, "Change simple column value");
    assert_eq!(find(&s, "Value"), Some("Done"));
    assert_eq!(find(&s, "Item id"), Some("9876543210"));
    assert!(find(&s, "Endpoint").is_none());
    let s = summarize_request(
        "shopify",
        "POST",
        "/admin/api/2024-07/graphql.json",
        None,
        Some(br#"{"query":"mutation { renamed: productUpdate(input: {id: \"gid://shopify/Product/1\", title: \"New\"}) { product { id } } }"}"#),
    );
    assert_eq!(s.action, "Product update");
    assert_eq!(find(&s, "Input › Title"), Some("New"));
    // A document the reader can't place keeps the query as written.
    let s = summarize_request(
        "linear",
        "POST",
        "/graphql",
        None,
        Some(br#"{"query":"mutation { issueUpdate(id: \"x\", input: {title: \"oops\" ) { success } }"}"#),
    );
    assert!(find(&s, "GraphQL").is_some(), "{:?}", rows(&s));

    // Form-encoded (Stripe, Twilio): decoded rows, brackets as nesting.
    let s = summarize_request(
        "stripe",
        "POST",
        "/v1/customers/cus_123",
        Some("application/x-www-form-urlencoded"),
        Some(b"email=a%40b.com&metadata[plan]=pro&api_key=sk_live_1"),
    );
    assert_eq!(find(&s, "Email"), Some("a@b.com"));
    assert_eq!(find(&s, "Metadata › Plan"), Some("pro"));
    assert_eq!(find(&s, "Api key"), Some("***"));
    assert!(find(&s, "Body").is_none());

    // A list sent as names, read back as objects: compared by name.
    let body = br#"{"title":"Crash on save","labels":["bug","p1"]}"#;
    let mut s = summarize_request(
        "github",
        "PATCH",
        "/repos/acme/web/issues/42",
        None,
        Some(body),
    );
    s.apply_current(
        body,
        br#"{"number":42,"title":"Crash","labels":[{"id":1,"name":"bug","color":"f00"}]}"#,
    );
    assert_eq!(find(&s, "Labels"), Some("bug → bug, p1"));
    assert_eq!(find(&s, "Title"), Some("Crash → Crash on save"));
}

/// A flat edit with a long text field (an issue's body): titled by what it
/// changes, the text in full, and the before → after once read.
#[test]
fn a_flat_edit_with_long_text_reads_whole_and_diffs() {
    let body = br#"{"body":"This issue tracks the approval card test.\n\nIt checks that edits show what changed, in plain words, before anyone approves them."}"#;
    let mut s = summarize_request(
        "github-app",
        "PATCH",
        "/repos/acme/web/issues/40",
        Some("application/json"),
        Some(body),
    );
    assert_eq!(s.action, "Update issue");
    let text = find(&s, "Body").expect("body row");
    assert!(text.contains("before anyone approves them"), "{text}");
    s.apply_current(
        body,
        br#"{"number":40,"title":"Approval card test - edited","body":"Line one\nLine two","state":"open"}"#,
    );
    let diff = find(&s, "Body").expect("body diff");
    assert!(
        diff.contains("This issue tracks the approval card test.   ← new"),
        "{diff}"
    );
    assert!(diff.contains("(removed) Line one"), "{diff}");
}
