//! Twilio: manual-approval summaries.
//!
//! Twilio's REST APIs take form-encoded bodies (`To=…&From=…&Body=…`), which
//! the generic fallback can only show as a raw blob next to the raw path,
//! Account SID and all. This names the action the way the Twilio Console does
//! ("Send SMS", "Place call", "Release phone number") and shows the fields a
//! person deciding needs: who it reaches, from which number, and what it says.
//!
//! Paths are matched without the host: each product's paths are distinct
//! (`/2010-04-01/Accounts/…` core API, `/v2/Services/*/Verifications` Verify,
//! `/v2/PhoneNumbers/*` Lookup), and the same paths answer in every region.
//! Anything not recognized defers to the generic summary. Registered as the
//! `"twilio"` summarizer in [`super::summarizer`].

use super::{
    decode_segment, one_line, ApprovalSummary, RequestSummarizer, SummaryRequest, MAX_SNIPPET_LEN,
    MAX_VALUE_LEN,
};

pub(super) struct Twilio;

/// The note on every Account-resource card: Twilio answers those requests
/// with the Auth Token (the subaccounts' too, on the list), so an approval
/// there hands the agent the master credential.
const AUTH_TOKEN_NOTE: &str = "Twilio's answer includes the Auth Token";

/// The form fields of a request body, in order. Twilio's API is form-encoded
/// (a truncated peek still yields every field before the cut).
fn form(req: &SummaryRequest<'_>) -> Vec<(String, String)> {
    req.body
        .map(|b| {
            form_urlencoded::parse(b)
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn field<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.trim().is_empty())
}

/// One single-line row. Every agent-supplied value goes through `one_line`,
/// so a newline in it can never forge a row of the rendered card.
fn push_line(s: &mut ApprovalSummary, label: &str, value: &str) {
    s.push(label, one_line(value, MAX_VALUE_LEN));
}

fn push_field(s: &mut ApprovalSummary, label: &str, fields: &[(String, String)], key: &str) {
    if let Some(v) = field(fields, key) {
        push_line(s, label, v);
    }
}

/// `whatsapp:+1555…` reads as the number, the channel goes in the title.
fn strip_channel(v: &str) -> &str {
    v.strip_prefix("whatsapp:").unwrap_or(v)
}

/// The path's segments after `/2010-04-01/Accounts/{AccountSid}`, with the
/// `.json` suffix of the last one removed, plus the Account SID masked to its
/// last 4 (`AC…a4d1`). Every core card carries it as its `Account` row, so a
/// card always has a readable row and the raw path (SID in full) stays in
/// Details. Empty segments are the account itself; `None` when this is not a
/// core (2010) account path.
fn account_segments(path: &str) -> Option<(String, Vec<String>)> {
    let rest = path.strip_prefix("/2010-04-01/Accounts/")?;
    let mut segs: Vec<String> = rest
        .split('/')
        .filter(|s| !s.is_empty())
        .map(decode_segment)
        .collect();
    if segs.is_empty() {
        return None;
    }
    let sid = segs.remove(0);
    let sid = sid.strip_suffix(".json").unwrap_or(&sid).to_string();
    if let Some(last) = segs.last_mut() {
        if let Some(stem) = last.strip_suffix(".json") {
            *last = stem.to_string();
        }
    }
    Some((mask_sid(&sid), segs))
}

/// `AC0123…cdef` → `AC…cdef`: enough to tell two accounts apart.
fn mask_sid(sid: &str) -> String {
    let chars: Vec<char> = sid.chars().collect();
    if chars.len() <= 6 {
        return sid.to_string();
    }
    let head: String = chars[..2].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn send_message(fields: &[(String, String)]) -> ApprovalSummary {
    let to = field(fields, "To").unwrap_or("");
    let channel = if to.starts_with("whatsapp:") {
        "WhatsApp message"
    } else if field(fields, "MediaUrl").is_some() {
        "MMS"
    } else {
        "SMS"
    };
    let action = if field(fields, "SendAt").is_some() {
        format!("Schedule {channel}")
    } else {
        format!("Send {channel}")
    };
    let mut s = ApprovalSummary::new(action);
    if !to.is_empty() {
        push_line(&mut s, "To", strip_channel(to));
    }
    match field(fields, "From") {
        Some(from) => push_line(&mut s, "From", strip_channel(from)),
        None => push_field(&mut s, "Messaging service", fields, "MessagingServiceSid"),
    }
    if let Some(body) = field(fields, "Body") {
        s.push_clamped("Message", body, MAX_SNIPPET_LEN);
    }
    push_field(&mut s, "Template", fields, "ContentSid");
    let media = fields
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("MediaUrl"))
        .count();
    if media > 0 {
        s.push("Attachments", media.to_string());
    }
    push_field(&mut s, "Send at", fields, "SendAt");
    s
}

fn place_call(fields: &[(String, String)]) -> ApprovalSummary {
    let mut s = ApprovalSummary::new("Place call");
    push_field(&mut s, "To", fields, "To");
    push_field(&mut s, "From", fields, "From");
    if let Some(twiml) = field(fields, "Twiml") {
        s.push_clamped("Script", twiml, MAX_SNIPPET_LEN);
    } else {
        push_field(&mut s, "Instructions URL", fields, "Url");
    }
    if field(fields, "Record").is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        s.push("Recording", "On");
    }
    s
}

fn summarize_account(
    m: &str,
    segs: &[&str],
    req: &SummaryRequest<'_>,
    fields: &[(String, String)],
) -> Option<ApprovalSummary> {
    let summary = match (m, segs) {
        ("GET", []) => {
            let mut s = ApprovalSummary::new("Read account details");
            s.push("Note", AUTH_TOKEN_NOTE);
            s
        }
        ("POST", []) => {
            let action = match field(fields, "Status") {
                Some("suspended") => "Suspend account",
                Some("closed") => "Close account",
                Some("active") => "Reactivate account",
                _ => "Update account",
            };
            let mut s = ApprovalSummary::new(action);
            push_field(&mut s, "Name", fields, "FriendlyName");
            s.push("Note", AUTH_TOKEN_NOTE);
            s
        }

        ("GET", ["Messages"]) => {
            let mut s = ApprovalSummary::new("Read messages");
            for (label, key) in [("To", "To"), ("From", "From"), ("Sent on", "DateSent")] {
                if let Some(v) = req.query_param(key).filter(|v| !v.is_empty()) {
                    push_line(&mut s, label, strip_channel(&v));
                }
            }
            s
        }
        ("GET", ["Messages", _, ..]) => ApprovalSummary::new("Read message"),
        ("POST", ["Messages"]) => send_message(fields),
        ("POST", ["Messages", _]) => {
            let action = if field(fields, "Status") == Some("canceled") {
                "Cancel scheduled message"
            } else if fields
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case("Body") && v.is_empty())
            {
                "Redact message text"
            } else {
                "Update message"
            };
            ApprovalSummary::new(action)
        }
        ("DELETE", ["Messages", _]) => ApprovalSummary::new("Delete message"),
        ("DELETE", ["Messages", _, "Media", _]) => ApprovalSummary::new("Delete message media"),

        ("GET", ["Calls"]) => ApprovalSummary::new("Read calls"),
        ("GET", ["Calls", ..]) => ApprovalSummary::new("Read call"),
        ("POST", ["Calls"]) => place_call(fields),
        ("POST", ["Calls", _]) => {
            if field(fields, "Status").is_some_and(|v| v == "completed" || v == "canceled") {
                ApprovalSummary::new("End call")
            } else {
                let mut s = ApprovalSummary::new("Redirect live call");
                if let Some(twiml) = field(fields, "Twiml") {
                    s.push_clamped("Script", twiml, MAX_SNIPPET_LEN);
                } else {
                    push_field(&mut s, "Instructions URL", fields, "Url");
                }
                s
            }
        }
        ("DELETE", ["Calls", _]) => ApprovalSummary::new("Delete call record"),
        ("GET", ["Recordings", ..]) => ApprovalSummary::new("Read recordings"),
        ("DELETE", ["Recordings", _]) | ("DELETE", ["Calls", _, "Recordings", _]) => {
            ApprovalSummary::new("Delete recording")
        }

        ("GET", ["IncomingPhoneNumbers", ..]) | ("GET", ["OutgoingCallerIds", ..]) => {
            ApprovalSummary::new("Read phone numbers")
        }
        ("GET", ["AvailablePhoneNumbers"]) => ApprovalSummary::new("Search phone numbers to buy"),
        ("GET", ["AvailablePhoneNumbers", country, ..]) => {
            let mut s = ApprovalSummary::new("Search phone numbers to buy");
            push_line(&mut s, "Country", country);
            s
        }
        // `IncomingPhoneNumbers.json`, or a typed `/Local`, `/Mobile`, `/TollFree`.
        ("POST", ["IncomingPhoneNumbers"])
        | ("POST", ["IncomingPhoneNumbers", "Local" | "Mobile" | "TollFree"]) => {
            let mut s = ApprovalSummary::new("Buy phone number");
            push_field(&mut s, "Number", fields, "PhoneNumber");
            push_field(&mut s, "Area code", fields, "AreaCode");
            s
        }
        ("POST", ["IncomingPhoneNumbers", _]) => {
            let mut s = ApprovalSummary::new("Change phone number settings");
            let changed: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
            if !changed.is_empty() {
                push_line(&mut s, "Changes", &changed.join(", "));
            }
            s
        }
        ("DELETE", ["IncomingPhoneNumbers", _]) => ApprovalSummary::new("Release phone number"),

        ("GET", ["Balance"]) => ApprovalSummary::new("Read balance"),
        ("GET", ["Usage", ..]) => ApprovalSummary::new("Read usage"),
        _ => return None,
    };
    Some(summary)
}

impl RequestSummarizer for Twilio {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let m = req.method_upper();
        let path = req.base_path();
        let fields = form(req);

        if path == "/2010-04-01/Accounts.json" {
            let mut s = match m.as_str() {
                "GET" => ApprovalSummary::new("List accounts and subaccounts"),
                "POST" => {
                    let mut s = ApprovalSummary::new("Create subaccount");
                    push_field(&mut s, "Name", &fields, "FriendlyName");
                    s
                }
                _ => return None,
            };
            s.push("Note", AUTH_TOKEN_NOTE);
            return Some(s);
        }
        if let Some((account, segs)) = account_segments(path) {
            let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
            let mut s = summarize_account(m.as_str(), &segs, req, &fields)?;
            push_line(&mut s, "Account", &account);
            return Some(s);
        }

        let segs: Vec<String> = path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(decode_segment)
            .collect();
        let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
        match (m.as_str(), segs.as_slice()) {
            // Lookup.
            ("GET", ["v2", "PhoneNumbers", number]) => {
                let mut s = ApprovalSummary::new("Look up phone number");
                push_line(&mut s, "Number", number);
                if let Some(f) = req.query_param("Fields").filter(|f| !f.is_empty()) {
                    push_line(&mut s, "Details", &f.replace(',', ", "));
                }
                Some(s)
            }
            // Verify.
            ("POST", ["v2", "Services", _, "Verifications"]) => {
                let mut s = ApprovalSummary::new("Send verification code");
                push_field(&mut s, "To", &fields, "To");
                push_field(&mut s, "Channel", &fields, "Channel");
                Some(s)
            }
            // The code itself is never shown: it is the secret being checked.
            ("POST", ["v2", "Services", _, "VerificationCheck"]) => {
                let mut s = ApprovalSummary::new("Check verification code");
                push_field(&mut s, "To", &fields, "To");
                Some(s)
            }
            // Approving skips the code check entirely, so the card says so.
            ("POST", ["v2", "Services", _, "Verifications", _]) => {
                Some(ApprovalSummary::new(match field(&fields, "Status") {
                    Some("approved") => "Approve verification without its code",
                    Some("canceled") => "Cancel verification",
                    _ => "Update verification",
                }))
            }
            ("POST", ["v2", "Services"]) => {
                let mut s = ApprovalSummary::new("Create verify service");
                push_field(&mut s, "Name", &fields, "FriendlyName");
                Some(s)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::summarize_request;

    // A placeholder Account SID: real length, masks to `AC…cdef`, but not
    // hex, so it never reads as a live credential to a secret scanner.
    const ACCT: &str = "/2010-04-01/Accounts/ACfixture000000000000000000000cdef";

    fn card(method: &str, path: &str, body: &str) -> (String, Vec<(String, String)>) {
        let s = summarize_request(
            "twilio",
            method,
            path,
            Some("application/x-www-form-urlencoded"),
            (!body.is_empty()).then_some(body.as_bytes()),
        );
        let rows = s
            .details
            .iter()
            .map(|d| (d.label.clone(), d.value.clone()))
            .collect();
        (s.action, rows)
    }

    fn rows(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(l, v)| ((*l).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn account_cards_warn_that_the_answer_carries_the_auth_token() {
        let (action, details) = card("GET", &format!("{ACCT}.json"), "");
        assert_eq!(action, "Read account details");
        assert_eq!(
            details,
            rows(&[
                ("Note", "Twilio's answer includes the Auth Token"),
                ("Account", "AC…cdef"),
            ])
        );
        let (action, details) = card("GET", "/2010-04-01/Accounts.json?PageSize=1", "");
        assert_eq!(action, "List accounts and subaccounts");
        assert_eq!(
            details,
            rows(&[("Note", "Twilio's answer includes the Auth Token")])
        );
    }

    #[test]
    fn sms_shows_recipient_sender_and_text() {
        let (action, details) = card(
            "POST",
            &format!("{ACCT}/Messages.json"),
            "To=%2B14155550100&From=%2B14155550199&Body=Your+order+has+shipped.",
        );
        assert_eq!(action, "Send SMS");
        assert_eq!(
            details,
            rows(&[
                ("To", "+14155550100"),
                ("From", "+14155550199"),
                ("Message", "Your order has shipped."),
                ("Account", "AC…cdef"),
            ])
        );
    }

    #[test]
    fn whatsapp_mms_and_scheduled_messages_say_so() {
        let (action, details) = card(
            "POST",
            &format!("{ACCT}/Messages.json"),
            "To=whatsapp%3A%2B447700900123&From=whatsapp%3A%2B14155238886&Body=Hi",
        );
        assert_eq!(action, "Send WhatsApp message");
        assert_eq!(details[0], ("To".to_string(), "+447700900123".to_string()));

        let (action, details) = card(
            "POST",
            &format!("{ACCT}/Messages.json"),
            "To=%2B1555&MessagingServiceSid=MG1&MediaUrl=https%3A%2F%2Fx%2Fa.png&MediaUrl=https%3A%2F%2Fx%2Fb.png",
        );
        assert_eq!(action, "Send MMS");
        assert!(details.contains(&("Messaging service".to_string(), "MG1".to_string())));
        assert!(details.contains(&("Attachments".to_string(), "2".to_string())));

        let (action, _) = card(
            "POST",
            &format!("{ACCT}/Messages.json"),
            "To=%2B1555&MessagingServiceSid=MG1&Body=x&SendAt=2026-10-16T09%3A00%3A00Z&ScheduleType=fixed",
        );
        assert_eq!(action, "Schedule SMS");
    }

    #[test]
    fn calls_and_numbers() {
        let (action, details) = card(
            "POST",
            &format!("{ACCT}/Calls.json"),
            "To=%2B1555&From=%2B1666&Twiml=%3CResponse%3E%3CSay%3EHi%3C%2FSay%3E%3C%2FResponse%3E",
        );
        assert_eq!(action, "Place call");
        assert_eq!(
            details,
            rows(&[
                ("To", "+1555"),
                ("From", "+1666"),
                ("Script", "<Response><Say>Hi</Say></Response>"),
                ("Account", "AC…cdef"),
            ])
        );
        assert_eq!(
            card(
                "POST",
                &format!("{ACCT}/Calls/CA1.json"),
                "Status=completed"
            )
            .0,
            "End call"
        );
        assert_eq!(
            card(
                "POST",
                &format!("{ACCT}/IncomingPhoneNumbers.json"),
                "PhoneNumber=%2B1777"
            )
            .0,
            "Buy phone number"
        );
        let (action, details) = card(
            "POST",
            &format!("{ACCT}/IncomingPhoneNumbers/PN123.json"),
            "SmsUrl=https%3A%2F%2Fexample.com%2Fsms&FriendlyName=Support",
        );
        assert_eq!(action, "Change phone number settings");
        assert_eq!(
            details,
            rows(&[("Changes", "SmsUrl, FriendlyName"), ("Account", "AC…cdef")])
        );
        assert_eq!(
            card(
                "DELETE",
                &format!("{ACCT}/IncomingPhoneNumbers/PN123.json"),
                ""
            )
            .0,
            "Release phone number"
        );
        assert_eq!(
            card(
                "GET",
                &format!("{ACCT}/AvailablePhoneNumbers/US/Local.json"),
                ""
            )
            .1,
            rows(&[("Country", "US"), ("Account", "AC…cdef")])
        );
    }

    #[test]
    fn verify_never_shows_the_code() {
        let (action, details) = card(
            "POST",
            "/v2/Services/VA1/Verifications",
            "To=%2B1555&Channel=sms",
        );
        assert_eq!(action, "Send verification code");
        assert_eq!(details, rows(&[("To", "+1555"), ("Channel", "sms")]));

        let (action, details) = card(
            "POST",
            "/v2/Services/VA1/VerificationCheck",
            "To=%2B1555&Code=123456",
        );
        assert_eq!(action, "Check verification code");
        assert_eq!(details, rows(&[("To", "+1555")]));

        let approve = card(
            "POST",
            "/v2/Services/VA1/Verifications/VE1",
            "Status=approved",
        );
        assert_eq!(approve.0, "Approve verification without its code");
        let cancel = card(
            "POST",
            "/v2/Services/VA1/Verifications/VE1",
            "Status=canceled",
        );
        assert_eq!(cancel.0, "Cancel verification");
    }

    #[test]
    fn a_newline_in_a_value_never_forges_a_row() {
        // `To=+1555\nAccount: AC…0000` would read as a second, fake row.
        let s = summarize_request(
            "twilio",
            "POST",
            &format!("{ACCT}/Messages.json"),
            Some("application/x-www-form-urlencoded"),
            Some(b"To=%2B1555%0AAccount%3A+AC%E2%80%A60000&From=%2B1666&Body=Hi"),
        );
        assert!(s
            .details
            .iter()
            .filter(|d| d.label != "Message")
            .all(|d| !d.value.contains('\n')));
        let text = s.render_text();
        assert_eq!(
            text.lines().filter(|l| l.starts_with("Account:")).count(),
            1
        );
        let (_, details) = card("GET", "/v2/PhoneNumbers/%2B1555%0AFake%3A%20row", "");
        assert_eq!(details, rows(&[("Number", "+1555 Fake: row")]));
    }

    #[test]
    fn lookup_and_unknown_paths() {
        let (action, details) = card(
            "GET",
            "/v2/PhoneNumbers/%2B14155552671?Fields=line_type_intelligence,caller_name",
            "",
        );
        assert_eq!(action, "Look up phone number");
        assert_eq!(
            details,
            rows(&[
                ("Number", "+14155552671"),
                ("Details", "line_type_intelligence, caller_name"),
            ])
        );
        // Not recognized: the generic card, as before.
        assert_eq!(card("GET", "/v1/Flows", "").0, "GET request");
    }
}
