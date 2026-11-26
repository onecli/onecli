import { afterEach, describe, expect, it, vi } from "vitest";
import { tavily } from "./tavily";
import { tavilyPermissions } from "./app-permissions/tavily";
import { hostPatternsOf, methodsOf } from "./app-permissions/types";
import { hostMatches, pathMatches } from "../lib/path-match";

const resolveMetadata =
  tavily.connectionMethod.type === "api_key"
    ? tavily.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("tavily must expose resolveMetadata");

const response = (status: number) => ({ status });

describe("tavily resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  // GET /usage costs no credits, so it validates the key without spending
  // any. Bounded: the connect request awaits it.
  it("probes /usage with the trimmed key as a Bearer, bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " tvly-key \n" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.tavily.com/usage", {
      headers: { Authorization: "Bearer tvly-key" },
      signal: expect.any(AbortSignal),
    });
  });

  it("hard-fails on 401: a missing, mistyped, or revoked key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await expect(resolveMetadata({ apiKey: "bad" })).rejects.toThrow(
      /Tavily rejected this API key/,
    );
  });

  it.each([200, 429, 500])(
    "accepts the key on %s (no identity to label it with)",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
      await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
    },
  );

  it("never hard-fails when Tavily is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });
});

// Which tools a request falls under. Pins the fences that matter: the
// research poll is its own read (one segment, never deeper), the one write is
// feedback, and the MCP server is reached only by its own tool, on its own
// path of the MCP host, never on that host's OAuth endpoints.
const toolsFor = (method: string, host: string, path: string) =>
  tavilyPermissions.groups
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

describe("tavily permission catalog", () => {
  const API = "api.tavily.com";

  // Every operation in Tavily's published OpenAPI, one row each.
  it.each([
    ["POST", "/search", ["search"]],
    ["POST", "/extract", ["extract"]],
    ["POST", "/crawl", ["crawl"]],
    ["POST", "/map", ["map"]],
    ["POST", "/research", ["research"]],
    ["GET", "/research/123e4567-e89b-12d3-a456-426614174111", ["get_research"]],
    ["GET", "/research/r1?include_usage=true", ["get_research"]],
    ["POST", "/feedback", ["feedback"]],
    ["GET", "/usage", ["usage"]],
    ["POST", "/logs", ["logs"]],
    ["POST", "/org-usage", ["org_usage"]],
  ])("%s %s → %j", (method, path, expected) => {
    expect(toolsFor(method, API, path)).toEqual(expected);
  });

  it.each([
    ["POST", "/mcp"],
    ["POST", "/mcp/"],
    ["GET", "/mcp"],
    ["DELETE", "/mcp/"],
  ])("%s mcp.tavily.com%s → mcp_access", (method, path) => {
    expect(toolsFor(method, "mcp.tavily.com", path)).toEqual(["mcp_access"]);
  });

  it("covers nothing outside the documented API and the MCP server", () => {
    expect(toolsFor("GET", API, "/research")).toEqual([]);
    expect(toolsFor("GET", API, "/research/r1/extra")).toEqual([]);
    expect(toolsFor("POST", API, "/research/r1")).toEqual([]);
    expect(toolsFor("GET", API, "/search")).toEqual([]);
    expect(toolsFor("POST", API, "/mcp")).toEqual([]);
    expect(toolsFor("POST", "mcp.tavily.com", "/search")).toEqual([]);
    for (const path of ["/mcpx", "/token", "/authorize", "/register"]) {
      expect(toolsFor("POST", "mcp.tavily.com", path), path).toEqual([]);
    }
  });

  it("makes feedback the only write: everything else only reads", () => {
    const writes = tavilyPermissions.groups
      .filter((g) => g.category === "write")
      .flatMap((g) => g.tools.map((t) => t.id));
    expect(writes).toEqual(["feedback"]);
  });
});
