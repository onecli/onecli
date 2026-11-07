import { describe, expect } from "vitest";

import { decideApproval, waitForApproval } from "../src/control.js";
import { compiledGrantStack } from "../src/fixtures.js";
import { startForwardProxy } from "../src/forward-proxy.js";
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

/** Approve one held POST and return what the agent got back. A credential
 * is injected when asked, so a 4xx reaches the card instead of the gateway's
 * own "no credential" guidance. */
const approveOne = async (
  cx: Cx,
  answer: {
    status: number;
    body: string;
    headers?: Record<string, string>;
    withSecret?: boolean;
  },
) => {
  const upstream = await cx.upstream();
  upstream.respond({
    status: answer.status,
    headers: { "content-type": "application/json", ...answer.headers },
    body: answer.body,
  });
  await cx.seed({
    ...WORLD,
    ...(answer.withSecret && {
      grantAll: true,
      secrets: [
        { hostPattern: "127.0.0.1", headerName: "x-test-key", value: "k-1" },
      ],
    }),
  });
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
        action: "Create account",
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
      action: "Create account",
    });
  });

  scenario(
    "a 403 worded as a rate limit keeps its words outside a GitHub App connection",
    async (cx) => {
      // GitHub's masked wording with quota left. Only a `github-app`
      // connection's refusal is re-read as a permission problem; any other
      // upstream says what it said, and the agent always gets the bytes.
      const body = JSON.stringify({ message: "Rate Limit Exceeded" });
      const { approval, res } = await approveOne(cx, {
        status: 403,
        body,
        headers: { "x-ratelimit-remaining": "4997" },
        withSecret: true,
      });
      expect(res.status).toBe(403);
      expect(res.body).toBe(body);
      expect(await resultOf(cx, approval.id)).toEqual({
        ok: false,
        error: "Rate Limit Exceeded",
        action: "Create account",
      });
    },
  );

  scenario(
    "a GitHub App connection's masked 403 is recorded as a permission refusal, and the agent gets GitHub's bytes",
    async (cx) => {
      // What GitHub answers an installation token creating a repository on
      // the personal /user/repos path: 403 "Rate Limit Exceeded" with its
      // quota untouched. Hermetic: api.github.com is the local forward proxy.
      const masked = JSON.stringify({ message: "Rate Limit Exceeded" });
      const proxy = await startForwardProxy({
        respond: () => ({
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4997",
          },
          body: masked,
        }),
      });
      try {
        await cx.seed({
          withApiKey: true,
          appConnections: [{ provider: "github-app", label: "acme" }],
          // An unlisted write: "All other writes" holds it for approval.
          rules: compiledGrantStack("github-app", ["get_repo"], {
            otherReads: "allow",
          }),
        });
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });
        const held = await startHeldRequest(
          gw.origin,
          {
            method: "POST",
            url: "http://api.github.com/user/repos",
            token: cx.ids.agentToken,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "e2e" }),
          },
          HOLD_MS,
        );
        const approval = await waitForApproval(gw, cx.ids.apiKey);
        await decideApproval(gw, cx.ids.apiKey, approval.id, "approve");
        const res = await held.response;
        expect(res.status).toBe(403);
        expect(res.body).toBe(masked);
        expect(await resultOf(cx, approval.id)).toMatchObject({
          ok: false,
          error:
            "Not permitted: the app's access doesn't allow this (not a rate limit)",
        });
      } finally {
        await proxy.close();
      }
    },
  );
});
