//! HeyReach: manual-approval summaries.
//!
//! HeyReach's public API (`api.heyreach.io/api/public`) names the action in
//! the path (`campaign/AddLeadsToCampaignV2`, `li_account/GetAll`) and pages
//! most reads with a POST body, so the generic card can only guess at a title
//! ("Create get all" for listing sender accounts, "Update campaign" for
//! adding leads to one). This names every documented route the way HeyReach's
//! own app does:
//!
//! - the outreach a person will see (leads added to a campaign or a list, a
//!   message sent, a campaign's sequence and schedule) gets its own rows: who,
//!   how many, from which sender, and the exact text;
//! - every other route keeps the generic rows (each field labelled,
//!   secret-named values masked, everything bounded) under its own title.
//!
//! A campaign a request names is registered as a record, so the gateway can
//! name it ("Pause campaign Q4 outbound"), and a message's conversation is
//! registered so the gateway can name who it goes to ([`RecordResolver`]).
//! A route not in the published API defers to the generic card. Registered
//! as the `"heyreach"` summarizer in [`super::summarizer`].

use serde_json::{Map, Value};

use super::records::{Named, Target};
use super::{
    generic, json_object, one_line, parse_json, ApprovalDetail, ApprovalSummary, RecordResolver,
    RequestSummarizer, SummaryRequest, MAX_SNIPPET_LEN, MAX_VALUE_LEN,
};

pub(super) struct HeyReach;

/// A campaign: its id is a bare positive integer.
const CAMPAIGN: &str = "Campaign";
/// A conversation, as `{sender account id}/{conversation id}`: the only way
/// HeyReach reads one (`inbox/GetChatroom/{accountId}/{conversationId}`).
const CONVERSATION: &str = "Conversation";

/// Leads and sender accounts named on a card before the rest are counted.
const MAX_NAMES: usize = 5;
/// Sequence steps shown before the rest are counted, and the nodes walked to
/// find them, so a huge or deeply nested sequence costs bounded work.
const MAX_STEPS: usize = 12;
const MAX_NODES: usize = 64;
/// A step's message, kept short: the details dialog carries the whole body.
const MAX_STEP_TEXT: usize = 160;
/// A row label built from a sequence's branches.
const MAX_LABEL: usize = 60;

impl RequestSummarizer for HeyReach {
    fn summarize(&self, req: &SummaryRequest<'_>) -> Option<ApprovalSummary> {
        let segs: Vec<&str> = req
            .base_path()
            .strip_prefix("/api/public/")?
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let method = req.method_upper();
        let body = req.body.and_then(json_object);
        let b = body.as_ref();
        let s = match (method.as_str(), segs.as_slice()) {
            ("POST", ["campaign", "AddLeadsToCampaign" | "AddLeadsToCampaignV2"]) => {
                add_leads_to_campaign(req, b)
            }
            ("POST", ["list", "AddLeadsToList" | "AddLeadsToListV2"]) => add_leads_to_list(b),
            ("POST", ["campaign", "StopLeadInCampaign"]) => stop_lead(req, b),
            ("POST", ["inbox", "SendMessage"]) => send_message(b),
            ("POST", ["campaign", "Create"]) => create_campaign(b),
            ("POST", ["campaign", "CreateCampaignFromTemplate"]) => create_from_template(b),
            ("POST", ["campaign", "UpdateSequence"]) => {
                let mut s = about_campaign(req, b, REPLACE_SEQUENCE);
                if let Some(root) = b.and_then(|b| b.get("sequence")) {
                    push_sequence(&mut s, root);
                }
                s
            }
            ("POST", ["campaign", "UpdateSchedule"]) => {
                let mut s = about_campaign(req, b, CHANGE_SCHEDULE);
                if let Some(schedule) = b.and_then(|b| b.get("schedule")) {
                    push_schedule(&mut s, schedule);
                }
                s
            }
            _ => return titled(req, &method, &segs, b),
        };
        Some(with_unread_body(req, b, s))
    }
}

// ── Titles ───────────────────────────────────────────────────────────────────

/// How a title names the campaign its request is about, once the gateway has
/// read its name: `verb`, `join`, then the name, with "campaign" before it
/// when the verb does not say so already ("Pause campaign Q4 outbound", "Add
/// leads to campaign Q4 outbound"). Unnamed, the id stands in.
#[derive(Clone, Copy)]
struct About {
    verb: &'static str,
    join: &'static str,
    typed: bool,
}

const fn about(verb: &'static str, join: &'static str, typed: bool) -> About {
    About { verb, join, typed }
}

const ADD_LEADS: About = about("Add leads", " to ", true);
const STOP_LEAD: About = about("Stop a lead", " in ", true);
const REPLACE_SEQUENCE: About = about("Replace the sequence", " of ", true);
const CHANGE_SCHEDULE: About = about("Change the schedule", " of ", true);

/// What a route not given its own rows is called, and what it is about.
enum Title {
    Plain(String),
    Campaign(About, Option<String>),
}

fn plain(title: &str) -> Title {
    Title::Plain(title.to_string())
}

/// Every other documented route: HeyReach's own words for it, over the
/// generic rows. `None` for a route the published API does not have.
fn titled(
    req: &SummaryRequest<'_>,
    method: &str,
    segs: &[&str],
    b: Option<&Map<String, Value>>,
) -> Option<ApprovalSummary> {
    let campaign = || campaign_id(req, b);
    let flag = |key: &str| {
        req.query_param(key).is_some_and(|v| v == "true")
            || b.and_then(|b| b.get(key)).and_then(Value::as_bool) == Some(true)
    };
    // The ids a path carries, as rows: HeyReach's paths name an action, so
    // the generic reading of them ("Campaign: AddLeadsToCampaignV2") is
    // replaced, never kept.
    let mut path: Vec<(&str, &str)> = Vec::new();
    // What the approver should know before saying yes.
    let mut notes: Vec<(&str, &str)> = Vec::new();
    let title = match (method, segs) {
        ("GET", ["auth", "CheckApiKey"]) => plain("Check the API key"),

        // ── Campaigns ──
        ("POST", ["campaign", "GetAll"]) => plain("List campaigns"),
        ("POST", ["campaign", "GetCampaignsForLead"]) => plain("List a lead's campaigns"),
        ("GET", ["campaign", "GetById"]) => {
            Title::Campaign(about("Read campaign", " ", false), campaign())
        }
        ("GET", ["campaign", "GetCampaignSequence"]) => {
            Title::Campaign(about("Read the sequence", " of ", true), campaign())
        }
        ("POST", ["campaign", "GetLeadsFromCampaign"]) => {
            Title::Campaign(about("List the leads", " in ", true), campaign())
        }
        ("POST", ["campaign", "Pause"]) => {
            Title::Campaign(about("Pause campaign", " ", false), campaign())
        }
        ("POST", ["campaign", "Resume"]) => {
            Title::Campaign(about("Resume campaign", " ", false), campaign())
        }
        ("POST", ["campaign", "StartCampaign"]) => {
            Title::Campaign(about("Start campaign", " ", false), campaign())
        }
        ("POST", ["campaign", "UpdateSettings"]) => {
            Title::Campaign(about("Change the settings", " of ", true), campaign())
        }
        ("POST", ["campaign", "UpdateAccounts"]) => Title::Campaign(
            about("Replace the sender accounts", " of ", true),
            campaign(),
        ),
        ("POST", ["campaign", "AddLinkedInAccountsToCampaign"]) => {
            Title::Campaign(about("Add sender accounts", " to ", true), campaign())
        }
        ("POST", ["campaign", "RemoveLinkedInAccountsFromCampaign"]) => {
            Title::Campaign(about("Remove sender accounts", " from ", true), campaign())
        }
        (
            "PATCH",
            ["campaign", "UpdateLeadCustomFields", "campaigns", id, "leads", "custom-fields"],
        ) => Title::Campaign(
            about("Update a lead's fields", " in ", true),
            Some((*id).to_string()),
        ),

        // ── Inbox ──
        ("POST", ["inbox", "GetConversationsV2" | "GetConversationsV3"]) => plain("Read the inbox"),
        ("GET", ["inbox", "GetChatroom", account, conversation]) => {
            path = vec![("Sender account", account), ("Conversation", conversation)];
            plain("Read a conversation")
        }
        ("POST", ["inbox", "SetSeenStatus"]) => {
            if b.and_then(|b| b.get("seen")).and_then(Value::as_bool) == Some(false) {
                plain("Mark a conversation as unseen")
            } else {
                plain("Mark a conversation as seen")
            }
        }

        // ── Sender accounts ──
        ("POST", ["li_account", "GetAll"]) => plain("List sender accounts"),
        ("GET", ["li_account", "GetById"]) => plain("Read a sender account"),
        ("GET", ["li_account", "GetAccountStatus", id]) => {
            path = vec![("Sender account", id)];
            plain("Read a sender account's status")
        }
        ("GET", ["li_account", "GetProxyCountries"]) => plain("List proxy countries"),
        ("GET", ["li_account", "GetAccountProxy", id]) => {
            path = vec![("Sender account", id)];
            notes.push(("Answer", "Includes a custom proxy's username and password"));
            plain("Read a sender account's proxy")
        }
        ("POST", ["li_account", "Connect"]) => plain("Connect a sender account"),
        ("POST", ["li_account", "ConnectWithCookies"]) => {
            plain("Connect a sender account with its cookies")
        }
        ("POST", ["li_account", "SubmitPin"]) => plain("Submit a sender account's sign-in PIN"),
        ("POST", ["li_account", "Reconnect"]) => plain("Reconnect a sender account"),
        ("POST", ["li_account", "ReloginSalesNavigator"]) => {
            plain("Sign a sender account in to Sales Navigator again")
        }
        ("POST", ["li_account", "ReloginRecruiter"]) => {
            plain("Sign a sender account in to Recruiter again")
        }
        ("POST", ["li_account", "Resync"]) => plain("Resync a sender account"),
        ("POST", ["li_account", "UpdateProxy"]) => plain("Change a sender account's proxy"),
        ("POST", ["li_account", "UpdateInboxConfiguration"]) => {
            plain("Change a sender account's inbox sync")
        }
        ("DELETE", ["li_account", "RemoveAccount", id]) => {
            path = vec![("Sender account", id)];
            if flag("force") {
                notes.push(("Campaigns", "Also removed from its active campaigns"));
            }
            plain("Remove a sender account")
        }

        // ── Lists ──
        ("GET", ["list", "GetById"]) => plain("Read a list"),
        ("POST", ["list", "GetAll"]) => plain("List lead lists"),
        ("POST", ["list", "GetLeadsFromList"]) => plain("List the leads in a lead list"),
        ("POST", ["list", "GetCompaniesFromList"]) => plain("List the companies in a list"),
        ("POST", ["list", "GetListsForLead"]) => plain("List a lead's lists"),
        ("POST", ["list", "CreateEmptyList"]) => {
            if b.and_then(|b| b.get("type")).and_then(Value::as_str) == Some("COMPANY_LIST") {
                plain("Create a company list")
            } else {
                plain("Create a lead list")
            }
        }
        ("DELETE", ["list", "DeleteLeadsFromList" | "DeleteLeadsFromListByProfileUrl"]) => {
            plain("Remove leads from a lead list")
        }
        ("PATCH", ["list", "UpdateLeadCustomFields", "lists", id, "leads", "custom-fields"]) => {
            path = vec![("List", id)];
            plain("Update a lead's fields in a list")
        }

        // ── Leads and tags ──
        ("POST", ["lead", "GetLead"]) => plain("Read a lead"),
        ("POST", ["lead", "GetTags"]) => plain("Read a lead's tags"),
        ("POST", ["lead", "AddTags"]) => plain("Tag a lead"),
        ("POST", ["lead", "ReplaceTags"]) => plain("Replace a lead's tags"),
        ("POST", ["lead_tags", "CreateTags"]) => plain("Create tags"),

        // ── Stats, network, enrichment ──
        ("POST", ["stats", "GetOverallStats"]) => plain("Read stats"),
        ("POST", ["stats", "GetOverallStatsByCampaign"]) => plain("Read stats per campaign"),
        ("POST", ["MyNetwork", "GetMyNetworkForSender"]) => plain("List a sender's connections"),
        ("POST", ["MyNetwork", "IsConnection"]) => plain("Check a LinkedIn connection"),
        ("POST", ["enrichment", "enrich-email"]) => plain("Find a lead's email"),
        ("GET", ["enrichment", "enrich-email", "check-job", id]) => {
            path = vec![("Search", id)];
            plain("Read an email search result")
        }

        // ── Blacklist ──
        ("POST", ["blacklist", "GetLeads"]) => plain("List blacklisted leads"),
        ("POST", ["blacklist", "GetCompanies"]) => plain("List blacklisted companies"),
        ("POST", ["blacklist", "AddLeads"]) => plain("Blacklist leads"),
        ("POST", ["blacklist", "AddCompanies"]) => plain("Blacklist companies"),
        ("POST", ["blacklist", "RemoveLeads"]) => plain("Remove leads from the blacklist"),
        ("POST", ["blacklist", "RemoveCompanies"]) => plain("Remove companies from the blacklist"),

        // ── Webhooks ──
        ("POST", ["webhooks", "CreateWebhook"]) => plain("Create a webhook"),
        ("GET", ["webhooks", "GetWebhookById"]) => {
            if flag("includeCustomHeaders") {
                notes.push(("Answer", "Includes the headers the webhook sends"));
            }
            plain("Read a webhook")
        }
        ("POST", ["webhooks", "GetAllWebhooks"]) => {
            if flag("includeCustomHeaders") {
                notes.push(("Answer", "Includes the headers each webhook sends"));
            }
            plain("List webhooks")
        }
        ("PATCH", ["webhooks", "UpdateWebhook"]) => plain("Change a webhook"),
        ("DELETE", ["webhooks", "DeleteWebhook"]) => plain("Delete a webhook"),

        // ── Organization (Master API key) ──
        ("GET", ["management", "organizations", "workspaces"]) => plain("List workspaces"),
        ("POST", ["management", "organizations", "workspaces"]) => plain("Create a workspace"),
        ("PATCH", ["management", "organizations", "workspaces", id]) => {
            path = vec![("Workspace", id)];
            plain("Change a workspace")
        }
        ("GET", ["management", "organizations", "api-keys", "workspaces", id]) => {
            path = vec![("Workspace", id)];
            notes.push(("Answer", "Includes the workspace's API keys"));
            plain("Read a workspace's API keys")
        }
        ("POST", ["management", "organizations", "api-keys", "workspaces", id]) => {
            path = vec![("Workspace", id)];
            notes.push((
                "Replaces",
                "Deactivates the workspace's current key of this type",
            ));
            plain("Create a workspace API key")
        }
        ("POST", ["management", "organizations", "users"]) => plain("List organization users"),
        ("GET", ["management", "organizations", "users", id]) => {
            path = vec![("User", id)];
            plain("Read an organization user")
        }
        ("POST", ["management", "organizations", "users", "workspaces", id]) => {
            path = vec![("Workspace", id)];
            plain("List a workspace's users")
        }
        ("POST", ["management", "organizations", "users", "invite", role]) => match *role {
            "admins" => plain("Invite organization admins"),
            "members" => plain("Invite organization members"),
            "managers" => plain("Invite organization managers"),
            _ => return None,
        },
        ("POST", ["management", "organizations", "linkedin-accounts"]) => {
            plain("List the organization's sender accounts")
        }
        ("POST", ["management", "organizations", "linkedin-accounts", "MoveToWorkspace"]) => {
            plain("Move a sender account to another workspace")
        }
        ("DELETE", ["management", "organizations", "linkedin-accounts", id]) => {
            path = vec![("Sender account", id)];
            if flag("forceDelete") {
                notes.push(("Campaigns", "Also removed from its active campaigns"));
            }
            plain("Delete a sender account")
        }

        _ => return None,
    };
    let mut s = match title {
        Title::Plain(title) => ApprovalSummary::new(title),
        Title::Campaign(about, id) => campaign_card(about, id.as_deref()),
    };
    for (label, value) in notes {
        s.push(label, value);
    }
    Some(with_generic_rows(req, s, &path))
}

/// A card about one campaign: its row, registered so the gateway can name
/// it, and a title that folds the name in.
fn campaign_card(about: About, id: Option<&str>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new(about.verb);
    if let Some(id) = id {
        push_campaign(&mut s, "Campaign", id);
        if is_campaign_id(id) {
            s.target = Some(Target::of(
                id,
                about.join,
                about.typed.then(|| "campaign".to_string()),
            ));
        }
    }
    s
}

fn about_campaign(
    req: &SummaryRequest<'_>,
    b: Option<&Map<String, Value>>,
    about: About,
) -> ApprovalSummary {
    campaign_card(about, campaign_id(req, b).as_deref())
}

/// `s`'s rows, then the generic rows (every query and body field labelled,
/// secret-named values masked, all bounded) with the path's ids in place of
/// the generic reading of the path. A campaign id already on the card is not
/// repeated. No before/after read: HeyReach serves no GET at a write's path.
fn with_generic_rows(
    req: &SummaryRequest<'_>,
    mut s: ApprovalSummary,
    path: &[(&str, &str)],
) -> ApprovalSummary {
    let g = generic::summarize(req);
    let range = g.fallback.unwrap_or(0..0);
    let mut rows = g.details;
    rows.splice(
        range.clone(),
        path.iter().map(|(label, value)| ApprovalDetail {
            label: (*label).to_string(),
            value: one_line(value, MAX_VALUE_LEN),
            url: None,
        }),
    );
    let path_end = range.start + path.len();
    let named_campaign = s.refs.iter().any(|r| r.object == CAMPAIGN);
    let mut i = 0;
    rows.retain(|d| {
        i += 1;
        !(named_campaign && i > path_end && d.label == "Campaign id")
    });
    let offset = s.details.len();
    s.details.extend(rows);
    s.fallback = Some(offset + range.start..offset + path_end);
    s
}

/// A body the gateway's peek cut (or that is not a JSON object) parses to
/// nothing: the card says what it is instead of reading as an empty request.
fn with_unread_body(
    req: &SummaryRequest<'_>,
    b: Option<&Map<String, Value>>,
    mut s: ApprovalSummary,
) -> ApprovalSummary {
    if b.is_none() && req.body.is_some_and(|body| !body.is_empty()) {
        if let Some(row) = generic::summarize(req)
            .details
            .into_iter()
            .find(|d| d.label == "Body")
        {
            s.details.push(row);
        }
    }
    s
}

// ── Outreach ────────────────────────────────────────────────────────────────

/// Adding leads to a running campaign starts reaching out to them, so the
/// card leads with how many and who, from which senders, and whether the
/// request also restarts a stopped campaign.
fn add_leads_to_campaign(
    req: &SummaryRequest<'_>,
    b: Option<&Map<String, Value>>,
) -> ApprovalSummary {
    let mut s = about_campaign(req, b, ADD_LEADS);
    let Some(b) = b else { return s };
    // `accountLeadPairs: [{ linkedInAccountId, lead: {…} }]`: each lead beside
    // the sender that will reach them.
    if let Some(pairs) = b.get("accountLeadPairs").and_then(Value::as_array) {
        push_leads(
            &mut s,
            pairs.iter().filter_map(|p| p.get("lead")),
            pairs.len(),
        );
        push_ids(
            &mut s,
            "Senders",
            pairs.iter().filter_map(|p| p.get("linkedInAccountId")),
        );
    }
    let resumes = |key: &str| b.get(key).and_then(Value::as_bool) == Some(true);
    let resumed = match (
        resumes("resumePausedCampaign"),
        resumes("resumeFinishedCampaign"),
    ) {
        (true, true) => Some("Resumed if it is paused or finished"),
        (true, false) => Some("Resumed if it is paused"),
        (false, true) => Some("Resumed if it is finished"),
        (false, false) => None,
    };
    if let Some(resumed) = resumed {
        s.push("Campaign state", resumed);
    }
    s
}

/// Adding leads to a list starts no outreach of its own, but it is still
/// people's data, and a campaign on the list may pick them up.
fn add_leads_to_list(b: Option<&Map<String, Value>>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new("Add leads to a lead list");
    let Some(b) = b else { return s };
    if let Some(id) = b.get("listId").and_then(scalar) {
        s.push("List", id);
    }
    if let Some(leads) = b.get("leads").and_then(Value::as_array) {
        push_leads(&mut s, leads.iter(), leads.len());
    }
    s
}

fn stop_lead(req: &SummaryRequest<'_>, b: Option<&Map<String, Value>>) -> ApprovalSummary {
    let mut s = about_campaign(req, b, STOP_LEAD);
    let text = |key: &str| b.and_then(|b| b.get(key)).and_then(scalar);
    if let Some(lead) = text("leadUrl").or_else(|| text("leadMemberId")) {
        s.push("Lead", one_line(&lead, MAX_VALUE_LEN));
    }
    s
}

/// A message from the operator's own LinkedIn account to a real person: the
/// approver is approving the text, so it gets the room. The recipient is
/// registered so the gateway can name them from the conversation.
fn send_message(b: Option<&Map<String, Value>>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new("Send a LinkedIn message");
    let Some(b) = b else { return s };
    let sender = b.get("linkedInAccountId").and_then(scalar);
    if let Some(conversation) = b.get("conversationId").and_then(scalar) {
        let shown = format!("Conversation {}", one_line(&conversation, MAX_VALUE_LEN));
        match sender.as_deref().map(|a| format!("{a}/{conversation}")) {
            Some(id) if HeyReach.object_of(&id) == Some(CONVERSATION) => {
                s.push_named("To", CONVERSATION, &id, shown, Named::Alone);
            }
            _ => s.push("To", shown),
        }
    }
    if let Some(sender) = sender {
        s.push("From", format!("Sender account {}", one_line(&sender, 40)));
    }
    if let Some(subject) = b.get("subject").and_then(Value::as_str) {
        s.push("Subject", one_line(subject, MAX_VALUE_LEN));
    }
    if let Some(message) = b.get("message").and_then(Value::as_str) {
        s.push_clamped("Message", message, MAX_SNIPPET_LEN);
    }
    s
}

// ── Campaigns ───────────────────────────────────────────────────────────────

/// Creating a campaign defines who is reached, from which accounts, when, and
/// the exact messages. It is created as a draft (StartCampaign runs it), but
/// this is the request that decides all of it.
fn create_campaign(b: Option<&Map<String, Value>>) -> ApprovalSummary {
    let mut s = ApprovalSummary::new("Create campaign");
    let Some(b) = b else { return s };
    push_settings(&mut s, b, "linkedInAccountIds");
    if let Some(schedule) = b.get("schedule") {
        push_schedule(&mut s, schedule);
    }
    if let Some(root) = b.get("sequence") {
        push_sequence(&mut s, root);
    }
    s
}

/// A new campaign copying another's sequence and schedule: the card names
/// the campaign copied ("Create campaign from Q4 outbound").
fn create_from_template(b: Option<&Map<String, Value>>) -> ApprovalSummary {
    let id = b
        .and_then(|b| b.get("campaignIdForTemplate"))
        .and_then(scalar);
    let mut s = ApprovalSummary::new("Create campaign");
    if let Some(id) = &id {
        push_campaign(&mut s, "Copied from", id);
        if is_campaign_id(id) {
            s.target = Some(Target::of(id, " from ", None));
        }
    }
    if let Some(b) = b {
        // The API spells this field with three c's.
        push_settings(&mut s, b, "linkedInAcccountIdsForCampaign");
    }
    s
}

/// A new campaign's name, lead list, senders and exclusions.
fn push_settings(s: &mut ApprovalSummary, b: &Map<String, Value>, senders: &str) {
    if let Some(name) = b.get("name").and_then(Value::as_str) {
        s.push("Name", one_line(name, MAX_VALUE_LEN));
    }
    if let Some(id) = b.get("linkedInUserListId").and_then(scalar) {
        s.push("Lead list", id);
    }
    if let Some(ids) = b.get(senders).and_then(Value::as_array) {
        push_ids(s, "Senders", ids.iter());
    }
    const SKIPS: [(&str, &str); 3] = [
        (
            "excludeContactedFromOtherCampaigns",
            "leads in other campaigns",
        ),
        (
            "excludeHasOtherAccConversations",
            "leads talking to another sender",
        ),
        (
            "excludeContactedFromSenderInOtherCampaign",
            "leads its senders reached in other campaigns",
        ),
    ];
    let skips: Vec<&str> = SKIPS
        .iter()
        .filter(|(key, _)| b.get(*key).and_then(Value::as_bool) == Some(true))
        .map(|(_, what)| *what)
        .collect();
    if !skips.is_empty() {
        s.push("Skips", skips.join(", "));
    }
    if let Some(id) = b.get("excludeListId").and_then(scalar) {
        s.push("Excluded list", id);
    }
}

/// When outreach goes out: the daily window and its zone, the days of the
/// week, and the dates.
fn push_schedule(s: &mut ApprovalSummary, schedule: &Value) {
    let text = |key: &str| {
        schedule
            .get(key)
            .and_then(Value::as_str)
            .map(|v| one_line(v, 40))
    };
    // `09:00:00` reads as `09:00`.
    let time =
        |key: &str| text(key).map(|t| t.strip_suffix(":00").map(str::to_string).unwrap_or(t));
    if let (Some(start), Some(end)) = (time("dailyStartTime"), time("dailyEndTime")) {
        let zone = text("timeZoneId")
            .map(|z| format!(" {z}"))
            .unwrap_or_default();
        s.push("Hours", format!("{start}–{end}{zone}"));
    }
    const DAYS: [(&str, &str); 7] = [
        ("enabledMonday", "Mon"),
        ("enabledTuesday", "Tue"),
        ("enabledWednesday", "Wed"),
        ("enabledThursday", "Thu"),
        ("enabledFriday", "Fri"),
        ("enabledSaturday", "Sat"),
        ("enabledSunday", "Sun"),
    ];
    let days: Vec<&str> = DAYS
        .iter()
        .filter(|(key, _)| schedule.get(*key).and_then(Value::as_bool) == Some(true))
        .map(|(_, day)| *day)
        .collect();
    if !days.is_empty() {
        s.push("Days", days.join(", "));
    }
    if let Some(start) = text("startDate") {
        s.push("Starts", start);
    }
    if let Some(end) = text("endDate") {
        s.push("Ends", end);
    }
}

/// The sequence, one row per step, each saying what it does, after how long,
/// and the message it sends. The sequence is a tree: a branching step
/// (a connection request: accepted or not) continues down two paths, and
/// each row names the path it is on ("Step 2 (accepted)"). Walked depth
/// first, the "yes" path before the "no" path, and bounded.
fn push_sequence(s: &mut ApprovalSummary, root: &Value) {
    let mut steps: Vec<(String, String)> = Vec::new();
    let mut stack: Vec<(&Value, usize, String)> = vec![(root, 1, String::new())];
    let mut visited = 0;
    while let Some((node, n, path)) = stack.pop() {
        if visited == MAX_NODES {
            break;
        }
        visited += 1;
        let Some(kind) = node.get("nodeType").and_then(Value::as_str) else {
            continue;
        };
        // END closes a path; it does nothing.
        if kind == "END" {
            continue;
        }
        let label = if path.is_empty() {
            format!("Step {n}")
        } else {
            one_line(&format!("Step {n} ({path})"), MAX_LABEL)
        };
        steps.push((label, step(node, kind)));
        let (yes, no) = branches(kind);
        let on = |branch: &str| {
            if path.is_empty() {
                branch.to_string()
            } else {
                format!("{path} › {branch}")
            }
        };
        let conditional = node.get("conditionalNode").filter(|v| v.is_object());
        if let Some(next) = node.get("unconditionalNode").filter(|v| v.is_object()) {
            let path = if conditional.is_some() {
                on(no)
            } else {
                path.clone()
            };
            stack.push((next, n + 1, path));
        }
        if let Some(next) = conditional {
            stack.push((next, n + 1, on(yes)));
        }
    }
    let more = steps.len().saturating_sub(MAX_STEPS);
    for (label, text) in steps.into_iter().take(MAX_STEPS) {
        s.push(label, text);
    }
    if more > 0 || !stack.is_empty() {
        s.push("More steps", format!("+{more} more"));
    }
}

/// What the two paths after a branching step mean.
fn branches(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "CONNECTION_REQUEST" => ("accepted", "not accepted"),
        "CHECK_IS_CONNECTION" => ("connected", "not connected"),
        "CHECK_IS_OPEN_PROFILE" => ("open profile", "not an open profile"),
        "FIND_EMAIL" => ("email found", "no email found"),
        _ => ("condition met", "condition not met"),
    }
}

/// One step as a sentence: "After 2 days, send a message: “…”".
fn step(node: &Value, kind: &str) -> String {
    let action = match kind {
        "CONNECTION_REQUEST" => "send a connection request".to_string(),
        "MESSAGE" => "send a message".to_string(),
        "INMAIL" => "send an InMail".to_string(),
        "VIEW_PROFILE" => "view their profile".to_string(),
        "FOLLOW" => "follow them".to_string(),
        "LIKE_POST" => "like one of their posts".to_string(),
        "FIND_EMAIL" => "find their email".to_string(),
        "CHECK_IS_CONNECTION" => "check whether they are connected".to_string(),
        "CHECK_IS_OPEN_PROFILE" => "check whether their profile is open".to_string(),
        "SEND_LEAD_TO_INSTANTLY" => "send them to Instantly".to_string(),
        "SEND_LEAD_TO_SMARTLEAD" => "send them to Smartlead".to_string(),
        "SEND_LEAD_TO_BISON" => "send them to EmailBison".to_string(),
        other => one_line(other, 40),
    };
    let unit = node.get("actionDelayUnit").and_then(Value::as_str);
    let mut out = match (node.get("actionDelay").and_then(Value::as_u64), unit) {
        (None | Some(0), _) => capitalize(&action),
        (Some(n), Some("HOUR")) => format!("After {n} hour{}, {action}", plural(n)),
        (Some(n), Some("DAY")) => format!("After {n} day{}, {action}", plural(n)),
        (Some(n), _) => format!("After a delay of {n}, {action}"),
    };
    let payload = node.get("payload");
    let messages = payload
        .and_then(|p| p.get("messages"))
        .and_then(Value::as_array);
    let text = messages
        .and_then(|m| m.iter().find_map(Value::as_str))
        .or_else(|| {
            payload
                .and_then(|p| p.get("fallbackMessage"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|t| !t.is_empty());
    if let Some(text) = text {
        out.push_str(&format!(": “{}”", one_line(text, MAX_STEP_TEXT)));
        let variants = messages.map_or(0, |m| m.iter().filter(|v| v.is_string()).count());
        if variants > 1 {
            out.push_str(&format!(" (+{} variants)", variants - 1));
        }
    }
    one_line(&out, MAX_VALUE_LEN)
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

fn plural(n: u64) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

// ── Rows ────────────────────────────────────────────────────────────────────

/// How many leads, and who (by name, else profile or email), so the
/// approver sees both the scale and the people.
fn push_leads<'a>(s: &mut ApprovalSummary, leads: impl Iterator<Item = &'a Value>, total: usize) {
    if total == 0 {
        return;
    }
    s.push("Leads", format!("{total} lead{}", plural(total as u64)));
    let names: Vec<String> = leads.filter_map(lead_name).take(MAX_NAMES).collect();
    if names.is_empty() {
        return;
    }
    s.push("Who", counted(&names, total));
}

/// A lead's name, or what else identifies them.
fn lead_name(lead: &Value) -> Option<String> {
    let text = |key: &str| {
        lead.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let name = [text("firstName"), text("lastName")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let who = if name.is_empty() {
        text("profileUrl").or_else(|| text("emailAddress"))?
    } else {
        &name
    };
    Some(one_line(who, 80))
}

/// Distinct ids (numbers or strings), first seen first, as one row.
fn push_ids<'a>(s: &mut ApprovalSummary, label: &str, ids: impl Iterator<Item = &'a Value>) {
    let mut all: Vec<String> = Vec::new();
    for id in ids.filter_map(scalar) {
        if !all.contains(&id) {
            all.push(id);
        }
    }
    if all.is_empty() {
        return;
    }
    let shown: Vec<String> = all
        .iter()
        .take(MAX_NAMES)
        .map(|id| one_line(id, 40))
        .collect();
    s.push(label, counted(&shown, all.len()));
}

/// `shown`, with how many more there are.
fn counted(shown: &[String], total: usize) -> String {
    let more = total.saturating_sub(shown.len());
    let list = shown.join(", ");
    if more > 0 {
        format!("{list} (+{more} more)")
    } else {
        list
    }
}

/// The campaign row: registered as a record when the id is one, so the
/// gateway can name it; otherwise shown as sent.
fn push_campaign(s: &mut ApprovalSummary, label: &str, id: &str) {
    if is_campaign_id(id) {
        s.push_record(label, CAMPAIGN, id);
    } else {
        s.push(label, one_line(id, MAX_VALUE_LEN));
    }
}

/// The campaign a request names: `?campaignId=` (Pause, Resume, StartCampaign,
/// GetById) or the body's `campaignId` (everything else).
fn campaign_id(req: &SummaryRequest<'_>, b: Option<&Map<String, Value>>) -> Option<String> {
    req.query_param("campaignId")
        .filter(|v| !v.trim().is_empty())
        .or_else(|| b.and_then(|b| b.get("campaignId")).and_then(scalar))
}

/// An id sent as a JSON number or string.
fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// HeyReach ids are positive integers. Bounded, so no long value can become
/// a record or reach a read.
fn is_numeric_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_digit())
}

fn is_campaign_id(id: &str) -> bool {
    is_numeric_id(id)
}

/// A conversation id is base64-like text (`2-ODM0YmIz…==`). A `/` is
/// refused: the id goes into the read's path as one segment.
fn is_conversation_id(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'=' | b'+'))
}

// ── Naming records ──────────────────────────────────────────────────────────

/// A card names a campaign by its bare id, and a message's recipient only by
/// a conversation id. The gateway reads their names through this seam, under
/// the guards in `proxy::approval_enrich` (the agent must be allowed the same
/// read itself, with the held request's own credential, inside a short
/// budget, cached per connection). Any failure keeps the id.
impl RecordResolver for HeyReach {
    /// A campaign is a bare positive integer; a conversation is
    /// `{sender account id}/{conversation id}`. Nothing else is a record.
    fn object_of(&self, id: &str) -> Option<&'static str> {
        match id.split_once('/') {
            None => is_campaign_id(id).then_some(CAMPAIGN),
            Some((account, conversation)) => {
                (is_numeric_id(account) && is_conversation_id(conversation)).then_some(CONVERSATION)
            }
        }
    }

    /// One documented GET per record, built only from a re-validated id:
    /// `campaign/GetById?campaignId=`, or `inbox/GetChatroom/{account}/{id}`.
    fn names_read(&self, object: &str, ids: &[&str]) -> String {
        let id = ids
            .iter()
            .copied()
            .find(|id| self.object_of(id) == Some(object));
        match (object, id.and_then(|id| id.split_once('/'))) {
            (CONVERSATION, Some((account, conversation))) => {
                format!("/api/public/inbox/GetChatroom/{account}/{conversation}")
            }
            _ => format!(
                "/api/public/campaign/GetById?campaignId={}",
                id.filter(|id| is_campaign_id(id)).unwrap_or("0")
            ),
        }
    }

    /// A campaign answers `{ id, name, … }`. A conversation answers its
    /// `id`, its sender's `linkedInAccountId` and the `correspondentProfile`
    /// (the person on the other side), named by their name, else their
    /// profile URL. Nothing else from either answer is kept.
    fn parse_names(&self, object: &str, body: &[u8]) -> Vec<(String, String)> {
        let Some(v) = parse_json(body) else {
            return Vec::new();
        };
        let named = |id: Option<String>, name: Option<String>| match (id, name) {
            (Some(id), Some(name)) if !name.trim().is_empty() => {
                vec![(id, one_line(&name, MAX_VALUE_LEN))]
            }
            _ => Vec::new(),
        };
        match object {
            CAMPAIGN => named(
                v.get("id").and_then(scalar),
                v.get("name").and_then(Value::as_str).map(str::to_string),
            ),
            CONVERSATION => {
                let id = match (
                    v.get("linkedInAccountId").and_then(scalar),
                    v.get("id").and_then(scalar),
                ) {
                    (Some(account), Some(conversation)) => {
                        Some(format!("{account}/{conversation}"))
                    }
                    _ => None,
                };
                named(id, v.get("correspondentProfile").and_then(lead_name))
            }
            _ => Vec::new(),
        }
    }

    /// HeyReach has no stable per-record deep link, so records are named but
    /// not linked.
    fn record_url(&self, _host: &str, _id: &str) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summarize_request;

    const P: &str = "/api/public";

    fn card(method: &str, path: &str, body: &str) -> ApprovalSummary {
        summarize_request(
            "heyreach",
            method,
            path,
            Some("application/json"),
            (!body.is_empty()).then_some(body.as_bytes()),
        )
    }

    fn row<'a>(s: &'a ApprovalSummary, label: &str) -> Option<&'a str> {
        s.details
            .iter()
            .find(|d| d.label == label)
            .map(|d| d.value.as_str())
    }

    /// Fold `names` into `s` the way the gateway does once it read them.
    fn named(mut s: ApprovalSummary, names: &[(&str, &str)]) -> ApprovalSummary {
        s.name_refs(|id| names.iter().find(|(i, _)| *i == id).map(|(_, n)| *n));
        s.finalize_title();
        s
    }

    // Every operation of the published Postman collection
    // (documenter.getpostman.com/view/23808049/2sA2xb5F75), path parameters
    // filled with sample ids, and the title its card leads with.
    const DOCUMENTED: &[(&str, &str, &str)] = &[
        ("GET", "/auth/CheckApiKey", "Check the API key"),
        ("POST", "/campaign/GetAll", "List campaigns"),
        (
            "POST",
            "/campaign/GetCampaignsForLead",
            "List a lead's campaigns",
        ),
        ("GET", "/campaign/GetById?campaignId=7", "Read campaign 7"),
        (
            "GET",
            "/campaign/GetCampaignSequence?campaignId=7",
            "Read the sequence of campaign 7",
        ),
        ("POST", "/campaign/GetLeadsFromCampaign", "List the leads"),
        ("POST", "/campaign/Pause?campaignId=7", "Pause campaign 7"),
        ("POST", "/campaign/Resume?campaignId=7", "Resume campaign 7"),
        (
            "POST",
            "/campaign/StartCampaign?campaignId=7",
            "Start campaign 7",
        ),
        ("POST", "/campaign/AddLeadsToCampaign", "Add leads"),
        ("POST", "/campaign/AddLeadsToCampaignV2", "Add leads"),
        ("POST", "/campaign/StopLeadInCampaign", "Stop a lead"),
        ("POST", "/campaign/Create", "Create campaign"),
        (
            "POST",
            "/campaign/CreateCampaignFromTemplate",
            "Create campaign",
        ),
        ("POST", "/campaign/UpdateSettings", "Change the settings"),
        ("POST", "/campaign/UpdateSchedule", "Change the schedule"),
        (
            "POST",
            "/campaign/UpdateAccounts",
            "Replace the sender accounts",
        ),
        ("POST", "/campaign/UpdateSequence", "Replace the sequence"),
        (
            "POST",
            "/campaign/AddLinkedInAccountsToCampaign",
            "Add sender accounts",
        ),
        (
            "POST",
            "/campaign/RemoveLinkedInAccountsFromCampaign",
            "Remove sender accounts",
        ),
        (
            "PATCH",
            "/campaign/UpdateLeadCustomFields/campaigns/7/leads/custom-fields",
            "Update a lead's fields in campaign 7",
        ),
        ("POST", "/inbox/GetConversationsV2", "Read the inbox"),
        ("POST", "/inbox/GetConversationsV3", "Read the inbox"),
        ("GET", "/inbox/GetChatroom/1/2-ODM0", "Read a conversation"),
        ("POST", "/inbox/SendMessage", "Send a LinkedIn message"),
        (
            "POST",
            "/inbox/SetSeenStatus",
            "Mark a conversation as seen",
        ),
        ("POST", "/li_account/GetAll", "List sender accounts"),
        (
            "GET",
            "/li_account/GetById?accountId=1",
            "Read a sender account",
        ),
        (
            "DELETE",
            "/li_account/RemoveAccount/1",
            "Remove a sender account",
        ),
        ("POST", "/li_account/Connect", "Connect a sender account"),
        (
            "POST",
            "/li_account/ConnectWithCookies",
            "Connect a sender account with its cookies",
        ),
        (
            "GET",
            "/li_account/GetAccountStatus/1",
            "Read a sender account's status",
        ),
        (
            "POST",
            "/li_account/SubmitPin",
            "Submit a sender account's sign-in PIN",
        ),
        (
            "POST",
            "/li_account/Reconnect",
            "Reconnect a sender account",
        ),
        (
            "POST",
            "/li_account/ReloginSalesNavigator",
            "Sign a sender account in to Sales Navigator again",
        ),
        (
            "POST",
            "/li_account/ReloginRecruiter",
            "Sign a sender account in to Recruiter again",
        ),
        ("POST", "/li_account/Resync", "Resync a sender account"),
        (
            "GET",
            "/li_account/GetProxyCountries",
            "List proxy countries",
        ),
        (
            "GET",
            "/li_account/GetAccountProxy/1",
            "Read a sender account's proxy",
        ),
        (
            "POST",
            "/li_account/UpdateProxy",
            "Change a sender account's proxy",
        ),
        (
            "POST",
            "/li_account/UpdateInboxConfiguration",
            "Change a sender account's inbox sync",
        ),
        ("GET", "/list/GetById?listId=1", "Read a list"),
        ("POST", "/list/GetAll", "List lead lists"),
        (
            "POST",
            "/list/GetLeadsFromList",
            "List the leads in a lead list",
        ),
        (
            "DELETE",
            "/list/DeleteLeadsFromList",
            "Remove leads from a lead list",
        ),
        (
            "DELETE",
            "/list/DeleteLeadsFromListByProfileUrl",
            "Remove leads from a lead list",
        ),
        (
            "POST",
            "/list/GetCompaniesFromList",
            "List the companies in a list",
        ),
        ("POST", "/list/AddLeadsToList", "Add leads to a lead list"),
        ("POST", "/list/AddLeadsToListV2", "Add leads to a lead list"),
        ("POST", "/list/GetListsForLead", "List a lead's lists"),
        ("POST", "/list/CreateEmptyList", "Create a lead list"),
        (
            "PATCH",
            "/list/UpdateLeadCustomFields/lists/1/leads/custom-fields",
            "Update a lead's fields in a list",
        ),
        ("POST", "/stats/GetOverallStats", "Read stats"),
        (
            "POST",
            "/stats/GetOverallStatsByCampaign",
            "Read stats per campaign",
        ),
        ("POST", "/lead/GetLead", "Read a lead"),
        ("POST", "/lead/AddTags", "Tag a lead"),
        ("POST", "/lead/GetTags", "Read a lead's tags"),
        ("POST", "/lead/ReplaceTags", "Replace a lead's tags"),
        ("POST", "/lead_tags/CreateTags", "Create tags"),
        ("POST", "/webhooks/CreateWebhook", "Create a webhook"),
        (
            "GET",
            "/webhooks/GetWebhookById?webhookId=1",
            "Read a webhook",
        ),
        ("POST", "/webhooks/GetAllWebhooks", "List webhooks"),
        (
            "PATCH",
            "/webhooks/UpdateWebhook?webhookId=1",
            "Change a webhook",
        ),
        (
            "DELETE",
            "/webhooks/DeleteWebhook?webhookId=1",
            "Delete a webhook",
        ),
        (
            "POST",
            "/MyNetwork/GetMyNetworkForSender",
            "List a sender's connections",
        ),
        (
            "POST",
            "/MyNetwork/IsConnection",
            "Check a LinkedIn connection",
        ),
        ("POST", "/enrichment/enrich-email", "Find a lead's email"),
        (
            "GET",
            "/enrichment/enrich-email/check-job/48213",
            "Read an email search result",
        ),
        ("POST", "/blacklist/GetLeads", "List blacklisted leads"),
        ("POST", "/blacklist/AddLeads", "Blacklist leads"),
        (
            "POST",
            "/blacklist/RemoveLeads",
            "Remove leads from the blacklist",
        ),
        (
            "POST",
            "/blacklist/GetCompanies",
            "List blacklisted companies",
        ),
        ("POST", "/blacklist/AddCompanies", "Blacklist companies"),
        (
            "POST",
            "/blacklist/RemoveCompanies",
            "Remove companies from the blacklist",
        ),
        (
            "GET",
            "/management/organizations/api-keys/workspaces/5",
            "Read a workspace's API keys",
        ),
        (
            "POST",
            "/management/organizations/api-keys/workspaces/5",
            "Create a workspace API key",
        ),
        (
            "GET",
            "/management/organizations/workspaces?Offset=0&Limit=10",
            "List workspaces",
        ),
        (
            "POST",
            "/management/organizations/workspaces",
            "Create a workspace",
        ),
        (
            "PATCH",
            "/management/organizations/workspaces/5",
            "Change a workspace",
        ),
        (
            "POST",
            "/management/organizations/users",
            "List organization users",
        ),
        (
            "POST",
            "/management/organizations/users/invite/admins",
            "Invite organization admins",
        ),
        (
            "POST",
            "/management/organizations/users/invite/members",
            "Invite organization members",
        ),
        (
            "POST",
            "/management/organizations/users/invite/managers",
            "Invite organization managers",
        ),
        (
            "GET",
            "/management/organizations/users/9",
            "Read an organization user",
        ),
        (
            "POST",
            "/management/organizations/users/workspaces/5",
            "List a workspace's users",
        ),
        (
            "POST",
            "/management/organizations/linkedin-accounts",
            "List the organization's sender accounts",
        ),
        (
            "DELETE",
            "/management/organizations/linkedin-accounts/1",
            "Delete a sender account",
        ),
        (
            "POST",
            "/management/organizations/linkedin-accounts/MoveToWorkspace",
            "Move a sender account to another workspace",
        ),
    ];

    #[test]
    fn every_documented_route_reads_in_heyreachs_words() {
        assert_eq!(DOCUMENTED.len(), 88, "one row per documented operation");
        for (method, path, title) in DOCUMENTED {
            let s = card(method, &format!("{P}{path}"), "");
            let s = named(s, &[]);
            assert_eq!(s.action, *title, "{method} {path}");
        }
    }

    #[test]
    fn a_route_outside_the_published_api_falls_back_to_the_generic_card() {
        for (method, path) in [
            ("POST", "/campaign/SomeNewThing"),
            // The undocumented spelling of `li_account`.
            ("POST", "/linkedinaccount/GetAll"),
            // A documented route with another verb.
            ("POST", "/campaign/GetById"),
            ("POST", "/management/organizations/users/invite/owners"),
        ] {
            let path = format!("{P}{path}");
            let s = card(method, &path, "{}");
            assert_eq!(
                s,
                crate::generic::summarize(&SummaryRequest {
                    method,
                    path: &path,
                    content_type: Some("application/json"),
                    body: Some(b"{}"),
                }),
                "{method} {path}"
            );
        }
        assert!(HeyReach
            .summarize(&SummaryRequest {
                method: "POST",
                path: "/api/internal/campaign/GetAll",
                content_type: None,
                body: None,
            })
            .is_none());
    }

    // ── Reads ──

    #[test]
    fn a_paged_read_is_titled_and_keeps_its_filters() {
        let s = card(
            "POST",
            &format!("{P}/li_account/GetAll"),
            r#"{"offset":0,"keyword":"sales","limit":10}"#,
        );
        assert_eq!(s.action, "List sender accounts");
        assert_eq!(row(&s, "Keyword"), Some("sales"));
        // A titled route keeps the generic rows, and is counted as such by
        // the card-kind telemetry; the outreach cards are dedicated.
        assert!(s.is_generic());
        assert!(!card("POST", &format!("{P}/inbox/SendMessage"), "{}").is_generic());
    }

    #[test]
    fn the_path_ids_replace_the_generic_reading_of_the_path() {
        let s = card("GET", &format!("{P}/inbox/GetChatroom/123/2-ODM0YmIz"), "");
        assert_eq!(row(&s, "Sender account"), Some("123"));
        assert_eq!(row(&s, "Conversation"), Some("2-ODM0YmIz"));
        // The action names in the path never read as records.
        let s = card(
            "POST",
            &format!("{P}/stats/GetOverallStatsByCampaign"),
            r#"{"campaignIds":[1]}"#,
        );
        assert!(!s.render_text().contains("GetOverallStatsByCampaign: "));
        assert!(s
            .details
            .iter()
            .all(|d| d.value != "GetOverallStatsByCampaign"));
    }

    #[test]
    fn reads_that_answer_a_secret_say_so() {
        let s = card("GET", &format!("{P}/li_account/GetAccountProxy/1"), "");
        assert_eq!(
            row(&s, "Answer"),
            Some("Includes a custom proxy's username and password")
        );
        let s = card(
            "GET",
            &format!("{P}/management/organizations/api-keys/workspaces/5"),
            "",
        );
        assert_eq!(row(&s, "Answer"), Some("Includes the workspace's API keys"));
        let s = card(
            "GET",
            &format!("{P}/webhooks/GetWebhookById?webhookId=1&includeCustomHeaders=true"),
            "",
        );
        assert_eq!(
            row(&s, "Answer"),
            Some("Includes the headers the webhook sends")
        );
        let s = card(
            "POST",
            &format!("{P}/webhooks/GetAllWebhooks"),
            r#"{"offset":0,"limit":100,"includeCustomHeaders":true}"#,
        );
        assert_eq!(
            row(&s, "Answer"),
            Some("Includes the headers each webhook sends")
        );
        // Without the flag, nothing to warn about.
        let s = card(
            "GET",
            &format!("{P}/webhooks/GetWebhookById?webhookId=1"),
            "",
        );
        assert_eq!(row(&s, "Answer"), None);
    }

    #[test]
    fn writes_with_a_wider_reach_say_how_far() {
        let s = card(
            "DELETE",
            &format!("{P}/li_account/RemoveAccount/1?force=true"),
            "",
        );
        assert_eq!(
            row(&s, "Campaigns"),
            Some("Also removed from its active campaigns")
        );
        let s = card("DELETE", &format!("{P}/li_account/RemoveAccount/1"), "");
        assert_eq!(row(&s, "Campaigns"), None);
        let s = card(
            "POST",
            &format!("{P}/management/organizations/api-keys/workspaces/5"),
            r#"{"apiKeyType":"PUBLIC"}"#,
        );
        assert_eq!(
            row(&s, "Replaces"),
            Some("Deactivates the workspace's current key of this type")
        );
    }

    #[test]
    fn sign_in_secrets_never_reach_the_card() {
        for (path, body) in [
            (
                "/li_account/Connect",
                r#"{"username":"user@example.com","password":"pw-1","twoFactorAuthKey":"JBSWY3DPEHPK3PXP","proxyCountryCode":"US"}"#,
            ),
            (
                "/li_account/SubmitPin",
                r#"{"accountId":123,"pin":"864209"}"#,
            ),
            (
                "/li_account/ConnectWithCookies",
                r#"{"cookies":[{"name":"li_at","value":"AQEDAR-cookie","domain":".linkedin.com"}]}"#,
            ),
            (
                "/li_account/UpdateProxy",
                r#"{"accountId":1,"customProxy":{"host":"proxy.example.com","port":8080,"username":"u","password":"proxy-pw"}}"#,
            ),
        ] {
            let text = card("POST", &format!("{P}{path}"), body).render_text();
            for secret in [
                "pw-1",
                "JBSWY3DPEHPK3PXP",
                "864209",
                "AQEDAR-cookie",
                "proxy-pw",
            ] {
                assert!(!text.contains(secret), "{path}: {text}");
            }
        }
    }

    // ── Campaigns ──

    #[test]
    fn a_campaign_in_the_query_or_the_body_is_named_in_the_title() {
        let s = card("POST", &format!("{P}/campaign/Pause?campaignId=235"), "");
        assert_eq!(row(&s, "Campaign"), Some("Campaign · 235"));
        // Not repeated as the generic query row.
        assert_eq!(row(&s, "Campaign id"), None);
        let s = named(s, &[("235", "Q4 outbound")]);
        assert_eq!(s.action, "Pause campaign Q4 outbound");
        assert_eq!(row(&s, "Campaign"), Some("Q4 outbound (235)"));

        let s = card(
            "POST",
            &format!("{P}/campaign/GetLeadsFromCampaign"),
            r#"{"campaignId":1805,"offset":0,"limit":100}"#,
        );
        let s = named(s, &[("1805", "Q4 outbound")]);
        assert_eq!(s.action, "List the leads in campaign Q4 outbound");
    }

    #[test]
    fn only_a_plain_id_becomes_a_campaign_record() {
        for id in ["abc", "-1", "1.5", "235%2Fx", &"9".repeat(21)] {
            let s = card("POST", &format!("{P}/campaign/Pause?campaignId={id}"), "");
            assert_eq!(s.ref_ids().count(), 0, "{id:?}");
            assert_eq!(named(s, &[]).action, "Pause campaign");
        }
    }

    const ADD_LEADS: &str = r#"{"campaignId":235,"accountLeadPairs":[
        {"linkedInAccountId":123,"lead":{"firstName":"John","lastName":"Doe","profileUrl":"https://www.linkedin.com/in/john-doe"}},
        {"linkedInAccountId":456,"lead":{"profileUrl":"https://www.linkedin.com/in/ada"}},
        {"linkedInAccountId":123,"lead":{"emailAddress":"jane@example.com"}}
    ],"resumeFinishedCampaign":false,"resumePausedCampaign":true}"#;

    #[test]
    fn adding_leads_to_a_campaign_says_who_from_whom_and_what_it_restarts() {
        let s = card(
            "POST",
            &format!("{P}/campaign/AddLeadsToCampaignV2"),
            ADD_LEADS,
        );
        assert_eq!(row(&s, "Leads"), Some("3 leads"));
        assert_eq!(
            row(&s, "Who"),
            Some("John Doe, https://www.linkedin.com/in/ada, jane@example.com")
        );
        assert_eq!(row(&s, "Senders"), Some("123, 456"));
        assert_eq!(row(&s, "Campaign state"), Some("Resumed if it is paused"));
        assert_eq!(
            named(s, &[("235", "Q4 outbound")]).action,
            "Add leads to campaign Q4 outbound"
        );
    }

    #[test]
    fn a_long_lead_batch_is_counted_not_listed() {
        let pairs: Vec<String> = (0..40)
            .map(|i| format!(r#"{{"lead":{{"firstName":"P{i}"}}}}"#))
            .collect();
        let body = format!(
            r#"{{"campaignId":1,"accountLeadPairs":[{}]}}"#,
            pairs.join(",")
        );
        let s = card("POST", &format!("{P}/campaign/AddLeadsToCampaign"), &body);
        assert_eq!(row(&s, "Leads"), Some("40 leads"));
        assert!(row(&s, "Who").unwrap().ends_with("(+35 more)"));
    }

    #[test]
    fn a_cut_body_says_so_instead_of_reading_as_empty() {
        let s = card(
            "POST",
            &format!("{P}/campaign/AddLeadsToCampaignV2"),
            r#"{"campaignId":235,"accountLeadPairs":[{"lead":{"firstN"#,
        );
        assert_eq!(s.action, "Add leads");
        assert_eq!(row(&s, "Leads"), None);
        assert!(row(&s, "Body").is_some_and(|b| b.contains("JSON")), "{s:?}");
    }

    #[test]
    fn adding_leads_to_a_list_counts_them() {
        let s = card(
            "POST",
            &format!("{P}/list/AddLeadsToListV2"),
            r#"{"listId":123,"leads":[{"firstName":"John","lastName":"Doe"}]}"#,
        );
        assert_eq!(row(&s, "List"), Some("123"));
        assert_eq!(row(&s, "Leads"), Some("1 lead"));
        assert_eq!(row(&s, "Who"), Some("John Doe"));
    }

    #[test]
    fn stopping_a_lead_names_the_lead_and_the_campaign() {
        let s = card(
            "POST",
            &format!("{P}/campaign/StopLeadInCampaign"),
            r#"{"campaignId":123,"leadMemberId":"123123123","leadUrl":"https://www.linkedin.com/in/john-doe"}"#,
        );
        assert_eq!(
            row(&s, "Lead"),
            Some("https://www.linkedin.com/in/john-doe")
        );
        assert_eq!(
            named(s, &[("123", "Q4 outbound")]).action,
            "Stop a lead in campaign Q4 outbound"
        );
    }

    // The documented example body (Create), with its sample values.
    const CREATE: &str = r#"{"name":"My New Campaign","linkedInUserListId":123456,
        "linkedInAccountIds":[11111,22222],"excludeContactedFromOtherCampaigns":true,
        "schedule":{"dailyStartTime":"09:00:00","dailyEndTime":"17:00:00","timeZoneId":"Europe/London",
          "enabledMonday":true,"enabledTuesday":true,"enabledWednesday":true,"enabledThursday":true,
          "enabledFriday":true,"enabledSaturday":false,"enabledSunday":false,"startDate":null,"endDate":null},
        "sequence":{"nodeType":"CONNECTION_REQUEST","actionDelay":0,"actionDelayUnit":"DAY",
          "payload":{"messages":["Hi {FIRST_NAME}, I'd love to connect!"],"fallbackMessage":"Hi there, I'd love to connect!","toBeWithdrawnAfterDays":30},
          "conditionalNode":{"nodeType":"MESSAGE","actionDelay":2,"actionDelayUnit":"DAY",
            "payload":{"messages":["Thanks for connecting, {FIRST_NAME}!"],"fallbackMessage":"Thanks for connecting!"},
            "unconditionalNode":{"nodeType":"SEND_LEAD_TO_BISON","actionDelay":3,"actionDelayUnit":"HOUR",
              "payload":{"bisonCampaignId":4321,"stopExternalLead":false},
              "unconditionalNode":{"nodeType":"END","actionDelay":3,"actionDelayUnit":"HOUR"}}},
          "unconditionalNode":{"nodeType":"VIEW_PROFILE","actionDelay":1,"actionDelayUnit":"DAY",
            "unconditionalNode":{"nodeType":"END","actionDelay":3,"actionDelayUnit":"HOUR"}}}}"#;

    #[test]
    fn creating_a_campaign_reads_as_what_it_will_do() {
        let s = card("POST", &format!("{P}/campaign/Create"), CREATE);
        assert_eq!(s.action, "Create campaign");
        assert_eq!(row(&s, "Name"), Some("My New Campaign"));
        assert_eq!(row(&s, "Lead list"), Some("123456"));
        assert_eq!(row(&s, "Senders"), Some("11111, 22222"));
        assert_eq!(row(&s, "Skips"), Some("leads in other campaigns"));
        assert_eq!(row(&s, "Hours"), Some("09:00–17:00 Europe/London"));
        assert_eq!(row(&s, "Days"), Some("Mon, Tue, Wed, Thu, Fri"));
        assert!(!s.render_text().contains("nodeType"));
    }

    #[test]
    fn the_sequence_reads_each_path_of_the_tree() {
        let s = card("POST", &format!("{P}/campaign/Create"), CREATE);
        let steps: Vec<(&str, &str)> = s
            .details
            .iter()
            .filter(|d| d.label.starts_with("Step"))
            .map(|d| (d.label.as_str(), d.value.as_str()))
            .collect();
        assert_eq!(
            steps,
            vec![
                (
                    "Step 1",
                    "Send a connection request: “Hi {FIRST_NAME}, I'd love to connect!”"
                ),
                (
                    "Step 2 (accepted)",
                    "After 2 days, send a message: “Thanks for connecting, {FIRST_NAME}!”"
                ),
                (
                    "Step 3 (accepted)",
                    "After 3 hours, send them to EmailBison"
                ),
                ("Step 2 (not accepted)", "After 1 day, view their profile"),
            ]
        );
    }

    #[test]
    fn replacing_a_sequence_names_its_campaign() {
        let body = r#"{"campaignId":12345,"sequence":{"nodeType":"MESSAGE","payload":{"messages":["Hi","Hello"]},"unconditionalNode":{"nodeType":"END"}}}"#;
        let s = card("POST", &format!("{P}/campaign/UpdateSequence"), body);
        assert_eq!(
            row(&s, "Step 1"),
            Some("Send a message: “Hi” (+1 variants)")
        );
        assert_eq!(
            named(s, &[("12345", "Q4")]).action,
            "Replace the sequence of campaign Q4"
        );
    }

    #[test]
    fn a_long_or_hostile_sequence_stays_bounded() {
        let depth = 40;
        let mut body = String::from(r#"{"sequence":"#);
        for _ in 0..depth {
            body.push_str(r#"{"nodeType":"MESSAGE","actionDelay":1,"actionDelayUnit":"DAY","unconditionalNode":"#);
        }
        body.push_str(r#"{"nodeType":"END"}"#);
        body.push_str(&"}".repeat(depth + 1));
        let s = card("POST", &format!("{P}/campaign/Create"), &body);
        assert!(row(&s, "Step 12").is_some());
        assert_eq!(row(&s, "Step 13"), None);
        assert_eq!(row(&s, "More steps"), Some("+28 more"));
        for body in [
            r#"{"sequence":null}"#,
            r#"{"sequence":"text"}"#,
            r#"{"sequence":{"nodeType":123}}"#,
            r#"{"sequence":{"nodeType":"MESSAGE","actionDelay":-5,"actionDelayUnit":"WEEK"}}"#,
            r#"{"sequence":{"nodeType":"MESSAGE","payload":{"messages":"nope"}}}"#,
            r#"{"schedule":"not an object","linkedInAccountIds":"nope"}"#,
        ] {
            let s = card("POST", &format!("{P}/campaign/Create"), body);
            assert_eq!(s.action, "Create campaign", "{body}");
            assert!(s.render_text().chars().count() <= crate::MAX_RENDER_LEN);
        }
    }

    #[test]
    fn a_delay_without_a_known_unit_is_not_guessed() {
        let body = r#"{"sequence":{"nodeType":"VIEW_PROFILE","actionDelay":2}}"#;
        let s = card("POST", &format!("{P}/campaign/Create"), body);
        assert_eq!(
            row(&s, "Step 1"),
            Some("After a delay of 2, view their profile")
        );
    }

    #[test]
    fn copying_a_campaign_names_the_one_it_copies() {
        let body = r#"{"campaignIdForTemplate":12345,"name":"My Copy","linkedInUserListId":123456,"linkedInAcccountIdsForCampaign":[11111,22222]}"#;
        let s = card(
            "POST",
            &format!("{P}/campaign/CreateCampaignFromTemplate"),
            body,
        );
        assert_eq!(row(&s, "Name"), Some("My Copy"));
        assert_eq!(row(&s, "Senders"), Some("11111, 22222"));
        assert_eq!(
            named(s, &[("12345", "Q4 outbound")]).action,
            "Create campaign from Q4 outbound"
        );
    }

    #[test]
    fn a_schedule_change_reads_as_hours_and_days() {
        let body = r#"{"campaignId":12345,"schedule":{"dailyStartTime":"08:30:00","dailyEndTime":"16:00:00","timeZoneId":"Etc/GMT","enabledSaturday":true,"startDate":"2026-11-01"}}"#;
        let s = card("POST", &format!("{P}/campaign/UpdateSchedule"), body);
        assert_eq!(row(&s, "Hours"), Some("08:30–16:00 Etc/GMT"));
        assert_eq!(row(&s, "Days"), Some("Sat"));
        assert_eq!(row(&s, "Starts"), Some("2026-11-01"));
    }

    // ── Messages ──

    const SEND: &str = r#"{"message":"Hi there\nWould love to chat.","subject":"Quick question","conversationId":"2-ODM0YmIz==","linkedInAccountId":123}"#;

    #[test]
    fn a_message_shows_its_text_and_names_its_recipient() {
        let s = card("POST", &format!("{P}/inbox/SendMessage"), SEND);
        assert_eq!(s.action, "Send a LinkedIn message");
        assert_eq!(row(&s, "To"), Some("Conversation 2-ODM0YmIz=="));
        assert_eq!(row(&s, "From"), Some("Sender account 123"));
        assert_eq!(row(&s, "Subject"), Some("Quick question"));
        assert_eq!(row(&s, "Message"), Some("Hi there\nWould love to chat."));
        let s = named(s, &[("123/2-ODM0YmIz==", "Jane Smith")]);
        assert_eq!(row(&s, "To"), Some("Jane Smith"));
    }

    #[test]
    fn a_message_without_its_sender_cannot_name_the_recipient() {
        let s = card(
            "POST",
            &format!("{P}/inbox/SendMessage"),
            r#"{"message":"Hi","conversationId":"2-ODM0"}"#,
        );
        assert_eq!(row(&s, "To"), Some("Conversation 2-ODM0"));
        assert_eq!(s.ref_ids().count(), 0);
    }

    #[test]
    fn agent_text_can_never_forge_a_row() {
        let s = card(
            "POST",
            &format!("{P}/inbox/SendMessage"),
            r#"{"message":"ok","subject":"Hi\nApproved: yes","conversationId":"2-ODM0","linkedInAccountId":1}"#,
        );
        assert_eq!(row(&s, "Subject"), Some("Hi Approved: yes"));
    }

    // ── Naming records ──

    #[test]
    fn only_documented_id_shapes_are_records() {
        let r = HeyReach;
        assert_eq!(r.object_of("235"), Some(CAMPAIGN));
        assert_eq!(r.object_of("123/2-ODM0YmIz=="), Some(CONVERSATION));
        for bad in [
            "",
            "abc",
            "-1",
            "23 5",
            "../etc",
            &"9".repeat(21),
            "x/2-ODM0",
            "123/",
            "123/a/b",
            "123/a?b",
            "123/a%2F..",
        ] {
            assert_eq!(r.object_of(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_name_reads_are_server_built_documented_gets() {
        let r = HeyReach;
        assert_eq!(
            r.names_read(CAMPAIGN, &["235"]),
            "/api/public/campaign/GetById?campaignId=235"
        );
        assert_eq!(
            r.names_read(CONVERSATION, &["123/2-ODM0YmIz=="]),
            "/api/public/inbox/GetChatroom/123/2-ODM0YmIz=="
        );
        // An id that is no record never reaches a read.
        assert_eq!(
            r.names_read(CAMPAIGN, &["../../admin"]),
            "/api/public/campaign/GetById?campaignId=0"
        );
    }

    #[test]
    fn the_answers_name_only_what_they_are() {
        let r = HeyReach;
        assert_eq!(
            r.parse_names(
                CAMPAIGN,
                br#"{"id":274079,"name":"My First Campaign","status":"IN_PROGRESS"}"#
            ),
            vec![("274079".to_string(), "My First Campaign".to_string())]
        );
        assert_eq!(
            r.parse_names(
                CONVERSATION,
                br#"{"id":"2-ODM0","linkedInAccountId":123,"messages":[{"body":"private"}],
                    "correspondentProfile":{"firstName":"Jane","lastName":"Smith","emailAddress":"jane@example.com"}}"#
            ),
            vec![("123/2-ODM0".to_string(), "Jane Smith".to_string())]
        );
        // A name with a line break reads on one line.
        assert_eq!(
            r.parse_names(CAMPAIGN, br#"{"id":1,"name":"Q4\nApproved: yes"}"#)[0].1,
            "Q4 Approved: yes"
        );
        for (object, body) in [
            (CAMPAIGN, &br#"{"id":1}"#[..]),
            (CAMPAIGN, br#"{"name":"No id"}"#),
            (CAMPAIGN, br#"{"id":1,"name":"   "}"#),
            (CAMPAIGN, br#"[{"id":1,"name":"x"}]"#),
            (
                CONVERSATION,
                br#"{"id":"2-ODM0","correspondentProfile":{"firstName":"Jane"}}"#,
            ),
            (CONVERSATION, br#"{"id":"2-ODM0","linkedInAccountId":1}"#),
            ("Other", br#"{"id":1,"name":"x"}"#),
            (CAMPAIGN, b"not json"),
        ] {
            assert!(r.parse_names(object, body).is_empty(), "{object} {body:?}");
        }
    }

    #[test]
    fn records_are_named_but_never_linked() {
        assert_eq!(HeyReach.record_url("api.heyreach.io", "235"), None);
    }

    // ── Hostile input ──

    #[test]
    fn survives_hostile_bodies_without_panicking() {
        let bodies: Vec<Vec<u8>> = vec![
            b"".to_vec(),
            b"null".to_vec(),
            b"[]".to_vec(),
            b"\"just a string\"".to_vec(),
            br#"{"accountLeadPairs":"not an array"}"#.to_vec(),
            br#"{"accountLeadPairs":[null,1,"x",{}]}"#.to_vec(),
            br#"{"leads":[{"firstName":null,"lastName":123}]}"#.to_vec(),
            br#"{"campaignId":{"nested":1}}"#.to_vec(),
            b"{\"message\":\xf0\x9f\x92\xa9\"}".to_vec(),
            "{\"name\":\"\u{0}\u{1}\u{7f}emoji 🚀 日本語\"}"
                .as_bytes()
                .to_vec(),
            br#"{"linkedInAccountId":1e400,"conversationId":"x"}"#.to_vec(),
            vec![0xff, 0xfe, 0x00, 0x01],
            br#"{"leads":["#.to_vec(),
        ];
        for (method, path, _) in DOCUMENTED {
            for body in &bodies {
                let s = summarize_request(
                    "heyreach",
                    method,
                    &format!("{P}{path}"),
                    Some("application/json"),
                    Some(body),
                );
                assert!(s.render_text().chars().count() <= crate::MAX_RENDER_LEN);
            }
        }
    }
}
