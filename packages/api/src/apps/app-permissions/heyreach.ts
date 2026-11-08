import type { AppPermissionDefinition, AppTool } from "./types";

// HeyReach public API (api.heyreach.io/api/public), every operation of the
// published Postman collection
// (documenter.getpostman.com/view/23808049/2sA2xb5F75), each with its
// documented method.
//
// Reads are mostly POSTs: HeyReach pages a list with an `{ offset, limit }`
// body rather than a query string. So the split below follows what a call
// DOES, not its verb, and every route is named exactly: no read shares a
// method and path with a write, and there is no catch-all wildcard.
//
// Item routes end in `*/` (one segment exactly). The organization
// management routes (`/management/organizations/…`) answer only an
// organization (Master) API key; they are listed so they can be set to Never.
//
// Three documented GETs are deliberately no read tool, so a default grant
// holds them for approval (pinned in `catalog-unlisted-reads.test.ts`):
// `li_account/GetAccountProxy/{id}` (a custom proxy's username and
// password), `management/organizations/api-keys/workspaces/{id}` (the
// workspace's API keys) and `webhooks/GetWebhookById` (with
// `includeCustomHeaders`, the headers the webhook sends to its endpoint).
// `webhooks/GetAllWebhooks` takes the same flag in its body, so it is no
// read tool either: as a POST, it needs approval as an other write.
const HOST = "api.heyreach.io";
const P = "/api/public";
const ORG = `${P}/management/organizations`;

const tool = (
  id: string,
  name: string,
  description: string,
  method: string | string[],
  pathPattern: string,
  aliasPatterns?: string[],
): AppTool => ({
  id,
  name,
  description,
  hostPattern: HOST,
  pathPattern,
  ...(aliasPatterns ? { aliasPatterns } : {}),
  ...(typeof method === "string" ? { method } : { methods: method }),
});

export const heyreachPermissions: AppPermissionDefinition = {
  provider: "heyreach",
  groups: [
    {
      category: "read",
      tools: [
        tool(
          "check_api_key",
          "Check API key",
          "Confirm the connected key works",
          "GET",
          `${P}/auth/CheckApiKey`,
        ),
        tool(
          "list_campaigns",
          "List campaigns",
          "List campaigns, or the campaigns a lead is in",
          "POST",
          `${P}/campaign/GetAll`,
          [`${P}/campaign/GetCampaignsForLead`],
        ),
        tool(
          "get_campaign",
          "Get campaign",
          "Read a campaign and its sequence",
          "GET",
          `${P}/campaign/GetById`,
          [`${P}/campaign/GetCampaignSequence`],
        ),
        tool(
          "list_campaign_leads",
          "List campaign leads",
          "List the leads in a campaign and their progress",
          "POST",
          `${P}/campaign/GetLeadsFromCampaign`,
        ),
        tool(
          "list_lead_lists",
          "List lead lists",
          "List lead and company lists, or the lists a lead is in",
          "POST",
          `${P}/list/GetAll`,
          [`${P}/list/GetListsForLead`],
        ),
        tool(
          "get_lead_list",
          "Get lead list",
          "Read a lead or company list",
          "GET",
          `${P}/list/GetById`,
        ),
        tool(
          "list_list_leads",
          "List the leads in a list",
          "List the leads of a lead list or the companies of a company list",
          "POST",
          `${P}/list/GetLeadsFromList`,
          [`${P}/list/GetCompaniesFromList`],
        ),
        tool(
          "get_lead",
          "Get lead",
          "Read a lead and its tags by LinkedIn profile URL",
          "POST",
          `${P}/lead/GetLead`,
          [`${P}/lead/GetTags`],
        ),
        tool(
          "read_inbox",
          "Read the inbox",
          "List unified-inbox conversations",
          "POST",
          `${P}/inbox/GetConversationsV2`,
          [`${P}/inbox/GetConversationsV3`],
        ),
        tool(
          "read_conversation",
          "Read a conversation",
          "Read one conversation and its messages",
          "GET",
          // `{accountId}/{conversationId}`; a conversation id is base64 and
          // may carry a `/` of its own, so the route is matched to any depth.
          `${P}/inbox/GetChatroom/*`,
        ),
        tool(
          "list_sender_accounts",
          "List sender accounts",
          "List the LinkedIn accounts that send the outreach",
          "POST",
          `${P}/li_account/GetAll`,
        ),
        tool(
          "get_sender_account",
          "Get sender account",
          "Read a sender account and its connection status, and the proxy countries on offer",
          "GET",
          `${P}/li_account/GetById`,
          [
            `${P}/li_account/GetAccountStatus/*/`,
            `${P}/li_account/GetProxyCountries`,
          ],
        ),
        tool(
          "get_stats",
          "Get stats",
          "Read outreach statistics, overall or per campaign",
          "POST",
          `${P}/stats/GetOverallStats`,
          [`${P}/stats/GetOverallStatsByCampaign`],
        ),
        tool(
          "read_network",
          "Read a sender's network",
          "List a sender's LinkedIn connections, or check whether a lead is one",
          "POST",
          `${P}/MyNetwork/GetMyNetworkForSender`,
          [`${P}/MyNetwork/IsConnection`],
        ),
        tool(
          "read_blacklist",
          "Read the blacklist",
          "List the blacklisted leads and companies",
          "POST",
          `${P}/blacklist/GetLeads`,
          [`${P}/blacklist/GetCompanies`],
        ),
        tool(
          "get_email_search",
          "Get email search result",
          "Read the result of an email search started with Find a lead's email",
          "GET",
          `${P}/enrichment/enrich-email/check-job/*/`,
        ),
        tool(
          "read_organization",
          "Read the organization",
          "List the organization's workspaces, and read one of its users (Master API key only)",
          "GET",
          `${ORG}/workspaces`,
          [`${ORG}/users/*/`],
        ),
        tool(
          "list_organization_members",
          "List organization users and accounts",
          "List the organization's users, a workspace's users, and every sender account (Master API key only)",
          "POST",
          `${ORG}/users`,
          [`${ORG}/users/workspaces/*/`, `${ORG}/linkedin-accounts`],
        ),
      ],
    },
    {
      category: "write",
      tools: [
        tool(
          "send_message",
          "Send a LinkedIn message",
          "Send a message in a conversation from a sender account",
          "POST",
          `${P}/inbox/SendMessage`,
        ),
        tool(
          "mark_conversation_seen",
          "Mark a conversation seen",
          "Mark a conversation as seen or unseen",
          "POST",
          `${P}/inbox/SetSeenStatus`,
        ),
        tool(
          "add_leads_to_campaign",
          "Add leads to a campaign",
          "Add leads to a campaign, which starts outreach to them in an active one",
          "POST",
          `${P}/campaign/AddLeadsToCampaignV2`,
          [`${P}/campaign/AddLeadsToCampaign`],
        ),
        tool(
          "stop_lead_in_campaign",
          "Stop a lead",
          "Stop the outreach to one lead in a campaign",
          "POST",
          `${P}/campaign/StopLeadInCampaign`,
        ),
        tool(
          "start_campaign",
          "Start campaign",
          "Start a campaign created as a draft",
          "POST",
          `${P}/campaign/StartCampaign`,
        ),
        tool(
          "pause_campaign",
          "Pause campaign",
          "Pause a running campaign",
          "POST",
          `${P}/campaign/Pause`,
        ),
        tool(
          "resume_campaign",
          "Resume campaign",
          "Resume a paused campaign",
          "POST",
          `${P}/campaign/Resume`,
        ),
        tool(
          "create_campaign",
          "Create campaign",
          "Create a draft campaign, or copy one from a template",
          "POST",
          `${P}/campaign/Create`,
          [`${P}/campaign/CreateCampaignFromTemplate`],
        ),
        tool(
          "edit_campaign",
          "Edit campaign",
          "Change a campaign's settings, schedule or sender accounts",
          "POST",
          `${P}/campaign/UpdateSettings`,
          [
            `${P}/campaign/UpdateSchedule`,
            `${P}/campaign/UpdateAccounts`,
            `${P}/campaign/AddLinkedInAccountsToCampaign`,
            `${P}/campaign/RemoveLinkedInAccountsFromCampaign`,
          ],
        ),
        tool(
          "edit_campaign_sequence",
          "Edit campaign sequence",
          "Replace a campaign's sequence: its steps and the messages they send",
          "POST",
          `${P}/campaign/UpdateSequence`,
        ),
        tool(
          "update_lead_fields",
          "Update lead fields",
          "Set custom fields on a lead in a campaign or a list",
          "PATCH",
          `${P}/campaign/UpdateLeadCustomFields/campaigns/*/leads/custom-fields`,
          [`${P}/list/UpdateLeadCustomFields/lists/*/leads/custom-fields`],
        ),
        tool(
          "create_list",
          "Create a list",
          "Create an empty lead or company list",
          "POST",
          `${P}/list/CreateEmptyList`,
        ),
        tool(
          "add_leads_to_list",
          "Add leads to a list",
          "Add leads to a lead list",
          "POST",
          `${P}/list/AddLeadsToListV2`,
          [`${P}/list/AddLeadsToList`],
        ),
        tool(
          "remove_leads_from_list",
          "Remove leads from a list",
          "Remove leads from a lead list",
          "DELETE",
          `${P}/list/DeleteLeadsFromList`,
          [`${P}/list/DeleteLeadsFromListByProfileUrl`],
        ),
        tool(
          "tag_lead",
          "Tag a lead",
          "Add tags to a lead, or replace its tags",
          "POST",
          `${P}/lead/AddTags`,
          [`${P}/lead/ReplaceTags`],
        ),
        tool(
          "create_tags",
          "Create tags",
          "Create tags in the workspace",
          "POST",
          `${P}/lead_tags/CreateTags`,
        ),
        tool(
          "edit_blacklist",
          "Edit the blacklist",
          "Add leads or companies to the blacklist, or remove them",
          "POST",
          `${P}/blacklist/AddLeads`,
          [
            `${P}/blacklist/RemoveLeads`,
            `${P}/blacklist/AddCompanies`,
            `${P}/blacklist/RemoveCompanies`,
          ],
        ),
        tool(
          "find_email",
          "Find a lead's email",
          "Start an email search for a lead",
          "POST",
          `${P}/enrichment/enrich-email`,
        ),
        tool(
          "manage_webhooks",
          "Manage webhooks",
          "Create, change or delete webhooks",
          ["POST", "PATCH", "DELETE"],
          `${P}/webhooks/CreateWebhook`,
          [`${P}/webhooks/UpdateWebhook`, `${P}/webhooks/DeleteWebhook`],
        ),
        tool(
          "manage_sender_accounts",
          "Manage sender accounts",
          "Connect, reconnect or resync a LinkedIn sender account, sign it in again, and change its proxy or inbox sync",
          "POST",
          `${P}/li_account/Connect`,
          [
            `${P}/li_account/ConnectWithCookies`,
            `${P}/li_account/SubmitPin`,
            `${P}/li_account/Reconnect`,
            `${P}/li_account/ReloginSalesNavigator`,
            `${P}/li_account/ReloginRecruiter`,
            `${P}/li_account/Resync`,
            `${P}/li_account/UpdateProxy`,
            `${P}/li_account/UpdateInboxConfiguration`,
          ],
        ),
        tool(
          "remove_sender_account",
          "Remove sender account",
          "Remove a LinkedIn sender account from the workspace",
          "DELETE",
          `${P}/li_account/RemoveAccount/*/`,
        ),
        tool(
          "manage_workspaces",
          "Manage workspaces",
          "Create or change workspaces (Master API key only)",
          ["POST", "PATCH"],
          `${ORG}/workspaces`,
          [`${ORG}/workspaces/*/`],
        ),
        tool(
          "invite_users",
          "Invite users",
          "Invite admins, members or managers to the organization (Master API key only)",
          "POST",
          `${ORG}/users/invite/admins`,
          [`${ORG}/users/invite/members`, `${ORG}/users/invite/managers`],
        ),
        tool(
          "create_api_key",
          "Create a workspace API key",
          "Create a new API or integration key for a workspace, which deactivates its current one (Master API key only)",
          "POST",
          `${ORG}/api-keys/workspaces/*/`,
        ),
        tool(
          "manage_organization_accounts",
          "Move or delete sender accounts",
          "Move a sender account to another workspace, or delete it (Master API key only)",
          ["POST", "DELETE"],
          `${ORG}/linkedin-accounts/MoveToWorkspace`,
          [`${ORG}/linkedin-accounts/*/`],
        ),
      ],
    },
  ],
};
