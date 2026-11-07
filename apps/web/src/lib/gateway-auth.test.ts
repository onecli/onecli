import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `getGatewayFetchOptions` branches on `IS_CLOUD` from `@/lib/env`, which is
 * resolved from `NEXT_PUBLIC_EDITION` at module evaluation — so each case
 * stubs the env and re-imports the module fresh.
 */
const loadGetGatewayFetchOptions = async (edition: string) => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_EDITION", edition);
  const { getGatewayFetchOptions } = await import("./gateway-auth");
  return getGatewayFetchOptions;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getGatewayFetchOptions", () => {
  it("onprem: rides the session cookie — no auth headers", async () => {
    const getGatewayFetchOptions = await loadGetGatewayFetchOptions("onprem");
    await expect(getGatewayFetchOptions()).resolves.toEqual({
      headers: {},
      credentials: "include",
    });
  });

  // Without the header the gateway falls back to the user's default
  // workspace, so approvals in any other workspace would be invisible from
  // that workspace's own pages.
  it("onprem: names the active workspace from the /w/<id>/ URL", async () => {
    vi.stubGlobal("window", {
      location: { pathname: "/w/ws-1/agents/ag-1/chat" },
    });
    const getGatewayFetchOptions = await loadGetGatewayFetchOptions("onprem");
    await expect(getGatewayFetchOptions()).resolves.toEqual({
      headers: { "X-Workspace-Id": "ws-1" },
      credentials: "include",
    });
  });
});
