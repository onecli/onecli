import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";
import type { Cx } from "../src/scenario.js";

/**
 * What an APPROVED request actually did, recorded for the person who
 * approved it. Once, "Create 9 Accounts" was approved in Slack,
 * Salesforce answered 200 and created none of them, and the agent's fixed
 * resend then looked like a mystery second approval. The gateway now reads
 * the head of the upstream's answer and records the verdict on the
 * approval's request-log row (`extra_data.approval_result`), which the
 * control plane serves to the cards.
 *
 * The agent's own response is untouched: it still reads the upstream's bytes
 * exactly as sent.
 */

const HOLD_MS = 300;

const WORLD = {
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

/** Approve one held POST and return what the agent got back. */
const approveOne = async (cx: Cx, answer: { status: number; body: string }) => {
  const upstream = await cx.upstream();
  upstream.respond({
    status: answer.status,
    headers: { "content-type": "application/json" },
    body: answer.body,
  });
  await cx.seed(WORLD);
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
  await decideApproval(gw, cx.ids.apiKey, approval.id, "approve");
  const res = await held.response;
  return { approval, res };
};

/** The approval's request-log row once its result has landed. */
const resultOf = async (cx: Cx, approvalId: string) => {
  for (let i = 0; i < 50; i++) {
    const rows = await cx.db.prisma.requestLog.findMany({
      where: { extraData: { path: ["approval_id"], equals: approvalId } },
      select: { extraData: true },
    });
    const extra = rows[0]?.extraData;
    if (
      extra &&
      typeof extra === "object" &&
      "approval_result" in extra &&
      "decision" in extra &&
      extra.decision === "approval_approved"
    ) {
      return extra.approval_result;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no approval_result for ${approvalId}`);
};

describe("an approved request's real result", () => {
  scenario(
    "an upstream refusal is recorded with its message, and the agent gets the bytes as sent",
    async (cx) => {
      const body = JSON.stringify({ message: "Validation Failed" });
      const { approval, res } = await approveOne(cx, { status: 422, body });
      expect(res.status).toBe(422);
      expect(res.body).toBe(body);
      expect(await resultOf(cx, approval.id)).toEqual({
        ok: false,
        error: "Validation Failed",
        // The card's own title, for the result's verb.
        action: "POST request",
      });
    },
  );

  scenario("a plain success is recorded as ok", async (cx) => {
    const { approval, res } = await approveOne(cx, {
      status: 201,
      body: JSON.stringify({ id: "acc_1" }),
    });
    expect(res.status).toBe(201);
    expect(await resultOf(cx, approval.id)).toEqual({
      ok: true,
      action: "POST request",
    });
  });
});
