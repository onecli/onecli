import { describe, expect } from "vitest";
import {
  groupApprovals,
  orderGroupRows,
} from "@onecli/api/lib/approval-groups";

import {
  decideApproval,
  pendingApprovals,
  waitForApproval,
} from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * A tagged batch of 20 updates, sent at once the way the agent instructions
 * now ask, is held as 20 approvals that all carry the same batch tag and
 * each name their record, so one card can list (and sort, and label) all 20
 * and approve them in one click.
 *
 * Hermetic: plain http, so no name read and no link; every request is
 * DENIED in one decision per id, so nothing egresses.
 */
const HOST = "acme.my.salesforce.com";
const ID = (n: number) => `003QO00000Btch${String(n).padStart(2, "0")}AA`;

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
  rules: [
    {
      name: "sf updates need approval",
      action: "allow" as const,
      requireApproval: true,
      source: "grant" as const,
      priority: 1,
      identities: ["agent"] as const,
      targets: [
        {
          kind: "connection" as const,
          connectionIndex: 0,
          tools: ["update_record"],
        },
      ],
    },
  ],
};

describe("a tagged batch of 20 (wire-level)", () => {
  scenario(
    "20 parallel tagged updates are held together, each naming its record and change",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();

      // Sent in arrival order 20, 19, … 1: the card must not depend on it.
      const held = await Promise.all(
        Array.from({ length: 20 }, (_, i) => 20 - i).map((n) =>
          startHeldRequest(
            gw.origin,
            {
              method: "PATCH",
              url: `http://${HOST}/services/data/v59.0/sobjects/Contact/${ID(n)}`,
              token: cx.ids.agentToken,
              headers: {
                "content-type": "application/json",
                "x-onecli-batch": "title-after",
                "x-onecli-batch-label": "Set Title=After on 20 contacts",
                "x-onecli-batch-total": "20",
              },
              body: JSON.stringify({ Title: "After" }),
            },
            300,
          ),
        ),
      );
      await waitForApproval(gw, cx.ids.apiKey);
      let pending = await pendingApprovals(gw, cx.ids.apiKey);
      for (let i = 0; i < 50 && pending.length < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        pending = await pendingApprovals(gw, cx.ids.apiKey);
      }

      // All 20 are waiting at once, under one batch tag: one card.
      expect(pending).toHaveLength(20);
      for (const a of pending) {
        expect(a.batch).toEqual({
          id: "title-after",
          label: "Set Title=After on 20 contacts",
          total: 20,
        });
        // Each names its record (what the card sorts and leads by; its id
        // here, with no name read over http) and carries the changed field
        // with its label (what the row shows).
        expect(a.summary?.subject?.record).toMatch(/^003QO00000Btch\d{2}AA$/);
        expect(a.summary?.details).toContainEqual({
          label: "Title",
          value: "After",
        });
      }
      // The batch headers never reach the upstream: stripped at the gateway
      // (no egress here; the strip list is unit-tested).

      // Sent 20 → 1; the card lists them 01 → 20 (the order every surface
      // shows, from the records the gateway put on the wire).
      const [group] = groupApprovals(pending);
      if (!group) throw new Error("expected one card for the batch");
      expect(group.approvals).toHaveLength(20);
      expect(
        orderGroupRows(group, group.approvals).map(
          (a) => a.summary?.subject?.record,
        ),
      ).toEqual(Array.from({ length: 20 }, (_, i) => ID(i + 1)));

      for (const a of pending) {
        await decideApproval(gw, cx.ids.apiKey, a.id, "deny");
      }
      for (const h of held) expect((await h.response).status).toBe(403);
    },
  );
});
