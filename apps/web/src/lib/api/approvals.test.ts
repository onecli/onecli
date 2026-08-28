// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The decision client's status contract. The gateway answers 200 (delivered),
 * 410 (expired), or 404 (no longer pending — decided from another surface,
 * or a gateway restart dropped its held requests). 410 and 404 both mean the
 * CARD was stale, not that the click failed: surfacing them as errors made
 * the UI cry "Failed to submit decision" over a request that was already
 * settled (seen live after a gateway redeploy).
 */

vi.mock("@/hooks/use-vault-status", () => ({
  getGatewayApiUrl: () => "https://gw.test",
}));
vi.mock("@/lib/gateway-auth", () => ({
  getGatewayFetchOptions: async () => ({
    headers: {},
    credentials: "include" as const,
  }),
}));

const { decide } = await import("./approvals");

const respond = (status: number, body: unknown = {}) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
};

afterEach(() => vi.unstubAllGlobals());

describe("decide", () => {
  it("reports delivered on 200", async () => {
    respond(200, { success: true });
    await expect(decide("ap-1", "approve")).resolves.toBe("delivered");
  });

  it.each([410, 404])(
    "reports already_settled on %d — a stale card, not a failure",
    async (status) => {
      respond(status, { error: "gone" });
      await expect(decide("ap-1", "deny")).resolves.toBe("already_settled");
    },
  );

  it("throws on a real failure (500), with the server's message", async () => {
    respond(500, { error: "boom" });
    await expect(decide("ap-1", "approve")).rejects.toThrow("boom");
  });
});
