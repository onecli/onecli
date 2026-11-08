import { afterEach, describe, expect, it, vi } from "vitest";
import { heyreach } from "./heyreach";
import { heyreachPermissions } from "./app-permissions/heyreach";
import { methodsOf } from "./app-permissions/types";
import { hostMatches, pathMatches } from "../lib/path-match";

const resolveMetadata =
  heyreach.connectionMethod.type === "api_key"
    ? heyreach.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("heyreach must expose resolveMetadata");

const response = (status: number) => ({ status });

describe("heyreach resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("checks the trimmed key with CheckApiKey as X-API-KEY, bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " hr_tok \n" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.heyreach.io/api/public/auth/CheckApiKey",
      {
        headers: { "X-API-KEY": "hr_tok" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("hard-fails on 401: a wrong or replaced key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await expect(resolveMetadata({ apiKey: "nope" })).rejects.toThrow(
      /HeyReach rejected this API key/,
    );
  });

  it.each([200, 429, 500])(
    "accepts the key on %s (the check has no identity to label it with)",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
      await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
    },
  );

  it("never hard-fails when HeyReach is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });
});

const HOST = "api.heyreach.io";
const P = "/api/public";
const ORG = `${P}/management/organizations`;

const toolsFor = (method: string, path: string) =>
  heyreachPermissions.groups
    .flatMap((g) => g.tools)
    .filter(
      (t) =>
        methodsOf(t).includes(method) &&
        hostMatches(HOST, t.hostPattern) &&
        [t.pathPattern, ...(t.aliasPatterns ?? [])].some((p) =>
          pathMatches(path, p),
        ),
    )
    .map((t) => t.id);

const categoryOf = (id: string) =>
  heyreachPermissions.groups.find((g) => g.tools.some((t) => t.id === id))
    ?.category;

// Every operation of the published Postman collection, with its documented
// method, and the one tool it lands on. A path parameter is filled with a
// sample id.
const DOCUMENTED: [string, string, string, "read" | "write"][] = [
  ["GET", `${P}/auth/CheckApiKey`, "check_api_key", "read"],
  ["POST", `${P}/campaign/GetAll`, "list_campaigns", "read"],
  ["POST", `${P}/campaign/GetCampaignsForLead`, "list_campaigns", "read"],
  ["GET", `${P}/campaign/GetById?campaignId=1`, "get_campaign", "read"],
  [
    "GET",
    `${P}/campaign/GetCampaignSequence?campaignId=1`,
    "get_campaign",
    "read",
  ],
  ["POST", `${P}/campaign/GetLeadsFromCampaign`, "list_campaign_leads", "read"],
  ["POST", `${P}/list/GetAll`, "list_lead_lists", "read"],
  ["POST", `${P}/list/GetListsForLead`, "list_lead_lists", "read"],
  ["GET", `${P}/list/GetById?listId=1`, "get_lead_list", "read"],
  ["POST", `${P}/list/GetLeadsFromList`, "list_list_leads", "read"],
  ["POST", `${P}/list/GetCompaniesFromList`, "list_list_leads", "read"],
  ["POST", `${P}/lead/GetLead`, "get_lead", "read"],
  ["POST", `${P}/lead/GetTags`, "get_lead", "read"],
  ["POST", `${P}/inbox/GetConversationsV2`, "read_inbox", "read"],
  ["POST", `${P}/inbox/GetConversationsV3`, "read_inbox", "read"],
  ["GET", `${P}/inbox/GetChatroom/1/2-ODM0YmIz`, "read_conversation", "read"],
  ["POST", `${P}/li_account/GetAll`, "list_sender_accounts", "read"],
  ["GET", `${P}/li_account/GetById?accountId=1`, "get_sender_account", "read"],
  ["GET", `${P}/li_account/GetAccountStatus/1`, "get_sender_account", "read"],
  ["GET", `${P}/li_account/GetProxyCountries`, "get_sender_account", "read"],
  ["POST", `${P}/stats/GetOverallStats`, "get_stats", "read"],
  ["POST", `${P}/stats/GetOverallStatsByCampaign`, "get_stats", "read"],
  ["POST", `${P}/MyNetwork/GetMyNetworkForSender`, "read_network", "read"],
  ["POST", `${P}/MyNetwork/IsConnection`, "read_network", "read"],
  ["POST", `${P}/blacklist/GetLeads`, "read_blacklist", "read"],
  ["POST", `${P}/blacklist/GetCompanies`, "read_blacklist", "read"],
  [
    "GET",
    `${P}/enrichment/enrich-email/check-job/48213`,
    "get_email_search",
    "read",
  ],
  ["GET", `${ORG}/workspaces?Offset=0&Limit=10`, "read_organization", "read"],
  ["GET", `${ORG}/users/1`, "read_organization", "read"],
  ["POST", `${ORG}/users`, "list_organization_members", "read"],
  ["POST", `${ORG}/users/workspaces/1`, "list_organization_members", "read"],
  ["POST", `${ORG}/linkedin-accounts`, "list_organization_members", "read"],
  ["POST", `${P}/inbox/SendMessage`, "send_message", "write"],
  ["POST", `${P}/inbox/SetSeenStatus`, "mark_conversation_seen", "write"],
  [
    "POST",
    `${P}/campaign/AddLeadsToCampaignV2`,
    "add_leads_to_campaign",
    "write",
  ],
  [
    "POST",
    `${P}/campaign/AddLeadsToCampaign`,
    "add_leads_to_campaign",
    "write",
  ],
  [
    "POST",
    `${P}/campaign/StopLeadInCampaign`,
    "stop_lead_in_campaign",
    "write",
  ],
  [
    "POST",
    `${P}/campaign/StartCampaign?campaignId=1`,
    "start_campaign",
    "write",
  ],
  ["POST", `${P}/campaign/Pause?campaignId=1`, "pause_campaign", "write"],
  ["POST", `${P}/campaign/Resume?campaignId=1`, "resume_campaign", "write"],
  ["POST", `${P}/campaign/Create`, "create_campaign", "write"],
  [
    "POST",
    `${P}/campaign/CreateCampaignFromTemplate`,
    "create_campaign",
    "write",
  ],
  ["POST", `${P}/campaign/UpdateSettings`, "edit_campaign", "write"],
  ["POST", `${P}/campaign/UpdateSchedule`, "edit_campaign", "write"],
  ["POST", `${P}/campaign/UpdateAccounts`, "edit_campaign", "write"],
  [
    "POST",
    `${P}/campaign/AddLinkedInAccountsToCampaign`,
    "edit_campaign",
    "write",
  ],
  [
    "POST",
    `${P}/campaign/RemoveLinkedInAccountsFromCampaign`,
    "edit_campaign",
    "write",
  ],
  ["POST", `${P}/campaign/UpdateSequence`, "edit_campaign_sequence", "write"],
  [
    "PATCH",
    `${P}/campaign/UpdateLeadCustomFields/campaigns/1/leads/custom-fields`,
    "update_lead_fields",
    "write",
  ],
  [
    "PATCH",
    `${P}/list/UpdateLeadCustomFields/lists/1/leads/custom-fields`,
    "update_lead_fields",
    "write",
  ],
  ["POST", `${P}/list/CreateEmptyList`, "create_list", "write"],
  ["POST", `${P}/list/AddLeadsToListV2`, "add_leads_to_list", "write"],
  ["POST", `${P}/list/AddLeadsToList`, "add_leads_to_list", "write"],
  [
    "DELETE",
    `${P}/list/DeleteLeadsFromList`,
    "remove_leads_from_list",
    "write",
  ],
  [
    "DELETE",
    `${P}/list/DeleteLeadsFromListByProfileUrl`,
    "remove_leads_from_list",
    "write",
  ],
  ["POST", `${P}/lead/AddTags`, "tag_lead", "write"],
  ["POST", `${P}/lead/ReplaceTags`, "tag_lead", "write"],
  ["POST", `${P}/lead_tags/CreateTags`, "create_tags", "write"],
  ["POST", `${P}/blacklist/AddLeads`, "edit_blacklist", "write"],
  ["POST", `${P}/blacklist/RemoveLeads`, "edit_blacklist", "write"],
  ["POST", `${P}/blacklist/AddCompanies`, "edit_blacklist", "write"],
  ["POST", `${P}/blacklist/RemoveCompanies`, "edit_blacklist", "write"],
  ["POST", `${P}/enrichment/enrich-email`, "find_email", "write"],
  ["POST", `${P}/webhooks/CreateWebhook`, "manage_webhooks", "write"],
  [
    "PATCH",
    `${P}/webhooks/UpdateWebhook?webhookId=1`,
    "manage_webhooks",
    "write",
  ],
  [
    "DELETE",
    `${P}/webhooks/DeleteWebhook?webhookId=1`,
    "manage_webhooks",
    "write",
  ],
  ["POST", `${P}/li_account/Connect`, "manage_sender_accounts", "write"],
  [
    "POST",
    `${P}/li_account/ConnectWithCookies`,
    "manage_sender_accounts",
    "write",
  ],
  ["POST", `${P}/li_account/SubmitPin`, "manage_sender_accounts", "write"],
  ["POST", `${P}/li_account/Reconnect`, "manage_sender_accounts", "write"],
  [
    "POST",
    `${P}/li_account/ReloginSalesNavigator`,
    "manage_sender_accounts",
    "write",
  ],
  [
    "POST",
    `${P}/li_account/ReloginRecruiter`,
    "manage_sender_accounts",
    "write",
  ],
  ["POST", `${P}/li_account/Resync`, "manage_sender_accounts", "write"],
  ["POST", `${P}/li_account/UpdateProxy`, "manage_sender_accounts", "write"],
  [
    "POST",
    `${P}/li_account/UpdateInboxConfiguration`,
    "manage_sender_accounts",
    "write",
  ],
  [
    "DELETE",
    `${P}/li_account/RemoveAccount/1?force=true`,
    "remove_sender_account",
    "write",
  ],
  ["POST", `${ORG}/workspaces`, "manage_workspaces", "write"],
  ["PATCH", `${ORG}/workspaces/1`, "manage_workspaces", "write"],
  ["POST", `${ORG}/users/invite/admins`, "invite_users", "write"],
  ["POST", `${ORG}/users/invite/members`, "invite_users", "write"],
  ["POST", `${ORG}/users/invite/managers`, "invite_users", "write"],
  ["POST", `${ORG}/api-keys/workspaces/1`, "create_api_key", "write"],
  [
    "POST",
    `${ORG}/linkedin-accounts/MoveToWorkspace`,
    "manage_organization_accounts",
    "write",
  ],
  [
    "DELETE",
    `${ORG}/linkedin-accounts/1?forceDelete=true`,
    "manage_organization_accounts",
    "write",
  ],
];

describe("heyreach permission catalog", () => {
  it.each(DOCUMENTED)("%s %s → %s (%s)", (method, path, id, category) => {
    expect(toolsFor(method, path)).toEqual([id]);
    expect(categoryOf(id)).toBe(category);
  });

  // The documented GETs that answer a secret are no read tool, so a default
  // grant holds them (pinned in catalog-unlisted-reads.test.ts). GetAllWebhooks
  // takes the same custom-headers flag in its POST body.
  it.each([
    ["GET", `${P}/li_account/GetAccountProxy/1`],
    ["GET", `${ORG}/api-keys/workspaces/1`],
    ["GET", `${P}/webhooks/GetWebhookById?webhookId=1`],
    ["POST", `${P}/webhooks/GetAllWebhooks`],
  ])("%s %s is held, never a read tool", (method, path) => {
    expect(toolsFor(method, path)).toEqual([]);
  });

  it("names nothing outside the documented routes and methods", () => {
    // The undocumented spelling the published collection never uses.
    expect(toolsFor("POST", `${P}/linkedinaccount/GetAll`)).toEqual([]);
    // A documented GET reached with another verb.
    expect(toolsFor("POST", `${P}/campaign/GetById`)).toEqual([]);
    // An item route one segment deeper than documented.
    expect(toolsFor("GET", `${P}/li_account/GetAccountStatus/1/x`)).toEqual([]);
    expect(toolsFor("POST", `${P}/unknown/Thing`)).toEqual([]);
  });

  it("has no catch-all wildcard: a read grant can never cover a write", () => {
    for (const group of heyreachPermissions.groups) {
      expect(group.wildcard, group.category).toBeUndefined();
    }
  });

  it("keeps every tool on api.heyreach.io under /api/public", () => {
    for (const t of heyreachPermissions.groups.flatMap((g) => g.tools)) {
      expect(t.hostPattern).toBe(HOST);
      for (const p of [t.pathPattern, ...(t.aliasPatterns ?? [])]) {
        expect(p.startsWith(`${P}/`), `${t.id} ${p}`).toBe(true);
      }
    }
  });
});
