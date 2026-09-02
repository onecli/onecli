import { describe, expect } from "vitest";

import { GATEWAY_APP_URL } from "../src/gateway.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

const PROJ_SECRET = "sk-e2e-ungranted-proj";
const ORG_SECRET = "sk-e2e-ungranted-org";

/**
 * The step-7 law, end to end through the real binary: org/workspace injection is
 * driven SOLELY by grants.
 *
 * (a)/(b) are separate scenarios on purpose: each nonce owns its own connect
 * cache key, so the grant-less resolution can never be served to the granted
 * world. Scenario (a) is the fail-on-revert target — a gateway that injects
 * without a grant fails it.
 */
describe("grant-driven injection (attach-model step 7)", () => {
  scenario(
    "a grant-less agent injects nothing — even with the stale all-mode column",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed({
        secrets: [
          {
            hostPattern: "127.0.0.1",
            headerName: "x-proj-key",
            value: PROJ_SECRET,
          },
          {
            scope: "organization",
            hostPattern: "127.0.0.1",
            headerName: "x-org-key",
            value: ORG_SECRET,
          },
        ],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      // Forwarded, just uncredentialed — no grant, no injection, no block.
      expect(res.status).toBe(200);
      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-proj-key")).toBeUndefined();
      expect(seen?.header("x-org-key")).toBeUndefined();
    },
  );

  scenario(
    "the same world with grants injects — grants, not the column, drive the pool",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed({
        grantAll: true, // the sole difference from the scenario above, on purpose
        secrets: [
          {
            hostPattern: "127.0.0.1",
            headerName: "x-proj-key",
            value: PROJ_SECRET,
          },
          {
            scope: "organization",
            hostPattern: "127.0.0.1",
            headerName: "x-org-key",
            value: ORG_SECRET,
          },
        ],
      });
      const gw = await cx.startGateway();

      await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      const [seen] = await upstream.waitForRequests(1);
      expect(seen?.header("x-proj-key")).toBe(PROJ_SECRET);
      expect(seen?.header("x-org-key")).toBe(ORG_SECRET);
    },
  );

  scenario(
    "rewrites a 401 into access_restricted when an ungranted credential exists",
    async (cx) => {
      // The workspace HAS a credential for the host; the agent's grants don't
      // attach it. An upstream auth failure must be rewritten into the
      // attach-surface pointer — not the generic credential_not_found (that is
      // forwarding.test.ts's empty-world sibling), and not passed through
      // (that is the granted case).
      const upstream = await cx.upstream();
      upstream.respond({ status: 401, body: '{"error":"missing api key"}' });
      await cx.seed({
        secrets: [
          {
            hostPattern: "127.0.0.1",
            headerName: "x-test-key",
            value: "sk-e2e-restricted",
          },
        ],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: upstream.url("/v1/models"),
        token: cx.ids.agentToken,
      });

      // The upstream's status is preserved; the body is replaced with the
      // actionable pointer.
      expect(res.status).toBe(401);
      expect(res.header("x-should-retry")).toBe("false");
      const body = res.json() as {
        error: string;
        provider: string;
        manage_url: string;
      };
      expect(body.error).toBe("access_restricted");
      // 127.0.0.1 maps to no registry provider — the hostname is the fallback.
      expect(body.provider).toBe("127.0.0.1");
      expect(body.manage_url).toContain(GATEWAY_APP_URL);
      expect(body.manage_url).toContain(
        `/w/${cx.ids.workspace}/connections/apps/127.0.0.1`,
      );
      // This arm rewrites the upstream's verdict — it does not block egress:
      // exactly one, uncredentialed, request reached the stub.
      const seen = await upstream.waitForRequests(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.header("x-test-key")).toBeUndefined();
    },
  );

  scenario(
    "a grant-less agent resolves no app connections — ambiguity included",
    async (cx) => {
      await cx.seed({
        appConnections: [{ provider: "gmail" }, { provider: "gmail" }],
        // Egress backstop — gmail.googleapis.com is a real host; the gateway
        // must answer before anything could dial out.
        rules: [
          {
            name: "block-gmail",
            action: "block",
            targets: [{ hostPattern: "gmail.googleapis.com" }],
          },
        ],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: "http://gmail.googleapis.com/other/v1/thing",
        token: cx.ids.agentToken,
      });

      // The identical request in app-connections.test.ts's granted world is a
      // 409 listing both accounts. Grant-less the pool is empty — there is no
      // ambiguity to escalate — and policy answers instead.
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({
        error: "blocked_by_policy",
        rule_name: "block-gmail",
      });
    },
  );
});
