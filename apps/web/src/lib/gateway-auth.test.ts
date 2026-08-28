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
});

describe("getGatewayFetchOptions", () => {
  it("onprem: rides the session cookie — no auth headers", async () => {
    const getGatewayFetchOptions = await loadGetGatewayFetchOptions("onprem");
    await expect(getGatewayFetchOptions()).resolves.toEqual({
      headers: {},
      credentials: "include",
    });
  });

  it("unset edition parses as onprem and behaves identically", async () => {
    const getGatewayFetchOptions = await loadGetGatewayFetchOptions("");
    await expect(getGatewayFetchOptions()).resolves.toEqual({
      headers: {},
      credentials: "include",
    });
  });
});
