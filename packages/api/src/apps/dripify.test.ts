import { afterEach, describe, expect, it, vi } from "vitest";
import { dripify } from "./dripify";
import { dripifyPermissions } from "./app-permissions/dripify";
import { hostPatternsOf, methodsOf } from "./app-permissions/types";
import { hostMatches, pathMatches } from "../lib/path-match";

const resolveMetadata =
  dripify.connectionMethod.type === "api_key"
    ? dripify.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("dripify must expose resolveMetadata");

const response = (status: number) => ({ status });

describe("dripify resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The cheapest authenticated read validates the key, sent as X-Api-Key
  // (api.dripify.com, ApiKeyAuth). Bounded: the connect request awaits it.
  it("probes one team with the trimmed key as X-Api-Key, bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " key \n" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dripify.com/v1/open-api/teams?limit=1",
      {
        headers: { "X-Api-Key": "key" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("hard-fails on 401: a bad or revoked key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await expect(resolveMetadata({ apiKey: "bad" })).rejects.toThrow(
      /Dripify rejected this API key/,
    );
  });

  it("hard-fails on 403: the plan has no Open API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(403)));
    await expect(resolveMetadata({ apiKey: "k" })).rejects.toThrow(
      /plan doesn't include the Open API/,
    );
  });

  it.each([200, 404, 429, 500])(
    "accepts the key on %s (no identity to label it with)",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
      await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
    },
  );

  it("never hard-fails when Dripify is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });
});

// Which tools a request falls under. Pins the fences that matter: "Get lead"
// never reaches sending a message, the POST lead lookup is a read, adding
// leads to a campaign is a write, and the MCP server is reached only by its
// own tool, on its own path of the web app's host.
const toolsFor = (method: string, host: string, path: string) =>
  dripifyPermissions.groups
    .flatMap((g) => g.tools)
    .filter((t) => {
      const methods = methodsOf(t);
      return (
        (methods.length === 0 || methods.includes(method)) &&
        hostPatternsOf(t).some((h) => hostMatches(host, h)) &&
        [t.pathPattern, ...(t.aliasPatterns ?? [])].some((p) =>
          pathMatches(path, p),
        )
      );
    })
    .map((t) => t.id);

describe("dripify permission catalog", () => {
  const API = "api.dripify.com";
  const P = "/v1/open-api";

  // Every operation in Dripify's published OpenAPI, one row each.
  it.each([
    ["GET", `${P}/campaigns`, ["list_campaigns"]],
    ["GET", `${P}/campaigns/c1/lead-lists`, ["list_campaigns"]],
    ["GET", `${P}/campaigns/c1/statistics`, ["list_campaigns"]],
    ["POST", `${P}/campaigns/c1/leads`, ["add_leads_to_campaign"]],
    ["POST", `${P}/lead-lists/ll1/leads`, ["add_leads_to_campaign"]],
    ["GET", `${P}/leads?status=PROCESSING_ENDED`, ["list_leads"]],
    ["POST", `${P}/leads/search`, ["search_leads"]],
    ["PUT", `${P}/leads/tags`, ["tag_leads"]],
    ["DELETE", `${P}/leads/tags`, ["tag_leads"]],
    ["GET", `${P}/leads/l1`, ["get_lead"]],
    ["GET", `${P}/leads/l1/activity`, ["get_lead"]],
    ["GET", `${P}/leads/l1/conversation`, ["read_conversations"]],
    ["GET", `${P}/conversations/v1/messages`, ["read_conversations"]],
    ["POST", `${P}/leads/l1/messages`, ["send_message"]],
    ["GET", `${P}/custom-lead-fields`, ["list_fields_and_tags"]],
    ["PUT", `${P}/leads/l1/custom-fields/f1`, ["set_custom_field"]],
    ["DELETE", `${P}/leads/l1/custom-fields/f1`, ["set_custom_field"]],
    ["GET", `${P}/teams`, ["list_teams"]],
    ["GET", `${P}/teams/t1/members`, ["list_teams"]],
    ["GET", `${P}/tags`, ["list_fields_and_tags"]],
    ["POST", `${P}/tags`, ["create_tag"]],
  ])("%s %s → %j", (method, path, expected) => {
    expect(toolsFor(method, API, path)).toEqual(expected);
  });

  it.each([
    ["POST", "/api/v1/mcp"],
    ["POST", "/api/v1/mcp/"],
    ["GET", "/api/v1/mcp"],
    ["DELETE", "/api/v1/mcp"],
  ])("%s app.dripify.com%s → mcp_access", (method, path) => {
    expect(toolsFor(method, "app.dripify.com", path)).toEqual(["mcp_access"]);
  });

  it("covers nothing outside the documented API and the MCP server", () => {
    expect(toolsFor("GET", API, "/v1/campaigns")).toEqual([]);
    expect(toolsFor("GET", API, `${P}/leads/l1/messages`)).toEqual([]);
    expect(toolsFor("POST", API, "/api/v1/mcp")).toEqual([]);
    expect(toolsFor("GET", "app.dripify.com", `${P}/campaigns`)).toEqual([]);
    expect(toolsFor("GET", "app.dripify.com", "/api/v1/mcpx")).toEqual([]);
  });

  it("puts the MCP server with the writes: it can upload leads", () => {
    const writes = dripifyPermissions.groups
      .filter((g) => g.category === "write")
      .flatMap((g) => g.tools.map((t) => t.id));
    expect(writes).toContain("mcp_access");
  });
});
