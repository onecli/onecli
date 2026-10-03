import { connect as netConnect } from "node:net";
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

/** Inject only into this scenario's decision key. Never stop or flush Redis. */
const pushDecisionPayload = (
  host: string,
  port: string,
  key: string,
  payload: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = netConnect({ host, port: Number(port) });
    let reply = "";
    socket.setTimeout(5_000, () =>
      socket.destroy(new Error("Redis LPUSH timed out")),
    );
    socket.on("error", reject);
    socket.on("close", () =>
      reject(new Error("Redis closed before acknowledging LPUSH")),
    );
    socket.on("connect", () => {
      const args = ["LPUSH", key, payload];
      socket.write(
        `*${String(args.length)}\r\n${args.map((arg) => `$${String(Buffer.byteLength(arg))}\r\n${arg}\r\n`).join("")}`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      if (!reply.includes("\r\n")) return;
      if (/^:\d+\r\n$/.test(reply)) resolve();
      else reject(new Error("Redis did not acknowledge the scoped LPUSH"));
      socket.end();
    });
  });

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

  scenario(
    "an agent's batch tag groups the card and never reaches the upstream",
    async (cx) => {
      const upstream = await cx.upstream();
      upstream.respond({ status: 200, body: "{}" });
      await cx.seed(APPROVAL_WORLD);
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: upstream.url("/v1/contacts"),
          token: cx.ids.agentToken,
          headers: {
            "X-OneCLI-Batch": "import-7",
            "X-OneCLI-Batch-Label": " Add 3\tcontacts ",
            "X-OneCLI-Batch-Total": "3",
          },
          body: "{}",
        },
        HOLD_MS,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);
      // Parsed and sanitized onto the card (the label is one line)...
      expect(approval.batch).toEqual({
        id: "import-7",
        label: "Add 3 contacts",
        total: 3,
      });

      await decideApproval(gw, cx.ids.apiKey, approval.id, "approve");
      expect((await held.response).status).toBe(200);
      // ...and stripped before forwarding: they are for OneCLI only.
      const [forwarded] = await upstream.waitForRequests(1);
      expect(
        Object.keys(forwarded?.headers ?? {}).filter((h) =>
          h.startsWith("x-onecli-batch"),
        ),
      ).toEqual([]);
    },
  );

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
      reason: "declined",
      approval_id: approval.id,
    });
    expect(upstream.requests()).toHaveLength(0);
  });

  scenario(
    "fails closed on a malformed Redis decision and allows a fresh approval",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(APPROVAL_WORLD);
      const gw = await cx.startGateway();
      const request = {
        method: "POST",
        url: upstream.url("/v1/send"),
        token: cx.ids.agentToken,
        body: JSON.stringify({ text: "Review me" }),
      };
      const held = await startHeldRequest(gw.origin, request, HOLD_MS);
      const original = await waitForApproval(gw, cx.ids.apiKey);
      const sentinel = "invalid-decision-must-not-be-logged";
      await pushDecisionPayload(
        cx.config.redisHost,
        cx.config.redisPort,
        `approval:decision:${cx.ids.org}:${cx.ids.workspace}:${original.id}`,
        JSON.stringify({ decision: "invalid", sensitive: sentinel }),
      );
      const failed = await held.response;
      expect(failed.status).toBe(502);
      expect(failed.header("x-should-retry")).toBe("false");
      expect(failed.json()).toMatchObject({
        error: "approval_store_unavailable",
        approval_id: original.id,
        message: expect.stringContaining("request was not forwarded"),
      });
      expect(failed.json()).not.toHaveProperty("reason");
      expect(failed.body).not.toContain(sentinel);
      expect(gw.logs()).not.toContain(sentinel);
      expect(upstream.requests()).toHaveLength(0);
      expect(
        (await decideApproval(gw, cx.ids.apiKey, original.id, "approve"))
          .status,
      ).toBe(404);

      // A new user-directed request is a new hold, not a replay of this decision.
      const again = await startHeldRequest(gw.origin, request, HOLD_MS);
      const fresh = await waitForApproval(gw, cx.ids.apiKey);
      expect(fresh.id).not.toBe(original.id);
      expect(upstream.requests()).toHaveLength(0);
      expect(
        (await decideApproval(gw, cx.ids.apiKey, fresh.id, "approve")).status,
      ).toBe(200);
      expect((await again.response).status).toBe(200);
      const seen = await upstream.waitForRequests(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.body).toBe(request.body);
    },
  );

  for (const revised of [false, true]) {
    scenario(
      `requires fresh approval after decline (${revised ? "revised" : "unchanged"} body)`,
      async (cx) => {
        const upstream = await cx.upstream();
        await cx.seed(APPROVAL_WORLD);
        const gw = await cx.startGateway();
        const original = JSON.stringify({ text: "Hello, David!" });
        const body = revised ? JSON.stringify({ text: "Hi David." }) : original;
        const request = {
          method: "POST",
          url: upstream.url("/v1/send"),
          token: cx.ids.agentToken,
          body: original,
        };
        const first = await startHeldRequest(gw.origin, request, HOLD_MS);
        const declined = await waitForApproval(gw, cx.ids.apiKey);
        await decideApproval(gw, cx.ids.apiKey, declined.id, "deny");
        expect((await first.response).status).toBe(403);
        expect(upstream.requests()).toHaveLength(0);

        // Simulates a new user-directed send, not an automatic HTTP retry.
        const second = await startHeldRequest(
          gw.origin,
          { ...request, body },
          HOLD_MS,
        );
        const pending = await waitForApproval(gw, cx.ids.apiKey);
        expect(pending.id).not.toBe(declined.id);
        expect(upstream.requests()).toHaveLength(0);
        const stale = await decideApproval(
          gw,
          cx.ids.apiKey,
          declined.id,
          "approve",
        );
        expect(stale.status).toBe(404);
        expect(upstream.requests()).toHaveLength(0);

        await decideApproval(gw, cx.ids.apiKey, pending.id, "approve");
        expect((await second.response).status).toBe(200);
        const seen = await upstream.waitForRequests(1);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.body).toBe(body);
      },
    );
  }

  scenario("rejects a decision on an unknown approval id", async (cx) => {
    await cx.seed({ withApiKey: true });
    const gw = await cx.startGateway();

    const unknownId = "00000000-0000-4000-8000-000000000000";
    const res = await decideApproval(gw, cx.ids.apiKey, unknownId, "approve");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "approval_not_found" });

    // The rejection must be investigable from the log line alone: the
    // approval id and decision ride on the EVENT, not only on the enclosing
    // INFO span (which a WARN-only filter drops — #1074).
    await gw.waitForLog("approval decision rejected: no pending approval");
    const line = gw
      .logs()
      .split("\n")
      .find((l) =>
        l.includes("approval decision rejected: no pending approval"),
      );
    expect(line).toBeDefined();
    expect(line).toContain(`"approval_id":"${unknownId}"`);
    expect(line).toContain('"decision":"approve"');
  });

  scenario(
    "answers a re-submitted decision with 404 after the first one settled",
    async (cx) => {
      // The production shape behind #1074: a client re-sends its decision
      // (~when its local timeout fires) after the gateway already honoured
      // it. The held request was released on the FIRST decision; the second
      // finds nothing pending. 404 is correct — the same answer the web and
      // channel clients map to "already settled" — and the log names the id
      // so the two events can be joined instead of read as a lost click.
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

      const first = await decideApproval(
        gw,
        cx.ids.apiKey,
        approval.id,
        "approve",
      );
      const res = await held.response;
      expect(first.status).toBe(200);
      expect(res.status).toBe(200);
      await upstream.waitForRequests(1);

      const again = await decideApproval(
        gw,
        cx.ids.apiKey,
        approval.id,
        "approve",
      );
      expect(again.status).toBe(404);
      expect(again.body).toMatchObject({ error: "approval_not_found" });
      // The upstream saw the request exactly once: a re-submit never
      // re-forwards.
      expect(upstream.requests()).toHaveLength(1);

      await gw.waitForLog("approval decision rejected: no pending approval");
      const lines = gw.logs().split("\n");
      const withMessage = (message: string) =>
        lines.find((l) => l.includes(`"message":"${message}"`));
      // Both halves of the join are present under the same id: the honoured
      // decision and the late re-submit.
      expect(withMessage("approval decision submitted")).toContain(
        `"approval_id":"${approval.id}"`,
      );
      expect(
        withMessage(
          "approval decision rejected: no pending approval (expired, already decided, or unknown)",
        ),
      ).toContain(`"approval_id":"${approval.id}"`);
    },
  );

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
