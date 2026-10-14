import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { compiledGrantStack, type WorldSpec } from "../src/fixtures.js";
import { startForwardProxy } from "../src/forward-proxy.js";
import { startHeldRequest, throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * "All other reads" / "All other writes", end to end through the real binary
 * with the stack the REAL grant compiler emits.
 *
 * The field report: a customized GitHub grant held `GET /installation/
 * repositories` for approval, because the catalog does not list it. With
 * "All other reads" on Allowed, an unlisted GET passes the grant, an unlisted
 * POST still asks, and a catalog tool the user did not pick stays blocked.
 *
 * Hermetic: an ALLOWED request is forwarded to a local forward proxy that
 * records it (nothing leaves the machine), the same pattern as
 * navan.test.ts; held requests are DENIED, and blocks never egress.
 */
const HOLD_MS = 300;
const GH = "http://api.github.com";

const world = (otherReads: "allow" | "ask"): WorldSpec => ({
  appConnections: [{ provider: "github-app", label: "acme" }],
  rules: [...compiledGrantStack("github-app", ["get_repo"], { otherReads })],
});

describe("customized grants: all other reads / writes (wire-level)", () => {
  scenario(
    "All other reads = Allowed: an unlisted GET passes the grant without approval",
    async (cx) => {
      await cx.seed(world("allow"));
      const proxy = await startForwardProxy();
      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });
        const res = await throughProxy(gw.origin, {
          url: `${GH}/installation/repositories`,
          token: cx.ids.agentToken,
          timeoutMs: 30_000,
        });
        // Forwarded straight away: not held, not refused.
        expect(res.status).toBe(200);
        expect(proxy.requests().map((r) => r.url)).toEqual([
          `${GH}/installation/repositories`,
        ]);
      } finally {
        await proxy.close();
      }
    },
  );

  scenario(
    "an unlisted POST still needs approval (All other writes)",
    async (cx) => {
      await cx.seed({ ...world("allow"), withApiKey: true });
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: `${GH}/repos/acme/web/labels`,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "e2e" }),
        },
        HOLD_MS,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);
      expect(approval.url).toContain("/repos/acme/web/labels");
      await decideApproval(gw, cx.ids.apiKey, approval.id, "deny");
      expect((await held.response).status).toBe(403);
    },
  );

  scenario(
    "a catalog tool the user did not pick stays blocked, even as a GET",
    async (cx) => {
      await cx.seed(world("allow"));
      const gw = await cx.startGateway();

      // search is a catalog GET the user left on Never: the blocked
      // complement sits before "All other reads", so it never reaches it.
      const res = await throughProxy(gw.origin, {
        url: `${GH}/search/code?q=e2e`,
        token: cx.ids.agentToken,
      });
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "Grant: e2e · github-app: blocked",
      });
    },
  );

  scenario(
    "the default (both Needs approval) still holds an unlisted GET",
    async (cx) => {
      await cx.seed({ ...world("ask"), withApiKey: true });
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        { url: `${GH}/installation/repositories`, token: cx.ids.agentToken },
        HOLD_MS,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);
      expect(approval.url).toContain("/installation/repositories");
      await decideApproval(gw, cx.ids.apiKey, approval.id, "deny");
      expect((await held.response).status).toBe(403);
    },
  );
});
