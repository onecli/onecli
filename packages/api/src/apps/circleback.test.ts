import { afterEach, describe, expect, it, vi } from "vitest";
import { circleback } from "./circleback";
import { circlebackPermissions } from "./app-permissions/circleback";
import { pathMatches } from "../lib/path-match";

const resolveMetadata =
  circleback.connectionMethod.type === "api_key"
    ? circleback.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("circleback must expose resolveMetadata");

const response = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

describe("circleback connect form", () => {
  const [apiKeyField] =
    circleback.connectionMethod.type === "api_key"
      ? circleback.connectionMethod.fields
      : [];

  // The help link is where keys are CREATED (the Settings → API keys deep
  // link Circleback publishes in its CLI docs), not the API reference, which
  // is apiDocsUrl's job. Keys carry a read or read-and-write scope, so the
  // hint has to say which to pick.
  it("sends users to Settings → API keys and names the scope choice", () => {
    expect(apiKeyField?.helpUrl).toBe(
      "https://circleback.ai/settings?tab=api-access",
    );
    expect(apiKeyField?.helpUrl).not.toBe(circleback.apiDocsUrl);
    expect(apiKeyField?.description).toMatch(/read-and-write/);
    // Rendered on one line with the help label, so it must end a sentence.
    expect(apiKeyField?.description).toMatch(/\.$/);
  });
});

describe("circleback resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  // GET /oauth/test is the API's "who am I" (circleback.ai/docs/api). The key
  // goes as a standard Bearer, and the probe is bounded: connect awaits it.
  it("probes the account with the trimmed key as a Bearer, bounded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(200, { email: "a@b.co" }));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " cb_tok \n" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://circleback.ai/api/oauth/test",
      {
        headers: { Authorization: "Bearer cb_tok" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("labels the connection with the account email", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response(200, { email: "jane@example.com", apiKeyName: "OneCLI" }),
        ),
    );
    await expect(resolveMetadata({ apiKey: "cb_k" })).resolves.toEqual({
      username: "jane@example.com",
      email: "jane@example.com",
    });
  });

  it("hard-fails on 401: Circleback rejected the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await expect(resolveMetadata({ apiKey: "bad" })).rejects.toThrow(
      /Circleback rejected this API key/,
    );
  });

  it.each([403, 429, 500])(
    "accepts the key on %s, unlabelled",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
      await expect(resolveMetadata({ apiKey: "cb_k" })).resolves.toBeNull();
    },
  );

  it("accepts the key when the identity body is unreadable", async () => {
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
    await expect(resolveMetadata({ apiKey: "cb_k" })).resolves.toBeNull();
  });

  it("never hard-fails when Circleback is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveMetadata({ apiKey: "cb_k" })).resolves.toBeNull();
  });
});

// Which tools a request falls under. Pins the fences that matter: the meeting
// item routes share /api/meeting/{id} with the transcript and share routes,
// so "Get meeting" must never grant a transcript and "Delete meeting" must
// never answer the share route. A tool with no method(s) answers any method.
const toolsFor = (method: string, path: string) =>
  circlebackPermissions.groups
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

describe("circleback permission catalog", () => {
  // Every path in circleback.ai/docs/api/openapi.json, one row each.
  it.each([
    ["GET", "/api/meetings", ["list_meetings"]],
    ["GET", "/api/meetings?statuses=COMPLETED&cursor=abc", ["list_meetings"]],
    ["POST", "/api/meetings", ["import_meeting"]],
    ["GET", "/api/search?query=pricing", ["search_meetings"]],
    ["GET", "/api/meeting/m1", ["get_meeting"]],
    ["PUT", "/api/meeting/m1", ["update_meeting"]],
    ["DELETE", "/api/meeting/m1", ["delete_meeting"]],
    ["GET", "/api/meeting/m1/transcript", ["get_transcript"]],
    ["PUT", "/api/meeting/m1/share", ["share_meeting"]],
    ["GET", "/api/action-items?status=PENDING", ["list_action_items"]],
    ["POST", "/api/action-items", ["create_action_item"]],
    ["PUT", "/api/action-item/a1", ["update_action_item"]],
    ["DELETE", "/api/action-item/a1", ["delete_action_item"]],
    ["GET", "/api/calendar/events", ["list_calendar_events"]],
    [
      "PUT",
      "/api/calendar/events/c1/meeting",
      ["update_calendar_event_meeting"],
    ],
    ["GET", "/api/people?domains=onecli.sh", ["list_people"]],
    ["GET", "/api/person/p1", ["get_person"]],
    ["GET", "/api/companies", ["list_companies"]],
    ["GET", "/api/company/onecli.sh", ["get_company"]],
    ["GET", "/api/tag", ["list_tags"]],
    ["POST", "/api/tag", ["manage_tags"]],
    ["PUT", "/api/tag", ["manage_tags"]],
    ["DELETE", "/api/tag", ["manage_tags"]],
    ["PUT", "/api/tag/t1", ["manage_tags"]],
    ["DELETE", "/api/tag/t1", ["manage_tags"]],
    ["GET", "/api/oauth/test", ["get_account"]],
  ])("%s %s → %j", (method, path, expected) => {
    expect(toolsFor(method, path)).toEqual(expected);
  });

  it("never lets an item tool reach a deeper route", () => {
    // A transcript is not "Get meeting", sharing is not "Update meeting".
    expect(toolsFor("GET", "/api/meeting/m1/transcript")).not.toContain(
      "get_meeting",
    );
    expect(toolsFor("PUT", "/api/meeting/m1/share")).not.toContain(
      "update_meeting",
    );
    expect(toolsFor("DELETE", "/api/meeting/m1/share")).toEqual([]);
  });

  it("covers no undocumented routes", () => {
    expect(toolsFor("GET", "/api/meeting/m1/recording")).toEqual([]);
    expect(toolsFor("GET", "/api/tag/t1")).toEqual([]);
    expect(toolsFor("POST", "/api/mcp")).toEqual([]);
    expect(toolsFor("GET", "/settings")).toEqual([]);
  });
});
