import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * Held Zoom, Google Sheets and Google Drive writes read as what they do,
 * not as a JSON blob or a URL of ids: a meeting reads as an event, a cell
 * write lists each range and its values, a Drive change names its file
 * (and an empty-trash call says so).
 *
 * Hermetic: plain http, so the gateway makes no name read and builds no
 * link; the cards keep their ids. The reads are unit-tested against a local
 * upstream (`proxy::approval_enrich`). Every held request is DENIED, so
 * nothing egresses.
 */
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdE";
const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";

const connection = (provider: string) => ({
  provider,
  label: "jane@acme.example",
  credentials: {
    access_token: `e2e-${provider}-token`,
    refresh_token: `e2e-${provider}-refresh`,
    token_type: "Bearer",
    expires_at: 4_102_444_800,
  },
});

const approvalFor = (connectionIndex: number, tools: string[]) => ({
  name: `writes need approval ${connectionIndex}`,
  action: "allow" as const,
  requireApproval: true,
  source: "grant" as const,
  priority: connectionIndex + 1,
  identities: ["agent"] as const,
  targets: [{ kind: "connection" as const, connectionIndex, tools }],
});

const WORLD = {
  withApiKey: true,
  appConnections: [
    connection("zoom"),
    connection("google-sheets"),
    connection("google-drive"),
  ],
  rules: [
    approvalFor(0, ["create_meeting"]),
    approvalFor(1, ["batch_update_values"]),
    approvalFor(2, ["delete_file"]),
  ],
};

describe("zoom, sheets and drive approval cards (wire-level)", () => {
  scenario("each held write reads as what it does", async (cx) => {
    await cx.seed(WORLD);
    const gw = await cx.startGateway();

    const cases = [
      {
        method: "POST",
        url: "http://api.zoom.us/v2/users/me/meetings",
        body: {
          topic: "Pipeline review",
          start_time: "2026-10-12T15:00:00",
          timezone: "America/New_York",
          duration: 45,
          password: "e2e-passcode",
          settings: { meeting_invitees: [{ email: "sam@example.com" }] },
        },
        action: /Zoom meeting/,
        kind: "event",
      },
      {
        method: "POST",
        url: `http://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchUpdate`,
        body: {
          valueInputOption: "USER_ENTERED",
          data: [
            { range: "Sheet1!C5", values: [[4200]] },
            {
              range: "Budget!A1:B2",
              values: [
                ["Item", "Cost"],
                ["Ads", 90],
              ],
            },
          ],
        },
        action: new RegExp(`spreadsheet ${SHEET}`),
        kind: undefined,
      },
      {
        method: "DELETE",
        url: `http://www.googleapis.com/drive/v3/files/${FILE}`,
        body: undefined,
        action: new RegExp(`delete file ${FILE}`),
        kind: undefined,
      },
      // The same `delete_file` rule holds Drive's empty-trash call: it reads
      // as what it does, never as deleting a file called "trash".
      {
        method: "DELETE",
        url: "http://www.googleapis.com/drive/v3/files/trash",
        body: undefined,
        action: /Drive trash/,
        kind: undefined,
      },
    ];

    // The headline only: each card's full rows are pinned through the same
    // `summarize_request` entry point by the `summary::{zoom,google_sheets,
    // google_drive}` unit tests. What only the wire shows is that the right
    // summarizer runs for the connection's host on the approval path, the
    // `kind` the web picks its card by, and that no secret rides along.
    for (const c of cases) {
      const held = await startHeldRequest(
        gw.origin,
        {
          method: c.method,
          url: c.url,
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: c.body === undefined ? undefined : JSON.stringify(c.body),
        },
        300,
      );
      const row = await waitForApproval(gw, cx.ids.apiKey);
      expect(row.summary?.action).toMatch(c.action);
      expect(row.summary?.kind).toBe(c.kind);
      // No secret reaches the card: not the passcode, not the credential.
      const wire = JSON.stringify(row);
      expect(wire).not.toContain("e2e-passcode");
      expect(wire).not.toMatch(/e2e-[a-z-]+-token/);

      await decideApproval(gw, cx.ids.apiKey, row.id, "deny");
      expect((await held.response).status).toBe(403);
    }
  });
});
