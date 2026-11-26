import { catalogToolIds } from "@onecli/api/apps/app-permissions/validate";
import { describe, expect } from "vitest";

import {
  decideApproval,
  pendingApprovals,
  type PendingApproval,
} from "../src/control.js";
import { compiledGrantStack } from "../src/fixtures.js";
import type { GatewayHandle } from "../src/gateway.js";
import { startHeldRequest, throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Salesforce sObject Collections (up to 200 records per call) through the
 * real binary, with the stack the REAL grant compiler emits for the
 * `update_record` and `delete_record` tools: the card an approver sees is
 * the table of every record it changes. A request that asks Salesforce to
 * run another method (`_HttpMethod`) is refused outright, never carded.
 *
 * Hermetic: plain http (no current-value read, no links), and every held
 * request is DENIED, so nothing egresses.
 */
const HOST = "acme.my.salesforce.com";
const BASE = `http://${HOST}/services/data/v60.0/composite/sobjects`;
const HOLD_MS = 300;
const id = (n: number) => `003QO00000Blk${String(n).padStart(3, "0")}AA`;

const WORLD = {
  withApiKey: true,
  appConnections: [
    {
      provider: "salesforce",
      label: "jane@acme.example",
      credentials: {
        access_token: "e2e-sf-token",
        refresh_token: "e2e-sf-refresh",
        token_type: "Bearer",
        expires_at: 4_102_444_800,
        instance_host: HOST,
        token_endpoint: "https://login.salesforce.com/services/oauth2/token",
      },
    },
  ],
  rules: compiledGrantStack("salesforce", [], {
    // Every change needs a human: the card is what this suite reads.
    ask: ["create_record", "update_record", "delete_record"],
  }),
};

/** Hold one request, read its card, deny it, and prove it never left. */
const heldCard = async (
  gw: GatewayHandle,
  cx: { ids: { agentToken: string; apiKey: string } },
  method: "PATCH" | "POST" | "DELETE",
  url: string,
  body?: unknown,
): Promise<PendingApproval> => {
  const held = await startHeldRequest(
    gw.origin,
    {
      method,
      url,
      token: cx.ids.agentToken,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    HOLD_MS,
  );
  let pending = await pendingApprovals(gw, cx.ids.apiKey);
  for (let i = 0; i < 50 && pending.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pending = await pendingApprovals(gw, cx.ids.apiKey);
  }
  const [card] = pending;
  if (!card) throw new Error(`${method} ${url} was not held`);
  await decideApproval(gw, cx.ids.apiKey, card.id, "deny");
  expect((await held.response).status).toBe(403);
  return card;
};

const updates = (n: number, extra: Record<string, string> = {}) => ({
  allOrNone: false,
  records: Array.from({ length: n }, (_, i) => ({
    attributes: { type: "Contact" },
    id: id(i + 1),
    MailingCountry: "Canada",
    ...extra,
  })),
});

describe("salesforce bulk changes (wire-level)", () => {
  scenario(
    "an update of many records is held as one table, with or without the trailing slash",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();
      for (const url of [BASE, `${BASE}/`]) {
        const card = await heldCard(gw, cx, "PATCH", url, updates(3));
        expect(card.summary?.action).toBe("Update 3 Contacts");
        expect(card.summary?.bulk).toMatchObject({
          kind: "update",
          object: "Contact",
          objectLabel: "Contact",
          fields: [{ api: "MailingCountry", label: "Mailing country" }],
        });
        expect(card.summary?.bulk?.rows.map((r) => r.id)).toEqual([
          id(1),
          id(2),
          id(3),
        ]);
        expect(card.summary?.details).toContainEqual({
          label: "Change",
          value: "Mailing country → Canada · 3 records",
        });
        expect(JSON.stringify(card)).not.toContain("e2e-sf-token");
      }
    },
  );

  scenario(
    "a 200-record update with a 1 KB field each (~250 KB) still reads as the whole table",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();
      const body = updates(200, { Description: "x".repeat(1000) });
      expect(JSON.stringify(body).length).toBeGreaterThan(200_000);
      const card = await heldCard(gw, cx, "PATCH", BASE, body);
      expect(card.summary?.action).toBe("Update 200 Contacts");
      expect(card.summary?.bulk?.rows).toHaveLength(200);
    },
  );

  scenario(
    "a bulk delete by ids names the object and every record",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();
      const card = await heldCard(
        gw,
        cx,
        "DELETE",
        `${BASE}?ids=${id(1)},${id(2)}&allOrNone=false`,
      );
      expect(card.summary?.action).toBe("Delete 2 Contacts");
      expect(card.summary?.bulk?.kind).toBe("delete");
      expect(card.summary?.bulk?.rows.map((r) => r.id)).toEqual([id(1), id(2)]);
    },
  );

  scenario(
    "a Composite call updating records of one type is held as the same table, under the default grant's ask",
    async (cx) => {
      // No catalog tool describes /composite: it lands on the grant's
      // "all other writes" row, which asks by default.
      await cx.seed({ ...WORLD, rules: compiledGrantStack("salesforce", []) });
      const gw = await cx.startGateway();
      // Ids distinct in their first 15 chars, as two records' always are
      // (the last 3 only encode case): one record named twice is no table.
      const cid = (n: number) => `003QO00000Cm${n}k00AA`;
      const patch = (n: number, body: Record<string, string>) => ({
        method: "PATCH",
        url: `/services/data/v60.0/sobjects/Contact/${cid(n)}`,
        referenceId: `r${n}`,
        body,
      });
      const card = await heldCard(
        gw,
        cx,
        "POST",
        `http://${HOST}/services/data/v60.0/composite`,
        {
          allOrNone: false,
          compositeRequest: [
            patch(1, { Department: "Research" }),
            patch(2, { Title: "Lead" }),
          ],
        },
      );
      expect(card.summary?.action).toBe("Update 2 Contacts");
      expect(card.summary?.bulk).toMatchObject({
        kind: "update",
        object: "Contact",
        fields: [
          { api: "Department", label: "Department" },
          { api: "Title", label: "Title" },
        ],
        rows: [
          { id: cid(1), new: ["Research", null] },
          { id: cid(2), new: [null, "Lead"] },
        ],
      });
    },
  );

  scenario(
    "a bulk POST asking Salesforce to run another method is refused, never held",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();
      // A create-looking body over a delete override, in every spelling the
      // gateway can't trust: refused before any rule, card, or credential.
      for (const query of [
        "_HttpMethod=DELETE",
        "_HttpMethod=delete",
        "_httpmethod=PATCH",
      ]) {
        const res = await throughProxy(gw.origin, {
          method: "POST",
          url: `${BASE}?${query}&ids=${id(1)},${id(2)}`,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            records: [{ attributes: { type: "Contact" }, LastName: "Decoy" }],
          }),
        });
        expect(res.status, query).toBe(403);
        expect(res.json(), query).toMatchObject({
          error: "method_override_refused",
        });
      }
      expect(gw.logs()).not.toContain("MANUAL APPROVAL required");
    },
  );
});

describe("salesforce bulk grants (wire-level)", () => {
  const grantWorld = (allow: string[]) => ({
    ...WORLD,
    rules: compiledGrantStack("salesforce", allow),
  });

  scenario(
    "a grant that leaves out update_record blocks a bulk update by that tool, on both spellings",
    async (cx) => {
      await cx.seed(grantWorld(["query"]));
      const gw = await cx.startGateway();
      for (const url of [BASE, `${BASE}/`]) {
        const res = await throughProxy(gw.origin, {
          method: "PATCH",
          url,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(updates(2)),
        });
        // The grant's own "blocked" row (the unpicked catalog tools), not
        // its "everything else" approval terminal: the bulk path IS the
        // update_record tool.
        expect(res.status, url).toBe(403);
        expect(res.json(), url).toMatchObject({
          error: "blocked_by_policy",
          rule_name: "Grant: e2e · salesforce: blocked",
        });
      }
    },
  );

  scenario(
    "the bulk paths match their own tool, not the approval terminal, on both spellings",
    async (cx) => {
      // Every Salesforce tool but update_record is allowed, so the ONLY
      // row that can refuse a request is the grant's blocked row (which
      // holds just update_record). A bulk update refused there proves the
      // path is that tool; one that matched no tool would be held at the
      // "everything else" terminal instead. Hermetic: nothing is forwarded.
      const others = catalogToolIds("salesforce").filter(
        (t) => t !== "update_record",
      );
      await cx.seed(grantWorld(others));
      const gw = await cx.startGateway();
      for (const url of [BASE, `${BASE}/`]) {
        const res = await throughProxy(gw.origin, {
          method: "PATCH",
          url,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(updates(2)),
        });
        expect(res.json(), url).toMatchObject({
          error: "blocked_by_policy",
          rule_name: "Grant: e2e · salesforce: blocked",
        });
      }
      // Refused at the grant's blocked row, never held at the terminal
      // (an empty pending read would long-poll; the log is direct).
      expect(gw.logs()).not.toContain("MANUAL APPROVAL required");
    },
  );

  scenario(
    "the bulk POST (create) stays outside every tool: held for a human even with create_record allowed",
    async (cx) => {
      await cx.seed(grantWorld(["create_record"]));
      const gw = await cx.startGateway();
      const card = await heldCard(gw, cx, "POST", BASE, {
        records: [
          { attributes: { type: "Contact" }, LastName: "Ng" },
          { attributes: { type: "Contact" }, LastName: "Ito" },
        ],
      });
      expect(card.summary?.action).toBe("Create 2 Contacts");
      expect(card.summary?.bulk?.rows.map((r) => r.name)).toEqual([
        "Ng",
        "Ito",
      ]);
    },
  );
});
