import { afterEach, describe, expect, it, vi } from "vitest";
import { timeless } from "./timeless";
import { timelessPermissions } from "./app-permissions/timeless";
import { pathMatches } from "../lib/path-match";

const resolveMetadata =
  timeless.connectionMethod.type === "api_key"
    ? timeless.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("timeless must expose resolveMetadata");

// `resolveMetadata` reads nothing but the status: no body is ever parsed.
const response = (status: number) => ({ status });

describe("timeless resolveMetadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  // No /me endpoint exists, so the cheapest authenticated read validates the
  // token, sent as a standard Bearer (docs.timeless.day/api-reference). The
  // probe is bounded: the connect request awaits it.
  it("probes one room with the trimmed token as a Bearer, bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal("fetch", fetchMock);
    await resolveMetadata({ apiKey: " tok \n" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.timeless.day/v1/rooms?limit=1",
      {
        headers: { Authorization: "Bearer tok" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("hard-fails on 401: Timeless rejected the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await expect(resolveMetadata({ apiKey: "bad" })).rejects.toThrow(
      /Timeless rejected this API token/,
    );
  });

  it.each([200, 403, 429, 500])(
    "accepts the token on %s (no identity to label it with)",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
      await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
    },
  );

  it("never hard-fails when Timeless is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveMetadata({ apiKey: "k" })).resolves.toBeNull();
  });
});

// Which tools a request falls under. Pins the fences that matter: the bot
// routes share /meetings/* with the read tools, "send to link" must never be
// granted by "schedule for an event" (or vice versa), and the MCP server is
// its own tool, never a side effect of a REST grant. A tool with no
// method(s) answers any method, as the gateway's catalog reads it.
const toolsFor = (method: string, path: string) =>
  timelessPermissions.groups
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

describe("timeless permission catalog", () => {
  it.each([
    ["GET", "/v1/meetings", ["list_meetings"]],
    ["GET", "/v1/meetings?status=completed&limit=10", ["list_meetings"]],
    ["GET", "/v1/meetings/upcoming", ["list_upcoming_meetings"]],
    ["GET", "/v1/meetings/mtg_abc/transcript", ["get_transcript"]],
    ["GET", "/v1/meetings/mtg_abc/recording", ["get_recording"]],
    ["GET", "/v1/documents/doc_abc?format=markdown", ["get_document"]],
    ["GET", "/v1/rooms", ["list_rooms"]],
    ["GET", "/v1/meetings/mtg_abc/permissions", ["list_meeting_permissions"]],
    ["GET", "/v1/settings/notetaker-automation", ["get_notetaker_automation"]],
    ["GET", "/v1/webhooks", ["list_webhooks"]],
    ["POST", "/v1/meetings/evt_1/bot", ["schedule_bot"]],
    ["DELETE", "/v1/meetings/evt_1/bot", ["cancel_bot"]],
    ["POST", "/v1/meetings/bot", ["send_bot_to_link"]],
    ["PUT", "/v1/meetings/upload", ["upload_media"]],
    ["POST", "/v1/meetings/mtg_abc/permissions", ["set_meeting_permission"]],
    [
      "DELETE",
      "/v1/meetings/mtg_abc/permissions/perm_1",
      ["revoke_meeting_permission"],
    ],
    ["PUT", "/v1/settings/notetaker-automation", ["set_notetaker_automation"]],
    ["POST", "/v1/webhooks", ["manage_webhooks"]],
    ["PATCH", "/v1/webhooks/whk_1", ["manage_webhooks"]],
    ["DELETE", "/v1/webhooks/whk_1", ["manage_webhooks"]],
    // The MCP server: the documented URL has a trailing slash, clients may
    // drop it, and the transport uses POST for calls and GET for the stream.
    ["POST", "/mcp/", ["mcp_access"]],
    ["POST", "/mcp", ["mcp_access"]],
    ["GET", "/mcp/", ["mcp_access"]],
  ])("%s %s → %j", (method, path, expected) => {
    expect(toolsFor(method, path)).toEqual(expected);
  });

  it("covers no undocumented reads", () => {
    expect(toolsFor("GET", "/v1/meetings/mtg_abc")).toEqual([]);
    expect(toolsFor("GET", "/v1/meetings/mtg_abc/transcript/x")).toEqual([]);
    // A lookalike prefix is not the MCP server.
    expect(toolsFor("POST", "/mcpx")).toEqual([]);
    expect(toolsFor("POST", "/v1/mcp")).toEqual([]);
  });
});
