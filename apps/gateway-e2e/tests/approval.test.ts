import { describe, expect } from "vitest";

import {
  decideApproval,
  waitForApproval,
  waitForOrgApproval,
} from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/** How long to prove the socket is genuinely held before acting on it. */
const HOLD_MS = 300;

/** Rule + API key: everything the manual-approval flow needs. */
const APPROVAL_WORLD = {
  withApiKey: true,
  rules: [
    {
      name: "needs-approval",
      action: "allow" as const,
      requireApproval: true,
      targets: [{ hostPattern: "127.0.0.1" }],
    },
  ],
};

describe("manual approval", () => {
  scenario("holds the request and surfaces it for review", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(APPROVAL_WORLD);
    const gw = await cx.startGateway();

    // Correct behavior is no response bytes at all — the socket simply stays open.
    const held = await startHeldRequest(
      gw.origin,
      {
        method: "POST",
        url: upstream.url("/v1/send"),
        token: cx.ids.agentToken,
        body: "{}",
      },
      HOLD_MS,
    );

    const approval = await waitForApproval(gw, cx.ids.apiKey);
    expect(approval.url).toContain("/v1/send");
    // The reviewer must never be shown the agent's own credentials.
    expect(JSON.stringify(approval.headers)).not.toContain(cx.ids.agentToken);
    expect(approval.headers["authorization"]).toBeUndefined();
    expect(upstream.requests()).toHaveLength(0);

    await decideApproval(gw, cx.ids.apiKey, approval.id, "deny");
    await held.response;
  });

  scenario("resumes the original request when approved", async (cx) => {
    const upstream = await cx.upstream();
    upstream.respond({
      status: 200,
      body: JSON.stringify({ delivered: true }),
    });
    await cx.seed(APPROVAL_WORLD);
    const gw = await cx.startGateway();

    const held = await startHeldRequest(
      gw.origin,
      {
        method: "POST",
        url: upstream.url("/v1/send"),
        token: cx.ids.agentToken,
        body: "{}",
      },
      HOLD_MS,
    );
    const approval = await waitForApproval(gw, cx.ids.apiKey);

    const decision = await decideApproval(
      gw,
      cx.ids.apiKey,
      approval.id,
      "approve",
    );
    const res = await held.response;

    expect(decision.status).toBe(200);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ delivered: true });
    await upstream.waitForRequests(1);
  });

  scenario(
    "a released-SDK org watcher still decides via legacy projectId + X-Project-Id",
    async (cx) => {
      const upstream = await cx.upstream();
      upstream.respond({
        status: 200,
        body: JSON.stringify({ delivered: true }),
      });
      await cx.seed({ ...APPROVAL_WORLD, withOrgApiKey: true });
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: upstream.url("/v1/send"),
          token: cx.ids.agentToken,
          body: "{}",
        },
        HOLD_MS,
      );

      // The released SDK's exact shape: poll the ORG feed with a bare org key,
      // read `projectId` from the row, echo it as X-Project-Id on the decision.
      // Both halves of the rename compat (dual-emit + header alias) must hold
      // together, or every org approval auto-denies at the timeout.
      const row = await waitForOrgApproval(gw, cx.ids.orgApiKey);
      expect(row.projectId).toBe(cx.ids.workspace);
      expect(row.workspaceId).toBe(cx.ids.workspace);

      const decision = await decideApproval(
        gw,
        cx.ids.orgApiKey,
        row.id,
        "approve",
        { "x-project-id": cx.ids.workspace },
      );
      const res = await held.response;

      expect(decision.status).toBe(200);
      expect(res.status).toBe(200);
      await upstream.waitForRequests(1);
    },
  );

  scenario("forwards a body larger than the peek window intact", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(APPROVAL_WORLD);
    const gw = await cx.startGateway();

    // The gateway peeks only the first 16 KiB to build the review summary, then
    // chains the peeked bytes back onto the rest. A body past that boundary is
    // what proves the reassembly, rather than the peek being silently truncating.
    const body = JSON.stringify({
      pad: "x".repeat(40_000),
      marker: "tail-intact",
    });
    const held = await startHeldRequest(
      gw.origin,
      {
        method: "POST",
        url: upstream.url("/v1/send"),
        token: cx.ids.agentToken,
        body,
      },
      HOLD_MS,
    );
    const approval = await waitForApproval(gw, cx.ids.apiKey);
    await decideApproval(gw, cx.ids.apiKey, approval.id, "approve");
    await held.response;

    const [seen] = await upstream.waitForRequests(1);
    expect(seen?.body).toHaveLength(body.length);
    expect(seen?.body).toContain("tail-intact");
  });

  scenario("returns 403 to the agent when denied", async (cx) => {
    const upstream = await cx.upstream();
    await cx.seed(APPROVAL_WORLD);
    const gw = await cx.startGateway();

    const held = await startHeldRequest(
      gw.origin,
      {
        method: "POST",
        url: upstream.url("/v1/send"),
        token: cx.ids.agentToken,
        body: "{}",
      },
      HOLD_MS,
    );
    const approval = await waitForApproval(gw, cx.ids.apiKey);

    await decideApproval(gw, cx.ids.apiKey, approval.id, "deny");
    const res = await held.response;

    expect(res.status).toBe(403);
    expect(res.header("x-should-retry")).toBe("false");
    expect(res.json()).toMatchObject({
      error: "manual_approval_denied",
      approval_id: approval.id,
    });
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario("rejects a decision on an unknown approval id", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    const res = await decideApproval(
      gw,
      cx.ids.apiKey,
      "00000000-0000-4000-8000-000000000000",
      "approve",
    );

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "approval_not_found" });
  });

  scenario("requires a valid API key to list approvals", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    const res = await fetch(`${gw.origin}/v1/approvals/pending`, {
      headers: { authorization: "Bearer oc_not_a_real_key" },
    });

    expect(res.status).toBe(401);
    // Deliberately not also asserting that a valid key returns an empty list:
    // with nothing pending the endpoint long-polls for 30 seconds, and every
    // other test here already proves a valid key works.
  });
});
