import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { compiledGrantStack, type WorldSpec } from "../src/fixtures.js";
import { startHeldRequest, throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Customized grants vs requests their catalog does not describe, end to end
 * through the real binary with the stack the REAL grant compiler emits.
 *
 * The field report: a Cloudflare grant customized to "Deploy Worker" could not
 * deploy, because wrangler's first call (`GET /client/v4/accounts`) is not a
 * catalog tool. Such a request is now held for a human (never refused
 * outright, never silently allowed), while catalog tools the user did not pick
 * stay explicitly blocked. AWS keeps a terminal block (`aws-grants.test.ts`).
 *
 * Hermetic like `graphql-discrimination.test.ts`: refusals are asserted by
 * rule NAME, and the held request is DENIED, so the real hostname never
 * egresses. A trailing workspace `sentinel` block over the whole host stands
 * in for "whatever comes after the grant": reaching it would prove the grant
 * stack let the request fall through.
 */
const HOLD_MS = 300;

const CF = "http://api.cloudflare.com/client/v4";

const cloudflareWorld: WorldSpec = {
  appConnections: [{ provider: "cloudflare" }],
  rules: [
    ...compiledGrantStack("cloudflare", ["deploy_worker"]),
    {
      name: "sentinel-after-grant",
      action: "block",
      priority: 100,
      targets: [{ kind: "network", hostPattern: "api.cloudflare.com" }],
    },
  ],
};

describe("customized grants: unlisted requests need approval (wire-level)", () => {
  scenario(
    "an uncatalogued GET /accounts is held for approval, not refused or allowed",
    async (cx) => {
      await cx.seed({ ...cloudflareWorld, withApiKey: true });
      const gw = await cx.startGateway();

      // Held: no response bytes until a human decides.
      const held = await startHeldRequest(
        gw.origin,
        { url: `${CF}/accounts`, token: cx.ids.agentToken },
        HOLD_MS,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);
      expect(approval.url).toContain("/client/v4/accounts");

      // Deny, so nothing egresses. The denial proves the approval terminal
      // decided: the sentinel after the stack was never reached.
      await decideApproval(gw, cx.ids.apiKey, approval.id, "deny");
      const res = await held.response;
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "manual_approval_denied",
        approval_id: approval.id,
      });
    },
  );

  scenario(
    "a catalog tool the user did not pick stays blocked by the grant",
    async (cx) => {
      await cx.seed(cloudflareWorld);
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        method: "DELETE",
        url: `${CF}/accounts/acc1/workers/scripts/app`,
        token: cx.ids.agentToken,
      });

      // An explicit Never beats the approval terminal: it is never one click away.
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "Grant: e2e · cloudflare: blocked",
      });
    },
  );
});
