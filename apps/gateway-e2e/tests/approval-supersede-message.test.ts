import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect } from "vitest";

import { waitForApproval } from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * THE ACCEPTANCE PATH for "a message that changes a held request replaces
 * it", end to end through the real pieces:
 *
 *   agent -> real gateway (held, licensed Redis store)
 *   person -> the control plane's real message door (`sendConversationMessage`)
 *          -> supersede check (real gateway list/deny with the person's key,
 *             the fast model stubbed as an Anthropic-shaped server)
 *          -> the agent's held socket answers 403 `superseded`
 *          -> transcript notice names the approval; audit row names the person
 *
 * and the negative twin: an unrelated message (the model answers KEEP)
 * leaves the request held, and a plain approve still releases it.
 *
 * One file per DB: `@onecli/db` binds DATABASE_URL once per process, and
 * vitest runs each file in its own fork, so this file owns its client.
 */

const HOLD_MS = 300;

/** An Anthropic-shaped stub: answers every /v1/messages with `answer`. */
const fakeAnthropic = async (
  answer: () => string,
): Promise<{
  origin: string;
  prompts: string[];
  close: () => Promise<void>;
}> => {
  const prompts: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        messages: { content: string }[];
      };
      prompts.push(body.messages[0]?.content ?? "");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: answer() }],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    prompts,
    close: () => new Promise((r) => server.close(() => r())),
  };
};

const eventually = async (check: () => Promise<boolean>, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met in time");
};

describe("a person's message supersedes a held request", () => {
  scenario(
    "REPLACE withdraws it as superseded; KEEP leaves it held",
    async (cx) => {
      // The judge writes one reasoning line, then its labeled answer.
      const CHANGE = "They ask for different values.\nVERDICT: CHANGE";
      const OTHER = "Unrelated question.\nVERDICT: OTHER";
      let verdict = CHANGE;
      const model = await fakeAnthropic(() => verdict);
      try {
        const upstream = await cx.upstream();
        upstream.respond({ status: 200, body: "{}" });
        await cx.seed({
          withApiKey: true,
          // The agent's own LLM key, granted, so the fast model resolves.
          secrets: [
            {
              type: "anthropic",
              hostPattern: "api.anthropic.com",
              value: "sk-ant-e2e",
            },
          ],
          grantAll: true,
          rules: [
            {
              name: "needs-approval",
              action: "allow" as const,
              requireApproval: true,
              targets: [{ hostPattern: "127.0.0.1" }],
            },
          ],
        });
        const gw = await cx.startGateway();

        // The control plane's process env, pointed at THIS scenario (its
        // edition is pinned suite-wide in vitest.config.ts).
        process.env.DATABASE_URL = cx.db.url;
        process.env.GATEWAY_INTERNAL_URL = gw.origin;
        process.env.ANTHROPIC_API_BASE_URL = model.origin;
        const { sendConversationMessage } =
          await import("@onecli/api/services/follow-up-service");

        // A person's direct thread with the agent, mid-run (the turn that
        // is waiting on the held request).
        const conversation = await cx.db.prisma.conversation.create({
          data: {
            agentId: cx.ids.agent,
            direct: true,
            userId: cx.ids.user,
            source: "web",
          },
        });
        const running = await cx.db.prisma.turn.create({
          data: {
            conversationId: conversation.id,
            status: "running",
            source: "web",
            userId: cx.ids.user,
            message: "create 5 accounts",
          },
        });

        // ── KEEP: an unrelated message leaves the request held ─────────
        verdict = OTHER;
        const keptHeld = await startHeldRequest(
          gw.origin,
          {
            method: "POST",
            url: upstream.url("/services/data/v62.0/composite/sobjects"),
            token: cx.ids.agentToken,
            body: '{"records":[{"Name":"Acme","BillingCity":"London"}]}',
          },
          HOLD_MS,
        );
        const kept = await waitForApproval(gw, cx.ids.apiKey);
        await sendConversationMessage(
          cx.ids.workspace,
          conversation.id,
          "what time is it?",
          { source: "web", userId: cx.ids.user },
        );
        await eventually(async () => model.prompts.length === 1);
        expect(model.prompts[0]).toContain("what time is it?");
        // Give the (fire-and-forget) check time to act if it wrongly would.
        await new Promise((r) => setTimeout(r, 1_000));
        const stillHeld = await Promise.race([
          keptHeld.response.then(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(true), 200)),
        ]);
        expect(stillHeld).toBe(true);
        expect(upstream.requests()).toHaveLength(0);
        // Still decidable by a person: approve releases it.
        await fetch(`${gw.origin}/v1/approvals/${kept.id}/decision`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${cx.ids.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ decision: "approve" }),
        });
        expect((await keptHeld.response).status).toBe(200);

        // ── REPLACE: a message that changes it withdraws it ────────────
        verdict = CHANGE;
        const held = await startHeldRequest(
          gw.origin,
          {
            method: "POST",
            url: upstream.url("/services/data/v62.0/composite/sobjects"),
            token: cx.ids.agentToken,
            body: '{"records":[{"Name":"Acme","BillingCity":"London"}]}',
          },
          HOLD_MS,
        );
        const approval = await waitForApproval(gw, cx.ids.apiKey);
        await sendConversationMessage(
          cx.ids.workspace,
          conversation.id,
          "can you change all Billing city to be NYC?",
          { source: "web", userId: cx.ids.user },
        );

        const res = await held.response;
        expect(res.status).toBe(403);
        expect(res.json()).toMatchObject({
          error: "manual_approval_denied",
          reason: "superseded",
          approval_id: approval.id,
        });
        // Only the first (approved) request ever reached the upstream.
        expect(upstream.requests()).toHaveLength(1);

        // ── The live shape: the agent said "Sent, will confirm" and its
        // turn CLOSED while the gateway still holds the call. The person's
        // next message opens a NEW turn; it must still replace the request.
        await cx.db.prisma.turn.updateMany({
          where: { conversationId: conversation.id },
          data: { status: "done" },
        });
        const lateHeld = await startHeldRequest(
          gw.origin,
          {
            method: "POST",
            url: upstream.url("/services/data/v62.0/composite/sobjects"),
            token: cx.ids.agentToken,
            body: '{"records":[{"Name":"Acme"}]}',
          },
          HOLD_MS,
        );
        const late = await waitForApproval(gw, cx.ids.apiKey);
        await sendConversationMessage(
          cx.ids.workspace,
          conversation.id,
          "actually add them with a lot of details",
          { source: "web", userId: cx.ids.user },
        );
        const lateRes = await lateHeld.response;
        expect(lateRes.status).toBe(403);
        expect(lateRes.json()).toMatchObject({
          reason: "superseded",
          approval_id: late.id,
        });
        expect(upstream.requests()).toHaveLength(1);

        // The transcript notice the web card reads, on the waiting turn.
        await eventually(async () => {
          const notice = await cx.db.prisma.turnEvent.findFirst({
            where: { conversationId: conversation.id, type: "notice" },
          });
          return (
            JSON.stringify(notice?.payload ?? {}).includes(approval.id) &&
            notice?.turnId === running.id
          );
        });
        // Audited under the PERSON, reason recorded, no values.
        await eventually(async () => {
          const row = await cx.db.prisma.auditLog.findFirst({
            where: { userId: cx.ids.user, action: "deny" },
          });
          return JSON.stringify(row?.metadata ?? {}).includes("superseded");
        });
      } finally {
        await model.close();
      }
    },
  );
});
