import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * A held Salesforce create reads as a record, not a JSON blob: the
 * approval card an approver sees names the object and lists its fields with
 * human labels, and a lookup field shows which record it points at.
 *
 * Hermetic: the request is plain http, so the gateway makes no name read
 * (the connection's credential never rides an internal read over http) and
 * builds no link; the card keeps the id and the title still names the record.
 * The read and link paths are unit-tested against a local upstream
 * (`proxy::approval_enrich`). The held request is DENIED, so nothing egresses.
 */
const HOST = "acme.my.salesforce.com";
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
      name: "sf reads",
      action: "allow" as const,
      source: "grant" as const,
      priority: 1,
      identities: ["agent"] as const,
      targets: [
        {
          kind: "connection" as const,
          connectionIndex: 0,
          tools: ["query"],
        },
      ],
    },
    {
      name: "sf writes need approval",
      action: "allow" as const,
      requireApproval: true,
      source: "grant" as const,
      priority: 2,
      identities: ["agent"] as const,
      targets: [
        {
          kind: "connection" as const,
          connectionIndex: 0,
          tools: ["create_record"],
        },
      ],
    },
  ],
};

describe("salesforce approval card (wire-level)", () => {
  scenario(
    "a held Contact create shows readable fields and the account reference",
    async (cx) => {
      await cx.seed(WORLD);
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: `http://${HOST}/services/data/v59.0/sobjects/Contact`,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            AccountId: "001QO000010eH0cYAF",
            Email: "jordan.rivera@initech.example",
            FirstName: "Jordan K",
            LastName: "Rivera",
            LeadSource: "Partner",
            Title: "Operations Lead",
          }),
        },
        300,
      );
      const row = await waitForApproval(gw, cx.ids.apiKey);

      // The title names the record the change lands in, by id (no read).
      expect(row.summary?.action).toBe(
        "Create Contact in Account 001QO000010eH0cYAF",
      );
      // The title split, so a card can render the record as the link and
      // drop the row it came from; no link over http.
      expect(row.summary?.subject).toEqual({
        verb: "Create Contact",
        lead: "Create Contact in ",
        record: "Account 001QO000010eH0cYAF",
        row: 4,
      });
      expect(row.summary?.details).toEqual([
        { label: "First name", value: "Jordan K" },
        { label: "Last name", value: "Rivera" },
        { label: "Email", value: "jordan.rivera@initech.example" },
        { label: "Title", value: "Operations Lead" },
        { label: "Account", value: "Account · 001QO000010eH0cYAF" },
        { label: "Lead source", value: "Partner" },
      ]);
      // Gateway-internal record state never reaches the wire.
      expect(row.summary).not.toHaveProperty("refs");
      expect(row.summary).not.toHaveProperty("target");
      expect(row.bodyPreview).toContain("Create Contact");
      expect(JSON.stringify(row)).not.toContain("e2e-sf-token");

      await decideApproval(gw, cx.ids.apiKey, row.id, "deny");
      const res = await held.response;
      expect(res.status).toBe(403);
    },
  );
});
