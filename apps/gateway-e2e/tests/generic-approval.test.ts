import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

const approvalWorld = (host: string) => ({
  withApiKey: true,
  rules: [
    {
      name: "review writes",
      action: "allow" as const,
      requireApproval: true,
      targets: [{ hostPattern: host }],
    },
  ],
});

/** The buffered telemetry writer is asynchronous, including on denial. */
const waitForLog = async (
  cx: Cx,
  approvalId: string,
  decision: "approval_pending" | "approval_denied",
) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await cx.db.prisma.requestLog.findMany({
      where: { extraData: { path: ["approval_id"], equals: approvalId } },
    });
    const row = rows[0];
    const extra = row?.extraData;
    if (
      row &&
      extra &&
      typeof extra === "object" &&
      "decision" in extra &&
      extra.decision === decision
    ) {
      expect(rows).toHaveLength(1);
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no ${decision} request log for ${approvalId}`);
};

describe("generic approval cards over the wire", () => {
  scenario(
    "a dedicated Zoom card keeps its telemetry classification",
    async (cx) => {
      await cx.seed({
        ...approvalWorld("api.zoom.us"),
        appConnections: [
          {
            provider: "zoom",
            label: "hermetic@example.test",
            credentials: {
              access_token: "e2e-zoom-token",
              refresh_token: "e2e-zoom-refresh",
              token_type: "Bearer",
              expires_at: 4_102_444_800,
            },
          },
        ],
      });
      const gw = await cx.startGateway();
      // Plain HTTP avoids record enrichment. Denial prevents provider access.
      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: "http://api.zoom.us/v2/users/me/meetings",
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Hermetic review", duration: 30 }),
        },
        300,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);
      expect(approval.summary?.kind).toBe("event");
      const pending = await waitForLog(cx, approval.id, "approval_pending");
      expect(pending.extraData).toMatchObject({ card: "dedicated" });
      await decideApproval(gw, cx.ids.apiKey, approval.id, "deny");
      expect((await held.response).status).toBe(403);
      const denied = await waitForLog(cx, approval.id, "approval_denied");
      expect(denied.id).toBe(pending.id);
      expect(denied.extraData).toMatchObject({ card: "dedicated" });
    },
  );
  scenario(
    "multipart stays opaque and raw body masks credentials",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(approvalWorld("127.0.0.1"));
      const gw = await cx.startGateway();
      const password = "multipart-secret-sentinel";
      const body = `--E2E\r\nContent-Disposition: form-data; name="password"\r\n\r\n${password}\r\n--E2E--\r\n`;
      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: upstream.url("/v1/uploads"),
          token: cx.ids.agentToken,
          headers: { "content-type": "multipart/form-data; boundary=E2E" },
          body,
        },
        300,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);
      expect(approval.summary?.details).toContainEqual({
        label: "Body",
        value: `multipart form, ${String(Buffer.byteLength(body))} B`,
      });
      expect(JSON.stringify(approval.summary)).not.toContain(password);

      // control.ts intentionally exposes only the typed readable-card fields.
      // Inspect the raw poll payload as unknown, without inventing a wire type.
      const response = await fetch(`${gw.origin}/v1/approvals/pending`, {
        headers: { authorization: `Bearer ${cx.ids.apiKey}` },
      });
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      expect(payload).toMatchObject({
        requests: [
          {
            id: approval.id,
            rawBody: { text: expect.stringContaining("***") },
          },
        ],
      });
      expect(JSON.stringify(payload)).not.toContain(password);
      expect(upstream.requests()).toHaveLength(0);

      const pending = await waitForLog(cx, approval.id, "approval_pending");
      expect(pending.extraData).toMatchObject({ card: "generic" });
      expect(
        (await decideApproval(gw, cx.ids.apiKey, approval.id, "deny")).status,
      ).toBe(200);
      expect((await held.response).status).toBe(403);
      const denied = await waitForLog(cx, approval.id, "approval_denied");
      expect(denied.id).toBe(pending.id);
      expect(denied.extraData).toMatchObject({ card: "generic" });
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "query credentials are masked while safe query values remain visible",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(approvalWorld("127.0.0.1"));
      const gw = await cx.startGateway();
      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: upstream.url(
            "/v1/search?password=query-password-sentinel&api_key=query-key-sentinel&query=red%20shoes",
          ),
          token: cx.ids.agentToken,
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        300,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);
      expect(approval.summary?.details).toContainEqual({
        label: "Query",
        value: "red shoes",
      });
      expect(approval.summary?.details).toContainEqual({
        label: "Password",
        value: "***",
      });
      expect(approval.summary?.details).toContainEqual({
        label: "Api key",
        value: "***",
      });
      const summary = JSON.stringify(approval.summary);
      expect(summary).toContain("***");
      expect(summary).not.toContain("query-password-sentinel");
      expect(summary).not.toContain("query-key-sentinel");
      await decideApproval(gw, cx.ids.apiKey, approval.id, "deny");
      expect((await held.response).status).toBe(403);
      expect(upstream.requests()).toHaveLength(0);
    },
  );
});
