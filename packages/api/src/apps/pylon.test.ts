import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePylonRegion, pylon } from "./pylon";
import { pylonPermissions } from "./app-permissions/pylon";
import { pathMatches } from "../lib/path-match";

const resolveMetadata =
  pylon.connectionMethod.type === "api_key"
    ? pylon.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("pylon must expose resolveMetadata");

const response = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const me = (name: string, email?: string) =>
  response(200, {
    data: {
      id: "org_1",
      name,
      user: { id: "u_1", ...(email ? { email } : {}) },
    },
    request_id: "req_1",
  });

describe("pylon connect form", () => {
  const fields =
    pylon.connectionMethod.type === "api_key"
      ? pylon.connectionMethod.fields
      : [];
  const [tokenField, regionField] = fields;

  // The token is fields[0]: the connect handler stores that as the access
  // token. The help link lands where tokens are CREATED (Settings → API
  // Tokens, the page Pylon's docs point at), not the API reference, which is
  // apiDocsUrl's job. Only Admins can create one, so the hint says so.
  it("puts the token first and sends users to Settings → API Tokens", () => {
    expect(tokenField?.name).toBe("apiKey");
    expect(tokenField?.secret).toBe(true);
    expect(tokenField?.helpUrl).toBe(
      "https://app.usepylon.com/settings/api-tokens",
    );
    expect(tokenField?.helpUrl).not.toBe(pylon.apiDocsUrl);
    expect(tokenField?.description).toMatch(/Admin/);
    // Rendered on one line with the help label, so it must end a sentence.
    expect(tokenField?.description).toMatch(/\.$/);
  });

  // The region is the credential field the gateway's host rewrite reads, so
  // its name is a contract with the gateway. Required and visible: a token
  // only works in its own region and Pylon cannot say which from the token.
  it("requires a visible, non-secret region field named for the gateway", () => {
    expect(regionField?.name).toBe("region");
    expect(regionField?.optional).toBeUndefined();
    expect(regionField?.secret).toBe(false);
  });
});

describe("normalizePylonRegion", () => {
  it.each([
    ["us", "us"],
    ["US", "us"],
    [" eu \n", "eu"],
  ])("%j → %j", (raw, expected) => {
    expect(normalizePylonRegion(raw)).toBe(expected);
  });

  it.each(["", "   ", "apac", "eu1", "api.eu.usepylon.com", "europe"])(
    "rejects %j (not a Pylon region)",
    (raw) => {
      expect(normalizePylonRegion(raw)).toBeNull();
    },
  );
});

describe("pylon resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  // GET /me is the API's "who am I" (docs.usepylon.com, Authentication). The
  // token goes as a standard Bearer, and the probe is bounded: connect awaits
  // it. The region is matched case- and whitespace-insensitively.
  it("probes /me on the US host with the trimmed token as a Bearer, bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(me("Acme"));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " tok \n", region: " US " });
    expect(fetchMock).toHaveBeenCalledWith("https://api.usepylon.com/me", {
      headers: { Authorization: "Bearer tok" },
      signal: expect.any(AbortSignal),
    });
  });

  // A token only works in its own region, so the probe must go where the
  // user said the tenant lives, never to the default host.
  it("probes the EU host for an EU tenant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(me("Acme"));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: "tok", region: " EU " });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eu.usepylon.com/me",
      expect.anything(),
    );
  });

  // The gateway falls back to the US host for a region it does not know, so
  // storing one would silently route an EU tenant's calls to the wrong
  // region. Refuse before any network call. (A blank region is caught
  // earlier by the connect route's required-field check; this is the
  // defense for a value that is present but not a region.)
  it.each(["apac", ""])(
    "hard-fails region %j without calling Pylon",
    async (region) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(resolveMetadata({ apiKey: "tok", region })).rejects.toThrow(
        /Region must be "us" or "eu"/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("labels the connection with the organization and tags its region", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(me("Acme Support")));
    await expect(
      resolveMetadata({ apiKey: "tok", region: "eu" }),
    ).resolves.toEqual({
      name: "Acme Support",
      username: "Acme Support",
      tags: ["EU"],
    });
  });

  // API tokens have no login email (Pylon's /me schema says so), so email is
  // present only for a human-backed token.
  it("records the user's email when /me carries one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(me("Acme", "ops@example.com")),
    );
    await expect(
      resolveMetadata({ apiKey: "tok", region: "us" }),
    ).resolves.toEqual({
      name: "Acme",
      username: "Acme",
      email: "ops@example.com",
      tags: ["US"],
    });
  });

  // The user's optional connection label is applied by the connect route
  // (it wins over any name returned here), so resolveMetadata never reads
  // it: the organization name is what Pylon says, verbatim.
  it("ignores a submitted label field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(me("Acme")));
    await expect(
      resolveMetadata({ apiKey: "tok", region: "us", label: " eu-tenant " }),
    ).resolves.toEqual({
      name: "Acme",
      username: "Acme",
      tags: ["US"],
    });
  });

  // Pylon's errors page: branch on the stable `code`, never on the message
  // text (reworded freely, sometimes localized). wrong_region_token is the
  // one 401 the user can fix by flipping the region, so it gets its own hint.
  it("hard-fails on 401 wrong_region_token, naming the other region", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(401, {
          errors: ["Token belongs to another region"],
          request_id: "req_1",
          code: "wrong_region_token",
        }),
      ),
    );
    await expect(
      resolveMetadata({ apiKey: "tok", region: "us" }),
    ).rejects.toThrow(/other region.*"eu"/);
  });

  it.each([
    ["invalid_api_token", { code: "invalid_api_token", errors: ["bad"] }],
    ["no code", { errors: ["Unauthorized"] }],
    ["unreadable body", undefined],
  ])(
    "hard-fails on any other 401 (%s): Pylon rejected the token",
    async (_, body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          body === undefined
            ? {
                status: 401,
                ok: false,
                json: async () => {
                  throw new Error("not json");
                },
              }
            : response(401, body),
        ),
      );
      await expect(
        resolveMetadata({ apiKey: "bad", region: "us" }),
      ).rejects.toThrow(/Pylon rejected this API token/);
    },
  );

  // 403 is a VALID token lacking a permission; 429 and 5xx say nothing about
  // the token. None may reject a connection that would work.
  it.each([403, 429, 500])(
    "accepts the token on %s, named by region only",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
      await expect(
        resolveMetadata({ apiKey: "tok", region: "eu" }),
      ).resolves.toEqual({ name: "API Key", tags: ["EU"] });
    },
  );

  it("accepts the token when the identity body is unreadable or empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("not json");
        },
      }),
    );
    await expect(
      resolveMetadata({ apiKey: "tok", region: "us" }),
    ).resolves.toEqual({ name: "API Key", tags: ["US"] });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(200, {})));
    await expect(
      resolveMetadata({ apiKey: "tok", region: "us" }),
    ).resolves.toEqual({ name: "API Key", tags: ["US"] });
  });

  it("never hard-fails when Pylon is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      resolveMetadata({ apiKey: "tok", region: "us" }),
    ).resolves.toEqual({ name: "API Key", tags: ["US"] });
  });
});

// Which tools a request falls under. Pins the fences that matter: item
// routes share /issues/{id} with messages, followers, snooze and the rest,
// so "Get issue" must never grant the message history and "Delete issue"
// must never answer the followers route. Pylon's POST /…/search endpoints
// are reads, so a write tool must never swallow one. A tool with no
// method(s) answers any method.
const toolsFor = (method: string, path: string) =>
  pylonPermissions.groups
    .flatMap((g) => g.tools)
    .filter((t) => {
      const methods = t.methods ?? (t.method ? [t.method] : null);
      const patterns = [t.pathPattern, ...(t.aliasPatterns ?? [])];
      return (
        (methods === null || methods.includes(method)) &&
        patterns.some((p) => pathMatches(path, p))
      );
    })
    .map((t) => t.id);

describe("pylon permission catalog", () => {
  // Every tool answers on both regional hosts, so a connection routed to the
  // EU region is governed by the same rules as a US one.
  it("declares both regional hosts on every tool", () => {
    for (const tool of pylonPermissions.groups.flatMap((g) => g.tools)) {
      expect(tool.hostPattern, tool.id).toBe("api.usepylon.com");
      expect(tool.hostAliasPatterns, tool.id).toEqual(["api.eu.usepylon.com"]);
    }
  });

  // Every operation in the API reference's embedded OpenAPI, one row each,
  // grouped by its reference page. Exactly one tool per operation.
  it.each([
    // accounts
    ["GET", "/accounts", ["list_accounts"]],
    ["POST", "/accounts", ["create_account"]],
    ["PATCH", "/accounts", ["update_accounts"]],
    ["GET", "/accounts/a1", ["get_account"]],
    ["PATCH", "/accounts/a1", ["update_account"]],
    ["DELETE", "/accounts/a1", ["delete_account"]],
    ["POST", "/accounts/search", ["search_accounts"]],
    ["POST", "/accounts/merge", ["merge_accounts"]],
    ["GET", "/accounts/a1/relationships", ["get_account_relationships"]],
    ["POST", "/accounts/a1/relationship", ["manage_account_relationships"]],
    [
      "DELETE",
      "/accounts/a1/relationships/a1",
      ["manage_account_relationships"],
    ],
    [
      "POST",
      "/accounts/a1/notebook-blocks/a1/notes",
      ["create_account_notebook_note"],
    ],
    [
      "GET",
      "/accounts/a1/notebook-blocks/a1/notes",
      ["get_account_notebook_notes"],
    ],
    // accounts/activities
    ["POST", "/accounts/a1/activities", ["create_account_activity"]],
    ["GET", "/activity-types", ["list_activity_types"]],
    ["GET", "/accounts/a1/activities", ["get_account_activities"]],
    // attachments
    ["POST", "/attachments", ["create_attachment"]],
    // audit-logs
    ["GET", "/audit-logs", ["list_audit_logs"]],
    ["POST", "/audit-logs/search", ["search_audit_logs"]],
    // call-recordings
    ["GET", "/call-recordings/a1", ["get_call_recording"]],
    ["PATCH", "/call-recordings/a1", ["update_call_recording"]],
    ["POST", "/call-recordings/search", ["search_call_recordings"]],
    ["DELETE", "/call-recordings/a1", ["delete_call_recording"]],
    // contacts
    ["GET", "/contacts", ["list_contacts"]],
    ["POST", "/contacts", ["create_contact"]],
    ["GET", "/contacts/a1", ["get_contact"]],
    ["PATCH", "/contacts/a1", ["update_contact"]],
    ["DELETE", "/contacts/a1", ["delete_contact"]],
    ["POST", "/contacts/search", ["search_contacts"]],
    // custom-fields
    ["GET", "/custom-fields", ["list_custom_fields"]],
    ["GET", "/custom-fields/a1", ["get_custom_field"]],
    ["POST", "/custom-fields", ["manage_custom_fields"]],
    ["PATCH", "/custom-fields/a1", ["manage_custom_fields"]],
    ["POST", "/custom-fields/a1/select-options", ["manage_custom_fields"]],
    ["PATCH", "/custom-fields/a1/select-options", ["manage_custom_fields"]],
    ["DELETE", "/custom-fields/a1/select-options", ["manage_custom_fields"]],
    // custom-objects
    ["GET", "/custom-objects/deal", ["list_custom_objects"]],
    ["GET", "/custom-objects/deal/a1", ["get_custom_object"]],
    ["POST", "/custom-objects/deal/search", ["search_custom_objects"]],
    ["POST", "/custom-objects/deal", ["create_custom_object"]],
    ["PATCH", "/custom-objects/deal/a1", ["update_custom_objects"]],
    ["PATCH", "/custom-objects/deal", ["update_custom_objects"]],
    ["DELETE", "/custom-objects/deal/a1", ["delete_custom_object"]],
    // email
    ["GET", "/email-suppressions", ["list_email_suppressions"]],
    ["DELETE", "/email-suppressions/a1", ["delete_email_suppression"]],
    // feature-requests
    ["POST", "/feature-requests/search", ["search_feature_requests"]],
    ["PATCH", "/feature-requests/a1", ["update_feature_request"]],
    [
      "POST",
      "/feature-requests/a1/evidence",
      ["link_feature_request_evidence"],
    ],
    ["DELETE", "/feature-requests/a1", ["delete_feature_request"]],
    ["GET", "/feature-requests/a1", ["get_feature_request"]],
    ["POST", "/feature-requests", ["create_feature_request"]],
    [
      "POST",
      "/feature-requests/a1/set-portal-visibility",
      ["set_feature_request_portal_visibility"],
    ],
    ["POST", "/feature-requests/merge", ["merge_feature_requests"]],
    // issues
    ["GET", "/issues", ["list_issues"]],
    ["POST", "/issues", ["create_issue"]],
    ["POST", "/issue-groups", ["manage_issue_groups"]],
    ["POST", "/issue-groups/a1/children", ["manage_issue_groups"]],
    ["DELETE", "/issue-groups/a1/children/a1", ["manage_issue_groups"]],
    ["POST", "/issues/a1/ai-response", ["create_issue_ai_response"]],
    ["GET", "/issue-statuses", ["list_issue_statuses"]],
    ["GET", "/issues/a1/voice-calls", ["get_issue_voice_calls"]],
    ["GET", "/issues/a1", ["get_issue"]],
    ["PATCH", "/issues/a1", ["update_issue"]],
    ["DELETE", "/issues/a1", ["delete_issue"]],
    ["POST", "/issues/search", ["search_issues"]],
    ["POST", "/issues/a1/snooze", ["snooze_issue"]],
    ["GET", "/issues/a1/followers", ["get_issue_followers"]],
    ["POST", "/issues/a1/followers", ["manage_issue_followers"]],
    ["POST", "/issues/a1/external-issues", ["link_external_issue"]],
    // knowledge-base
    ["GET", "/knowledge-bases", ["list_knowledge_bases"]],
    ["GET", "/knowledge-bases/a1", ["get_knowledge_base"]],
    ["GET", "/article-feedback", ["list_article_feedback"]],
    ["GET", "/knowledge-bases/a1/themes/a1", ["get_knowledge_base_theme"]],
    ["PATCH", "/knowledge-bases/a1/themes/a1", ["manage_knowledge_base_theme"]],
    [
      "POST",
      "/knowledge-bases/a1/themes/a1/publish",
      ["manage_knowledge_base_theme"],
    ],
    ["GET", "/knowledge-bases/a1/collections/a1", ["get_collection"]],
    ["GET", "/knowledge-bases/a1/collections", ["list_collections"]],
    ["POST", "/knowledge-bases/a1/collections", ["create_collection"]],
    ["PATCH", "/knowledge-bases/a1/collections/a1", ["update_collection"]],
    ["DELETE", "/knowledge-bases/a1/collections/a1", ["delete_collection"]],
    ["GET", "/knowledge-bases/a1/articles", ["list_articles"]],
    ["POST", "/knowledge-bases/a1/articles", ["create_article"]],
    ["GET", "/knowledge-bases/a1/articles/a1", ["get_article"]],
    ["PATCH", "/knowledge-bases/a1/articles/a1", ["update_article"]],
    ["DELETE", "/knowledge-bases/a1/articles/a1", ["delete_article"]],
    ["POST", "/knowledge-bases/a1/route-redirects", ["create_route_redirect"]],
    [
      "POST",
      "/knowledge-bases/a1/articles/a1/request-review",
      ["request_article_review"],
    ],
    // macros
    ["GET", "/macros/a1", ["get_macro"]],
    ["GET", "/macros", ["list_macros"]],
    ["DELETE", "/macros/a1", ["manage_macros"]],
    ["GET", "/macro-groups", ["list_macro_groups"]],
    ["PATCH", "/macros/a1", ["manage_macros"]],
    ["POST", "/macros", ["manage_macros"]],
    // me
    ["GET", "/me", ["get_me"]],
    // messages
    ["GET", "/issues/a1/messages", ["get_issue_messages"]],
    ["GET", "/issues/a1/threads", ["get_issue_threads"]],
    ["POST", "/issues/a1/threads", ["create_issue_thread"]],
    ["POST", "/issues/a1/reply", ["reply_to_issue"]],
    ["POST", "/issues/a1/draft-reply", ["draft_issue_reply"]],
    ["POST", "/issues/a1/note", ["create_issue_note"]],
    ["POST", "/issues/a1/messages/a1/redact", ["redact_message"]],
    ["DELETE", "/issues/a1/messages/a1", ["delete_message"]],
    // surveys
    ["GET", "/surveys", ["list_surveys"]],
    ["GET", "/surveys/a1", ["get_survey"]],
    ["GET", "/surveys/a1/responses", ["get_survey_responses"]],
    ["POST", "/surveys/search", ["search_surveys"]],
    // tags
    ["GET", "/tags", ["list_tags"]],
    ["GET", "/tags/a1", ["get_tag"]],
    ["POST", "/tags", ["manage_tags"]],
    ["PATCH", "/tags/a1", ["manage_tags"]],
    ["DELETE", "/tags/a1", ["manage_tags"]],
    // tasks-and-projects
    ["GET", "/tasks", ["list_tasks"]],
    ["GET", "/tasks/a1", ["get_task"]],
    ["GET", "/tasks/a1/comments", ["get_task_comments"]],
    ["POST", "/tasks/a1/comments", ["manage_task_comments"]],
    ["PATCH", "/tasks/a1/comments/a1", ["manage_task_comments"]],
    ["DELETE", "/tasks/a1/comments/a1", ["manage_task_comments"]],
    ["POST", "/tasks/search", ["search_tasks"]],
    ["POST", "/tasks", ["create_task"]],
    ["PATCH", "/tasks/a1", ["update_task"]],
    ["DELETE", "/tasks/a1", ["delete_task"]],
    ["POST", "/tasks/a1/external-issues", ["link_task_issue"]],
    ["POST", "/tasks/a1/issues", ["link_task_issue"]],
    ["GET", "/projects/a1", ["get_project"]],
    ["POST", "/projects/search", ["search_projects"]],
    ["PATCH", "/projects/a1", ["update_project"]],
    ["DELETE", "/projects/a1", ["delete_project"]],
    ["POST", "/projects", ["create_project"]],
    ["GET", "/milestones/a1", ["get_milestone"]],
    ["PATCH", "/milestones/a1", ["update_milestone"]],
    ["POST", "/milestones", ["create_milestone"]],
    ["DELETE", "/milestones/a1", ["delete_milestone"]],
    ["POST", "/milestones/search", ["search_milestones"]],
    // teams
    ["GET", "/teams", ["list_teams"]],
    ["GET", "/teams/a1", ["get_team"]],
    ["PATCH", "/teams/a1", ["update_team"]],
    ["POST", "/teams", ["create_team"]],
    // ticket-forms
    ["GET", "/ticket-forms", ["list_ticket_forms"]],
    ["GET", "/ticket-forms/a1", ["get_ticket_form"]],
    ["POST", "/ticket-forms/a1/submissions", ["submit_ticket_form"]],
    // training-data
    ["GET", "/training-data", ["list_training_data"]],
    ["POST", "/training-data", ["manage_training_data"]],
    ["GET", "/training-data/a1", ["get_training_data"]],
    ["POST", "/training-data/upload", ["manage_training_data"]],
    ["POST", "/training-data/upload-content", ["manage_training_data"]],
    ["DELETE", "/training-data/a1/documents", ["manage_training_data"]],
    // user-roles
    ["GET", "/user-roles", ["list_user_roles"]],
    // users
    ["GET", "/users", ["list_users"]],
    ["GET", "/users/a1", ["get_user"]],
    ["PATCH", "/users/a1", ["update_user"]],
    ["POST", "/users/search", ["search_users"]],
  ])("%s %s → %j", (method, path, expected) => {
    expect(toolsFor(method, path)).toEqual(expected);
  });

  it("never lets an item tool reach a deeper route", () => {
    expect(toolsFor("GET", "/issues/a1/messages")).not.toContain("get_issue");
    expect(toolsFor("DELETE", "/issues/a1/followers")).toEqual([]);
    expect(toolsFor("PATCH", "/issues/a1/snooze")).toEqual([]);
    expect(toolsFor("GET", "/accounts/a1/relationships/r1")).toEqual([]);
    expect(
      toolsFor("GET", "/knowledge-bases/kb/articles/a1/request-review"),
    ).toEqual([]);
  });

  it("keeps the search reads out of every write tool", () => {
    for (const resource of [
      "issues",
      "accounts",
      "contacts",
      "users",
      "tasks",
      "projects",
      "milestones",
      "feature-requests",
      "call-recordings",
      "surveys",
      "audit-logs",
    ]) {
      const ids = toolsFor("POST", `/${resource}/search`);
      expect(ids, resource).toHaveLength(1);
      expect(ids[0], resource).toMatch(/^search_/);
    }
    expect(toolsFor("POST", "/custom-objects/deal/search")).toEqual([
      "search_custom_objects",
    ]);
  });

  it("covers no undocumented routes", () => {
    expect(toolsFor("GET", "/issues/a1/transcript")).toEqual([]);
    expect(toolsFor("GET", "/projects")).toEqual([]);
    expect(toolsFor("GET", "/milestones")).toEqual([]);
    expect(toolsFor("GET", "/feature-requests")).toEqual([]);
    expect(toolsFor("PUT", "/issues/a1")).toEqual([]);
    expect(toolsFor("POST", "/mcp")).toEqual([]);
    expect(toolsFor("GET", "/settings/api-tokens")).toEqual([]);
  });
});
