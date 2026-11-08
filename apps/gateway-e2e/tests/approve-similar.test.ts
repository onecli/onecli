import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { compiledGrantStack, type WorldSpec } from "../src/fixtures.js";
import { startForwardProxy } from "../src/forward-proxy.js";
import { startHeldRequest, throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * "Approve similar", end to end through the real binary.
 *
 * An agent updating a list of CRM records one call at a time (Attio has no
 * bulk update) raises one card per record. Approving the first card as
 * "similar" lets the agent's next updates of the same kind through, and
 * nothing else.
 *
 * Attio's documented "Update a record" (`PATCH /v2/objects/<type>/records/
 * <uuid>`) is the update of one record. The grant reads freely and asks for
 * every write: each write tool, and "All other writes" (where a `PUT` lands,
 * Attio's catalog tool being the `PATCH`).
 *
 * Hermetic: allowed requests reach a local forward proxy that records them.
 */
const HOLD_MS = 300;
const ATTIO = "http://api.attio.com";
const REC = (n: number) =>
  `8422b746-59d3-4cfd-98f9-3b25dc91${String(n).padStart(4, "0")}`;

const world: WorldSpec = {
  appConnections: [{ provider: "attio", label: "acme" }],
  rules: [
    ...compiledGrantStack("attio", ["get_record"], {
      ask: [
        "create_record",
        "update_record",
        "delete_record",
        "update_list_entry",
      ],
      otherReads: "allow",
      otherWrites: "ask",
    }),
  ],
  withApiKey: true,
};

const updateCompany = (n: number, method = "PATCH") => ({
  method,
  url: `${ATTIO}/v2/objects/companies/records/${REC(n)}`,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ data: { values: { description: `e2e ${n}` } } }),
});

/** The request-log row of one forwarded request, once the gateway wrote it. */
const logRowOf = async (cx: Cx, path: string) => {
  for (let i = 0; i < 50; i++) {
    const row = await cx.db.prisma.requestLog.findFirst({
      where: { path },
      select: { extraData: true },
    });
    if (row) return row.extraData;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no request-log row for ${path}`);
};

describe("approve similar updates (wire-level)", () => {
  scenario(
    "an update card offers it with its bounds; a create or another write does not",
    async (cx) => {
      await cx.seed(world);
      const gw = await cx.startGateway();

      const update = await startHeldRequest(
        gw.origin,
        { ...updateCompany(101), token: cx.ids.agentToken },
        HOLD_MS,
      );
      const card = await waitForApproval(gw, cx.ids.apiKey);
      expect(card.similar).toEqual({
        label: "Attio updates to companies",
        windowMinutes: 15,
        maxRequests: 100,
      });
      // The window's key never reaches a client.
      expect(JSON.stringify(card)).not.toContain("approval-similar");
      await decideApproval(gw, cx.ids.apiKey, card.id, "deny");
      expect((await update.response).status).toBe(403);

      for (const req of [
        {
          method: "POST",
          url: `${ATTIO}/v2/objects/companies/records`,
        },
        // A list entry update is a write, but not a documented record update.
        {
          method: "PATCH",
          url: `${ATTIO}/v2/lists/sales/entries/${REC(102)}`,
        },
      ]) {
        const held = await startHeldRequest(
          gw.origin,
          {
            ...req,
            token: cx.ids.agentToken,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data: { values: {} } }),
          },
          HOLD_MS,
        );
        const other = await waitForApproval(gw, cx.ids.apiKey);
        expect(other.url).toBe(req.url);
        expect(other.similar ?? null).toBeNull();
        // Asking for "similar" on a card that never offered it is refused,
        // and the request stays held.
        const refused = await decideApproval(
          gw,
          cx.ids.apiKey,
          other.id,
          "approve",
          {},
          { scope: "similar" },
        );
        expect(refused.status).toBe(422);
        expect(refused.body).toEqual({ error: "similar_not_offered" });
        await decideApproval(gw, cx.ids.apiKey, other.id, "deny");
        expect((await held.response).status).toBe(403);
      }
    },
  );

  scenario(
    "approved as similar: the next updates of that kind go through and are logged as approved by the reviewer; anything else still asks",
    async (cx) => {
      await cx.seed(world);
      const proxy = await startForwardProxy();
      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });

        // 1. The first update is held; the reviewer approves it as similar.
        const first = await startHeldRequest(
          gw.origin,
          { ...updateCompany(1), token: cx.ids.agentToken },
          HOLD_MS,
        );
        const card = await waitForApproval(gw, cx.ids.apiKey);
        const decided = await decideApproval(
          gw,
          cx.ids.apiKey,
          card.id,
          "approve",
          {},
          { scope: "similar" },
        );
        expect(decided.status).toBe(200);
        expect(decided.body).toMatchObject({
          success: true,
          similar: { label: "Attio updates to companies" },
        });
        expect((await first.response).status).toBe(200);

        // 2. Updates of other companies pass at once, with no card.
        for (const n of [2, 3]) {
          const res = await throughProxy(gw.origin, {
            ...updateCompany(n),
            token: cx.ids.agentToken,
            timeoutMs: 10_000,
          });
          expect(res.status).toBe(200);
        }
        // Nothing is waiting (`wait=0`: answer now, don't long-poll).
        const pendingNow = await fetch(
          `${gw.origin}/v1/approvals/pending?wait=0`,
          { headers: { authorization: `Bearer ${cx.ids.apiKey}` } },
        );
        expect(await pendingNow.json()).toMatchObject({ requests: [] });
        expect(proxy.requests().map((r) => r.url)).toEqual(
          [1, 2, 3].map(
            (n) => `${ATTIO}/v2/objects/companies/records/${REC(n)}`,
          ),
        );

        // Each one the window let through is its own row, approved through
        // the reviewer's card, by the reviewer.
        for (const n of [2, 3]) {
          const extra = await logRowOf(
            cx,
            `/v2/objects/companies/records/${REC(n)}`,
          );
          expect(extra).toMatchObject({
            decision: "approval_approved",
            approved_via_similar: card.id,
            approved_by: cx.ids.user,
          });
          expect(extra).not.toHaveProperty("approval_id");
        }

        // 3. A delete of the same record type, an update of another type,
        //    and the same update by PUT (held by another rule) still ask.
        for (const req of [
          {
            method: "DELETE",
            url: `${ATTIO}/v2/objects/companies/records/${REC(4)}`,
          },
          {
            ...updateCompany(5),
            url: `${ATTIO}/v2/objects/people/records/${REC(5)}`,
          },
          updateCompany(6, "PUT"),
        ]) {
          const held = await startHeldRequest(
            gw.origin,
            { ...req, token: cx.ids.agentToken },
            HOLD_MS,
          );
          const again = await waitForApproval(gw, cx.ids.apiKey);
          expect(again.url).toBe(req.url);
          await decideApproval(gw, cx.ids.apiKey, again.id, "deny");
          expect((await held.response).status).toBe(403);
        }
      } finally {
        await proxy.close();
      }
    },
  );

  scenario("a deny can't carry the similar scope", async (cx) => {
    await cx.seed(world);
    const gw = await cx.startGateway();
    const held = await startHeldRequest(
      gw.origin,
      { ...updateCompany(7), token: cx.ids.agentToken },
      HOLD_MS,
    );
    const card = await waitForApproval(gw, cx.ids.apiKey);
    const res = await decideApproval(
      gw,
      cx.ids.apiKey,
      card.id,
      "deny",
      {},
      { scope: "similar" },
    );
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "scope_requires_approve" });
    await decideApproval(gw, cx.ids.apiKey, card.id, "deny");
    expect((await held.response).status).toBe(403);
  });
});
