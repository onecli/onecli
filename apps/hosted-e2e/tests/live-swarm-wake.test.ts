import { expect, test } from "vitest";
import { scenario, type Cx } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import {
  fetchTranscript,
  openStream,
  runTurn,
  transcriptText,
  waitFor,
  type TurnRow,
} from "../src/v1.js";

/**
 * THE SWARM-WAKE INCIDENT, REPLAYED ON THE FULL LOCAL STACK WITH A REAL
 * MODEL — real gateway (credential injection), real api-server, real runner,
 * a real sandbox container from the agent image (jcode v0.81.1 with
 * JCODE_WAKE_MODE=external), and a REAL Anthropic OAuth token.
 *
 * The incident (2026-08-25, cloud): a lead agent fanned out helpers,
 * promised "this will wake me", and the ranking was produced in an INVISIBLE
 * daemon self-wake turn — it never reached the chat. Fixed contract, proven
 * here end to end: the lead ends its turn with helpers outstanding, the
 * helpers finish, and ONE visible wake turn runs IN the lead conversation
 * carrying the deliverable, with real boundary events on the live stream.
 *
 * Twice env-gated on top of the suite's own config gate: it spends real
 * model tokens, so it never runs in CI —
 *
 *   E2E_ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-... \
 *   E2E_ADMIN_DATABASE_URL=... E2E_TEMPLATE_DB=... E2E_AGENT_IMAGE=... \
 *     pnpm --filter @onecli/hosted-e2e exec vitest run \
 *       tests/live-swarm-wake.test.ts --testTimeout=900000
 */
const OAUTH_TOKEN = process.env.E2E_ANTHROPIC_OAUTH_TOKEN;

const liveScenario = (name: string, body: (cx: Cx) => Promise<void>): void => {
  if (!OAUTH_TOKEN) {
    test.skip(name, () => undefined);
    return;
  }
  scenario(name, body);
};

/** Mark the seeded anthropic secret as an OAuth credential — the production
 * shape for a Claude subscription token: the sandbox gets the
 * CLAUDE_CODE_OAUTH_TOKEN placeholder and the gateway splices the real one. */
const markOauth = async (cx: Cx): Promise<void> => {
  await cx.prisma.secret.update({
    where: { id: `${cx.ids.workspace}-anthropic` },
    data: { metadata: { authMode: "oauth" } },
  });
};

liveScenario(
  "swarm fan-out: helpers finishing after the lead's turn wake ONE visible turn in the lead chat",
  async (cx) => {
    // Idle-stop pushed out so the sandbox never parks while helpers run
    // between turns — keep-awake covers it, this removes the flake margin.
    const stack = await cx.startStack({
      apiEnv: { SANDBOX_IDLE_STOP_SECONDS: "3600" },
    });
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
      harness: "jcode",
    });
    await seedAnthropicGrant(cx.prisma, cx.ids, { value: OAUTH_TOKEN });
    await markOauth(cx);
    stack.runner.pump();

    const lead = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    // The live tail opens BEFORE the wake exists — the boundary events must
    // FLOW to an attached consumer, not merely persist.
    const tap = await openStream(
      stack.api.origin,
      cx.ids.apiKey,
      cx.ids.workspace,
      lead.id,
    );
    try {
      // ---- The incident's exact shape: fan out, END THE TURN, let the
      // completion report arrive as a platform wake.
      const fanOut = await runTurn(
        stack.v1,
        lead.id,
        "Use your swarm tool to spawn exactly TWO helper agents now: " +
          "helper labeled 'alpha' with the task: reply with exactly " +
          "'SCORE: 7' and nothing else; helper labeled 'beta' with the " +
          "task: reply with exactly 'SCORE: 3' and nothing else. Then END " +
          "your turn immediately — do NOT wait for the helpers; their " +
          "completion is reported back to this chat automatically. Later, " +
          "when their completion is reported to you, compare the scores " +
          "and reply with one line containing exactly: " +
          "WINNER: <label of the higher score>",
        420_000,
      );
      expect(fanOut.status).toBe("done");

      // ---- The helpers finish → the wake fires IN the lead conversation.
      const turns = await waitFor(
        async () =>
          (
            await stack.v1.json<{ turns: TurnRow[] }>(
              await stack.v1.get(`/v1/conversations/${lead.id}/turns`),
            )
          ).turns,
        (rows) => rows.some((t) => t.source === "watch" && t.status === "done"),
        "the wake turn to run in the lead chat",
        420_000,
      );
      const wakes = turns.filter((t) => t.source === "watch");
      const wake = wakes.find((t) => t.status === "done");
      expect(wake).toBeDefined();
      expect(wake?.userId).toBeNull();

      // Let the wake turn(s) fully settle, then hold the incident's line:
      // nothing failed, and NO hidden per-watch conversation was minted.
      const settled = await waitFor(
        async () =>
          (
            await stack.v1.json<{ turns: TurnRow[] }>(
              await stack.v1.get(`/v1/conversations/${lead.id}/turns`),
            )
          ).turns,
        (rows) =>
          rows.every((t) => ["done", "failed", "aborted"].includes(t.status)),
        "every turn in the lead chat to settle",
        420_000,
      );
      expect(settled.filter((t) => t.status === "failed")).toHaveLength(0);
      expect(
        await cx.prisma.conversation.count({
          where: { agentId: cx.ids.agent, source: "watch" },
        }),
      ).toBe(0);

      // ---- THE DELIVERABLE reached the lead chat (pre-fix: silence). The
      // ranking may land in the first wake or a follow-up one (helpers can
      // finish across fire passes) — but it must be IN THIS conversation.
      const ranked = await waitFor(
        async () => transcriptText(await fetchTranscript(stack.v1, lead.id)),
        (text) => /WINNER:\s*alpha/i.test(text),
        "the ranking to arrive in the lead chat",
        420_000,
      );
      expect(ranked).toMatch(/WINNER:\s*alpha/i);

      // ---- THE VISIBILITY LAW: the wake turn carries real boundary events
      // in the durable transcript…
      const events = await fetchTranscript(stack.v1, lead.id);
      const wakeKinds = events
        .filter((e) => e.turnId === wake!.id)
        .map((e) => e.type);
      expect(wakeKinds).toContain("turn.started");
      expect(wakeKinds).toContain("turn.done");

      // …and they FLOWED live to the attached stream while it all happened.
      await tap.waitForFrame(
        (f) => f.data.turnId === wake!.id && f.data.type === "turn.done",
        "turn.done for the wake turn on the live stream",
        60_000,
      );

      // The wake resumed the LEAD's own session — no stranger session refs.
      const row = await cx.prisma.conversation.findUnique({
        where: { id: lead.id },
        select: { harnessSessionRef: true },
      });
      expect(row?.harnessSessionRef).toBeTruthy();
    } finally {
      await tap.close();
      await stack.runner.pausePump();
    }
  },
);
