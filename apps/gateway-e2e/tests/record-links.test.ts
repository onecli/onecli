import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { throughMitm } from "../src/mitm.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/** How long to prove the socket is genuinely held before acting on it. */
const HOLD_MS = 300;

/** Reads as issue 1 of a/b; the dot segments resolve it to c/d#2. Sent raw
 *  in absolute form: a URL-parsing client (undici, fetch) would resolve them
 *  before the gateway ever sees them. */
const DOTTED =
  "/repos/a/b/issues/1/%2e%2e/%2e%2e/%2e%2e/%2e%2e/repos/c/d/issues/2";

const approvalWorld = (host: string) => ({
  withApiKey: true,
  rules: [
    {
      name: "writes need approval",
      action: "allow" as const,
      requireApproval: true,
      targets: [{ hostPattern: host }],
    },
  ],
});

/**
 * A held change to an existing record leads its card with a link to that
 * record, built by the gateway from the request's own API host and path.
 * Every held request here is DENIED unless it targets the local stub, so
 * nothing reaches a real service.
 */
describe("record links on approval cards (wire-level)", () => {
  scenario(
    "a held GitHub issue edit leads with a link to the issue",
    async (cx) => {
      await cx.seed(approvalWorld("api.github.com"));
      const gw = await cx.startGateway();

      const held = throughMitm(gw.origin, {
        authority: "api.github.com:443",
        path: "/repos/acme/web/issues/42",
        method: "PATCH",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      const row = await waitForApproval(gw, cx.ids.apiKey);
      expect(row.summary?.details[0]).toEqual({
        label: "Issue",
        value: "acme/web#42",
        url: "https://github.com/acme/web/issues/42",
      });

      await decideApproval(gw, cx.ids.apiKey, row.id, "deny");
      expect((await held).status).toBe(403);
    },
  );

  // Why a dotted path may not link: the request the reviewer approves goes
  // out on the RESOLVED path, so a link built from the raw one would point
  // at a record the request never touches.
  scenario("the upstream receives a dotted path resolved", async (cx) => {
    const upstream = await cx.upstreamTls();
    upstream.respond({ status: 200, body: "{}" });
    await cx.seed(approvalWorld("127.0.0.1"));
    const gw = await cx.startGateway();

    const held = await startHeldRequest(
      gw.origin,
      {
        method: "PATCH",
        url: `https://${upstream.authority}${DOTTED}`,
        token: cx.ids.agentToken,
        body: "{}",
      },
      HOLD_MS,
    );
    const row = await waitForApproval(gw, cx.ids.apiKey);
    expect(row.url).toContain(DOTTED);

    await decideApproval(gw, cx.ids.apiKey, row.id, "approve");
    await held.response;
    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.url).toBe("/repos/repos/c/d/issues/2");
  });

  scenario(
    "so a dotted GitHub path gets no link to the record it seems to name",
    async (cx) => {
      await cx.seed(approvalWorld("api.github.com"));
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        {
          method: "PATCH",
          url: `https://api.github.com${DOTTED}`,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "closed" }),
        },
        HOLD_MS,
      );
      const row = await waitForApproval(gw, cx.ids.apiKey);
      expect(row.url).toContain(DOTTED);
      expect(row.summary?.details.some((d) => d.url !== undefined)).toBe(false);

      await decideApproval(gw, cx.ids.apiKey, row.id, "deny");
      expect((await held.response).status).toBe(403);
    },
  );
});
