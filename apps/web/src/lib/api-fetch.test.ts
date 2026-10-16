import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `apiFetch` takes a standard `RequestInit`, so caller headers can arrive as a
 * `Headers` instance, `[name, value]` pairs, or a plain object. The behavior
 * worth pinning: every form replaces the URL-derived and auth defaults, even
 * when the header name's casing differs, instead of being dropped or joined
 * onto them.
 */

const env = vi.hoisted(() => ({ cloud: false }));
vi.mock("@/lib/env", () => ({
  get IS_CLOUD() {
    return env.cloud;
  },
}));
vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: async () => ({
    tokens: { idToken: { toString: () => "id-token-1" } },
  }),
}));
vi.mock("@onecli/api/lib/public-origins", () => ({
  apiOrigin: () => "https://api.example.test",
}));

const { apiFetch } = await import("./api-fetch");

const fetchMock = vi.fn<typeof fetch>();
const sentHeaders = () => new Headers(fetchMock.mock.calls[0]?.[1]?.headers);

beforeEach(() => {
  env.cloud = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { pathname: "/w/ws-from-url/agents" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const workspaceOverrides: [string, HeadersInit][] = [
  ["a Headers instance", new Headers({ "X-Workspace-Id": "ws-selected" })],
  ["[name, value] pairs", [["X-Workspace-Id", "ws-selected"]]],
  ["a plain object", { "X-Workspace-Id": "ws-selected" }],
];

describe("apiFetch caller headers", () => {
  it.each(workspaceOverrides)(
    "replace the URL-derived workspace when passed as %s",
    async (_form, headers) => {
      await apiFetch("/v1/agents", { headers });
      expect(sentHeaders().get("x-workspace-id")).toBe("ws-selected");
      expect(sentHeaders().has("0")).toBe(false);
    },
  );

  it("replace a default whose name differs only in casing", async () => {
    await apiFetch("/v1/example", {
      headers: { "content-type": "text/plain" },
    });
    expect(sentHeaders().get("content-type")).toBe("text/plain");
  });

  it("replace the cloud bearer token with a lowercase authorization", async () => {
    env.cloud = true;
    await apiFetch("/v1/example", {
      headers: { authorization: "Bearer caller-token" },
    });
    expect(sentHeaders().get("authorization")).toBe("Bearer caller-token");
  });

  it("leave the defaults in place when none are passed", async () => {
    await apiFetch("/v1/example");
    expect(sentHeaders().get("content-type")).toBe("application/json");
    expect(sentHeaders().get("x-workspace-id")).toBe("ws-from-url");
  });
});
