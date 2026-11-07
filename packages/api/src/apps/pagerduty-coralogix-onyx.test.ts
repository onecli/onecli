import { afterEach, describe, expect, it, vi } from "vitest";
import { pagerduty, normalizePagerDutyRegion } from "./pagerduty";
import { coralogix, normalizeCoralogixRegion } from "./coralogix";
import { onyx } from "./onyx";
import { pagerdutyPermissions } from "./app-permissions/pagerduty";
import { coralogixPermissions } from "./app-permissions/coralogix";
import { onyxPermissions } from "./app-permissions/onyx";
import type { AppPermissionDefinition } from "./app-permissions/types";
import type { AppDefinition } from "./types";
import { hostMatches, pathMatches } from "../lib/path-match";

const resolverOf = (app: AppDefinition) => {
  if (app.connectionMethod.type !== "api_key") throw new Error(app.id);
  const fn = app.connectionMethod.resolveMetadata;
  if (!fn) throw new Error(`${app.id} must expose resolveMetadata`);
  return fn;
};

const json = (status: number, body: unknown = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
});

/** Which tools a request falls under (any host of the tool, method, path). */
const toolsFor =
  (def: AppPermissionDefinition) =>
  (method: string, host: string, path: string) =>
    def.groups
      .flatMap((g) => g.tools)
      .filter((t) => {
        const methods = t.methods ?? (t.method ? [t.method] : null);
        const hosts = [t.hostPattern, ...(t.hostAliasPatterns ?? [])];
        const paths = [t.pathPattern, ...(t.aliasPatterns ?? [])];
        return (
          (methods === null || methods.includes(method)) &&
          hosts.some((h) => hostMatches(host, h)) &&
          paths.some((p) => pathMatches(path, p))
        );
      })
      .map((t) => t.id);

afterEach(() => vi.unstubAllGlobals());

// The region dropdowns may only offer values the server accepts, and must
// start on a valid default: a choice the server rejects would be a dead option.
describe("region dropdowns", () => {
  const regionField = (app: AppDefinition) => {
    if (app.connectionMethod.type !== "api_key") throw new Error(app.id);
    const field = app.connectionMethod.fields.find((f) => f.name === "region");
    if (!field?.options) throw new Error(`${app.id} region has no options`);
    return { options: field.options, defaultValue: field.defaultValue };
  };

  it("pagerduty offers US and EU, US preselected", () => {
    const { options, defaultValue } = regionField(pagerduty);
    expect(options.map((o) => o.value)).toEqual(["us", "eu"]);
    expect(defaultValue).toBe("us");
    for (const o of options)
      expect(normalizePagerDutyRegion(o.value)).toBe(o.value);
  });

  it("coralogix offers every region, US2 preselected", () => {
    const { options, defaultValue } = regionField(coralogix);
    expect(options.map((o) => o.value)).toEqual([
      "us1",
      "us2",
      "us3",
      "eu1",
      "eu2",
      "ap1",
      "ap2",
      "ap3",
    ]);
    expect(defaultValue).toBe("us2");
    expect(options.find((o) => o.value === "us2")?.label).toContain("cx498");
    for (const o of options)
      expect(normalizeCoralogixRegion(o.value)).toBe(o.value);
  });
});

// ── PagerDuty ─────────────────────────────────────────────────────────

describe("pagerduty", () => {
  const resolve = resolverOf(pagerduty);

  it("normalizes the region", () => {
    expect(normalizePagerDutyRegion(" EU ")).toBe("eu");
    expect(normalizePagerDutyRegion("us")).toBe("us");
    expect(normalizePagerDutyRegion("")).toBeNull();
    expect(normalizePagerDutyRegion("apac")).toBeNull();
  });

  it("probes /users/me on the chosen region with the Token scheme", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(400));
    vi.stubGlobal("fetch", fetchMock);
    await resolve({ apiKey: " k \n", region: "eu" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eu.pagerduty.com/users/me",
      {
        headers: {
          Authorization: "Token token=k",
          Accept: "application/vnd.pagerduty+json;version=2",
        },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("rejects an unknown region before calling PagerDuty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolve({ apiKey: "k", region: "apac" })).rejects.toThrow(
      /Region must be "us" or "eu"/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hard-fails on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401)));
    await expect(resolve({ apiKey: "k", region: "us" })).rejects.toThrow(
      /PagerDuty rejected this API key in the US region/,
    );
  });

  // An account key has no user: /users/me answers 400, which still proves
  // the key authenticated. Anything that is not a 401 is non-fatal.
  it.each([400, 403, 429, 500])("accepts the key on %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status)));
    await expect(resolve({ apiKey: "k", region: "us" })).resolves.toEqual({
      name: "API Key",
      tags: ["US"],
    });
  });

  it("names a User Token connection after its user", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(200, { user: { name: "Ada", email: "ada@acme.io" } }),
        ),
    );
    await expect(resolve({ apiKey: "k", region: "us" })).resolves.toEqual({
      name: "Ada",
      email: "ada@acme.io",
      username: "ada@acme.io",
      tags: ["US"],
    });
  });

  it("never hard-fails when PagerDuty is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolve({ apiKey: "k", region: "us" })).resolves.toEqual({
      name: "API Key",
      tags: ["US"],
    });
  });

  const tools = toolsFor(pagerdutyPermissions);
  it.each([
    ["GET", "/incidents", ["list_incidents"]],
    ["GET", "/incidents/PABC123", ["get_incident"]],
    ["GET", "/incidents/PABC123/notes", ["list_incident_notes"]],
    ["GET", "/incidents/PABC123/log_entries", ["list_incident_log_entries"]],
    ["GET", "/oncalls", ["list_oncalls"]],
    ["GET", "/schedules/PS1/overrides", ["list_schedules"]],
    ["POST", "/analytics/metrics/incidents/all", ["read_analytics"]],
    ["POST", "/incidents", ["create_incident"]],
    ["PUT", "/incidents", ["update_incident"]],
    ["PUT", "/incidents/PABC123", ["update_incident"]],
    ["POST", "/incidents/PABC123/notes", ["add_incident_note"]],
    ["PUT", "/incidents/PABC123/merge", ["merge_incidents"]],
    ["POST", "/incidents/PABC123/responder_requests", ["add_responders"]],
    ["DELETE", "/maintenance_windows/PMW1", ["manage_maintenance_windows"]],
  ])("%s %s → %j", (method, path, expected) => {
    expect(tools(method, "api.pagerduty.com", path)).toEqual(expected);
    // Every tool answers on the EU host too.
    expect(tools(method, "api.eu.pagerduty.com", path)).toEqual(expected);
  });

  it("keeps single-item reads from reaching nested routes", () => {
    expect(
      tools("GET", "api.pagerduty.com", "/incidents/PABC123/notes"),
    ).not.toContain("get_incident");
    expect(
      tools("PUT", "api.pagerduty.com", "/incidents/PABC123/merge"),
    ).not.toContain("update_incident");
  });
});

// ── Coralogix ─────────────────────────────────────────────────────────

describe("coralogix", () => {
  const resolve = resolverOf(coralogix);

  it("normalizes the region from a code or a domain", () => {
    expect(normalizeCoralogixRegion("us2")).toBe("us2");
    expect(normalizeCoralogixRegion(" EU2 ")).toBe("eu2");
    expect(normalizeCoralogixRegion("ap1.coralogix.com")).toBe("ap1");
    expect(normalizeCoralogixRegion("cx498")).toBeNull();
    expect(normalizeCoralogixRegion("us2.evil.example")).toBeNull();
    expect(normalizeCoralogixRegion("")).toBeNull();
  });

  it("probes whoami on the region's API host as a Bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(403));
    vi.stubGlobal("fetch", fetchMock);
    await resolve({ apiKey: " k ", region: "us2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.us2.coralogix.com/mgmt/openapi/5/aaa/identity/v1/whoami",
      {
        headers: { Authorization: "Bearer k" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("rejects an unknown region before calling Coralogix", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolve({ apiKey: "k", region: "cx498" })).rejects.toThrow(
      /Region must be one of/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hard-fails on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401)));
    await expect(resolve({ apiKey: "k", region: "eu1" })).rejects.toThrow(
      /Coralogix rejected this API key in EU1/,
    );
  });

  // A DataQuerying key may not read whoami: 403 still means it authenticated.
  it.each([403, 429, 500])("accepts the key on %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status)));
    await expect(resolve({ apiKey: "k", region: "us2" })).resolves.toEqual({
      name: "API Key",
      tags: ["US2"],
    });
  });

  it("names the connection after the team", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(200, {
          teamId: 1,
          teamName: "acme",
          teamUrl: "https://acme.app.cx498.coralogix.com",
        }),
      ),
    );
    await expect(resolve({ apiKey: "k", region: "us2" })).resolves.toEqual({
      name: "acme",
      username: "acme",
      url: "https://acme.app.cx498.coralogix.com",
      tags: ["US2"],
    });
  });

  it("drops a teamUrl that is not a Coralogix https address", async () => {
    for (const teamUrl of [
      "https://evil.example/acme",
      "http://acme.app.cx498.coralogix.com",
      "javascript:alert(1)",
      "https://coralogix.com.evil.example",
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json(200, { teamName: "acme", teamUrl })),
      );
      const meta = await resolve({ apiKey: "k", region: "us2" });
      expect(meta, teamUrl).not.toHaveProperty("url");
    }
  });

  const tools = toolsFor(coralogixPermissions);
  it.each([
    ["POST", "/api/v1/dataprime/query", ["query_logs"]],
    ["GET", "/metrics/api/v1/query", ["query_metrics"]],
    ["GET", "/mgmt/openapi/5/alerts/alerts/v3", ["list_alerts"]],
    ["GET", "/mgmt/openapi/latest/alerts/alerts/v3/abc", ["list_alerts"]],
    ["POST", "/mgmt/openapi/5/incidents/incidents/v1", ["filter_incidents"]],
    ["GET", "/mgmt/openapi/5/incidents/incidents/v1/i1", ["list_incidents"]],
    ["POST", "/mgmt/openapi/5/cases/cases/v1", ["filter_cases"]],
    [
      "POST",
      "/mgmt/openapi/5/incidents/incidents/v1/all/resolve",
      ["update_incidents"],
    ],
    ["PUT", "/mgmt/openapi/5/cases/resolved/v1/c1", ["update_cases"]],
    ["POST", "/mgmt/openapi/5/alerts/alerts/v3", ["manage_alerts"]],
    ["DELETE", "/mgmt/openapi/5/alerts/alerts/v3/abc", ["delete_alert"]],
  ])("%s %s → %j", (method, path, expected) => {
    for (const host of [
      "api.us2.coralogix.com",
      "api.cx498.coralogix.com",
      "ng-api-http.cx498.coralogix.com",
      "api.coralogix.us",
    ]) {
      expect(tools(method, host, path), host).toEqual(expected);
    }
  });

  it("never matches a team web app or ingestion host", () => {
    for (const host of [
      "acme.app.cx498.coralogix.com",
      "ingress.us2.coralogix.com",
    ]) {
      expect(tools("POST", host, "/api/v1/dataprime/query")).toEqual([]);
    }
  });
});

// ── Onyx ──────────────────────────────────────────────────────────────

describe("onyx", () => {
  const resolve = resolverOf(onyx);

  it("probes /api/me as a Bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(500));
    vi.stubGlobal("fetch", fetchMock);
    await resolve({ apiKey: " k " });
    expect(fetchMock).toHaveBeenCalledWith("https://cloud.onyx.app/api/me", {
      headers: { Authorization: "Bearer k" },
      signal: expect.any(AbortSignal),
    });
  });

  // Onyx answers 403 (not 401) for a token it does not recognize.
  it.each([401, 403])("hard-fails on %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status)));
    await expect(resolve({ apiKey: "k" })).rejects.toThrow(
      /Onyx rejected this key/,
    );
  });

  it.each([429, 502])("accepts the key on %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status)));
    await expect(resolve({ apiKey: "k" })).resolves.toBeNull();
  });

  // Onyx answers a bare 500 for a token it cannot decode. A healthy Onyx
  // means the key was the problem; an unhealthy one is an outage.
  it("rejects a 500 when Onyx is otherwise healthy", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(500))
      .mockResolvedValueOnce(json(200));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolve({ apiKey: "k" })).rejects.toThrow(
      /Onyx rejected this key/,
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://cloud.onyx.app/api/health",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("accepts a 500 when Onyx itself is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(500))
        .mockRejectedValueOnce(new Error("offline")),
    );
    await expect(resolve({ apiKey: "k" })).resolves.toBeNull();
  });

  it("names the connection after the user and team", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(200, { email: "a@acme.io", team_name: "Acme" }),
        ),
    );
    await expect(resolve({ apiKey: "k" })).resolves.toEqual({
      name: "a@acme.io (Acme)",
      email: "a@acme.io",
      username: "a@acme.io",
    });
  });

  const tools = toolsFor(onyxPermissions);
  it.each([
    ["GET", "/api/me", ["get_me"]],
    ["POST", "/api/search/send-search-message", ["search"]],
    ["GET", "/api/chat/get-chat-session/abc", ["list_chat_sessions"]],
    ["POST", "/api/chat/send-chat-message", ["chat"]],
    ["POST", "/api/onyx-api/ingestion", ["ingest_documents"]],
    ["DELETE", "/api/onyx-api/ingestion/doc1", ["delete_ingested_document"]],
    ["PATCH", "/api/persona/7", ["update_agent"]],
    ["POST", "/mcp", ["mcp_access"]],
    ["POST", "/mcp/", ["mcp_access"]],
  ])("%s %s → %j", (method, path, expected) => {
    expect(tools(method, "cloud.onyx.app", path)).toEqual(expected);
  });

  it("covers nothing outside the API and MCP server", () => {
    expect(tools("GET", "cloud.onyx.app", "/chat")).toEqual([]);
    expect(tools("POST", "cloud.onyx.app", "/mcpx")).toEqual([]);
  });
});
