import { describe, expect } from "vitest";

import { waitForApproval } from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * A held request the person's newer message SUPERSEDED, from the outside:
 * the control plane denies it with `reason: "superseded"`, and the agent's
 * held socket gets a 403 that says so (and tells it to read the newer
 * message), never the generic "declined". Driven over the wire against the
 * real binary and the licensed Redis store, like every approval test.
 */

const HOLD_MS = 300;

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

const decide = (origin: string, apiKey: string, id: string, body: unknown) =>
  fetch(`${origin}/v1/approvals/${id}/decision`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("superseded approval", () => {
  scenario(
    "a superseded deny reaches the agent as reason=superseded and never the upstream",
    async (cx) => {
      const upstream = await cx.upstream();
      await cx.seed(APPROVAL_WORLD);
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: upstream.url("/v1/accounts"),
          token: cx.ids.agentToken,
          body: "{}",
        },
        HOLD_MS,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);

      const decided = await decide(gw.origin, cx.ids.apiKey, approval.id, {
        decision: "deny",
        reason: "superseded",
      });
      expect(decided.status).toBe(200);

      const res = await held.response;
      expect(res.status).toBe(403);
      expect(res.header("x-should-retry")).toBe("false");
      const body = res.json() as { message: string };
      expect(body).toMatchObject({
        error: "manual_approval_denied",
        reason: "superseded",
        approval_id: approval.id,
      });
      expect(body.message).toContain("Read the user's latest message");
      expect(upstream.requests()).toHaveLength(0);
    },
  );

  scenario(
    "a reason never rides an approve, and an unknown reason is refused",
    async (cx) => {
      const upstream = await cx.upstream();
      upstream.respond({ status: 200, body: "{}" });
      await cx.seed(APPROVAL_WORLD);
      const gw = await cx.startGateway();

      const held = await startHeldRequest(
        gw.origin,
        {
          method: "POST",
          url: upstream.url("/v1/accounts"),
          token: cx.ids.agentToken,
          body: "{}",
        },
        HOLD_MS,
      );
      const approval = await waitForApproval(gw, cx.ids.apiKey);

      const approveWithReason = await decide(
        gw.origin,
        cx.ids.apiKey,
        approval.id,
        { decision: "approve", reason: "superseded" },
      );
      expect(approveWithReason.status).toBe(422);
      const unknown = await decide(gw.origin, cx.ids.apiKey, approval.id, {
        decision: "deny",
        reason: "because",
      });
      expect(unknown.status).toBe(422);

      // Neither refused call decided it: the request is still held, and a
      // plain approve still releases it.
      expect(upstream.requests()).toHaveLength(0);
      const plain = await decide(gw.origin, cx.ids.apiKey, approval.id, {
        decision: "approve",
      });
      expect(plain.status).toBe(200);
      expect((await held.response).status).toBe(200);
    },
  );

  scenario(
    "wait=0 answers the pending set at once instead of long-polling",
    async (cx) => {
      await cx.seed(APPROVAL_WORLD);
      const gw = await cx.startGateway();

      const started = Date.now();
      const res = await fetch(`${gw.origin}/v1/approvals/pending?wait=0`, {
        headers: { authorization: `Bearer ${cx.ids.apiKey}` },
      });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(((await res.json()) as { requests: unknown[] }).requests).toEqual(
        [],
      );
      // The default (no `wait`) holds an empty poll for 30s.
      expect(elapsed).toBeLessThan(5_000);
    },
  );
});
