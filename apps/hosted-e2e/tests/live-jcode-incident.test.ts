import { expect, test } from "vitest";
import { scenario, type Cx } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import {
  fetchTranscript,
  readTurn,
  runTurn,
  transcriptText,
  v1Client,
  waitFor,
  type V1Client,
} from "../src/v1.js";

/**
 * THE STUCK-SANDBOX INCIDENT, REPLAYED ON THE FULL LOCAL STACK WITH A REAL
 * MODEL — real gateway binary (credential injection), real api-server, real
 * runner, a real sandbox container from the agent image, the REAL jcode
 * harness, and a REAL Anthropic OAuth token spliced by the gateway (the
 * customer's exact zero-cred shape).
 *
 * Twice env-gated on top of the suite's own config gate: it spends real
 * model tokens, so it never runs in CI —
 *
 *   E2E_ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-... \
 *   E2E_ADMIN_DATABASE_URL=... E2E_TEMPLATE_DB=... E2E_AGENT_IMAGE=... \
 *     pnpm --filter @onecli/hosted-e2e exec vitest run \
 *       tests/live-jcode-incident.test.ts --testTimeout=900000
 *
 * The incident (2026-08-25, self-host): one long CI-watching turn; a second
 * conversation attached to its busy session; every message bounced silently
 * for 46 minutes; the finished answer was discarded. Scenario 1 is that
 * timeline with the FIXED expectations. Scenario 2 is the restart/resume
 * shape on the same live rig.
 */
const OAUTH_TOKEN = process.env.E2E_ANTHROPIC_OAUTH_TOKEN;

const liveScenario = (name: string, body: (cx: Cx) => Promise<void>): void => {
  if (!OAUTH_TOKEN) {
    test.skip(name, () => undefined);
    return;
  }
  scenario(name, body);
};

/** The tenant's SECOND member — the incident's "other channel" voice: a
 * different person addressing the same agent, which the platform models as
 * that person's own direct conversation. */
const seedSecondMember = async (cx: Cx): Promise<string> => {
  const userId = `${cx.ids.user}-b`;
  const email = `${userId}@e2e.invalid`;
  const apiKey = `${cx.ids.apiKey}b`;
  await cx.prisma.user.create({
    data: { id: userId, email, externalAuthId: userId },
  });
  await cx.prisma.organizationMember.create({
    data: {
      organizationId: cx.ids.org,
      userId,
      userEmail: email,
      role: "member",
    },
  });
  // The suite runs entitled (RBAC armed), so a plain member needs the
  // production-shape workspace binding for their key to pass the recheck.
  await cx.prisma.workspaceAccess.create({
    data: {
      workspaceId: cx.ids.workspace,
      userId,
    },
  });
  await cx.prisma.apiKey.create({
    data: {
      id: `${cx.ids.workspace}-key-b`,
      key: apiKey,
      scope: "workspace",
      workspaceId: cx.ids.workspace,
      userId,
      userEmail: email,
    },
  });
  return apiKey;
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

const noTurnFailed = async (
  v1: V1Client,
  conversationId: string,
): Promise<void> => {
  const body = await v1.json<{
    turns: { id: string; status: string; error?: string | null }[];
  }>(await v1.get(`/v1/conversations/${conversationId}/turns`));
  const failed = body.turns.filter((turn) => turn.status === "failed");
  expect(failed, JSON.stringify(failed)).toHaveLength(0);
};

liveScenario(
  "the incident timeline on a live agent: long turn + second voice + steer + abort",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
      harness: "jcode",
    });
    await seedAnthropicGrant(cx.prisma, cx.ids, { value: OAUTH_TOKEN });
    await markOauth(cx);
    const secondKey = await seedSecondMember(cx);
    stack.runner.pump();

    const conversationA = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    // ---- The customer's CI-watching turn: a long FOREGROUND local wait.
    const longTurn = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversationA.id}/turns`, {
        message:
          "Run this exact bash command in the foreground and wait for it " +
          "to finish (do NOT use background tasks or process tools): " +
          "`for i in $(seq 1 18); do sleep 5; done; echo CI-FINISHED-OK`. " +
          "This simulates watching a CI run. When it completes, reply with " +
          "one line containing exactly: CI-RESULT: CI-FINISHED-OK",
      }),
    );
    await waitFor(
      () => readTurn(stack.v1, conversationA.id, longTurn.id),
      (turn) => turn?.status === "running",
      "the long turn to start",
      180_000,
    );
    // Real tool activity, not just the claim: the bash call has begun.
    await waitFor(
      () => fetchTranscript(stack.v1, conversationA.id),
      (events) => events.some((event) => event.type === "tool.started"),
      "the long turn's bash call to start",
      180_000,
    );

    // ---- Mid-turn message in the SAME conversation (the user's "he sent
    // messages during the task"): rides a soft interrupt into the live run.
    const followUp = await stack.v1.post(
      `/v1/conversations/${conversationA.id}/messages`,
      {
        message:
          "Important mid-task update: include the word BANANA somewhere in " +
          "your final reply.",
      },
    );
    expect(followUp.ok).toBe(true);

    // ---- The second voice mid-turn (the incident's conversation B / the
    // other-channel mention): a DIFFERENT member's direct conversation with
    // the same agent, while the long turn is still running. Pre-fix this
    // attached to the busy session, stalled 60s on control-op timeouts, and
    // failed silently in the end.
    const memberB = v1Client(stack.api.origin, secondKey, cx.ids.workspace);

    const conversationB = await memberB.json<{ id: string }>(
      await memberB.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect(conversationB.id).not.toBe(conversationA.id);

    const bStarted = Date.now();
    const bTurn = await runTurn(
      memberB,
      conversationB.id,
      "Reply with one line containing exactly: HELLO-FROM-B",
      180_000,
    );
    const bMs = Date.now() - bStarted;
    expect(bTurn.status).toBe("done");
    // Pre-fix fingerprint: 60s of control-op timeouts before a silent death.
    // A fresh session applies preferences instantly; the budget below is
    // model latency only.
    expect(bMs).toBeLessThan(120_000);
    expect(
      transcriptText(await fetchTranscript(memberB, conversationB.id)),
    ).toContain("HELLO-FROM-B");

    // The long turn survived the second voice — the incident's core wreck.
    const midCheck = await readTurn(stack.v1, conversationA.id, longTurn.id);
    expect(midCheck?.status).toBe("running");

    // ---- The long turn completes and its answer is DELIVERED (pre-fix it
    // was discarded), with the steer folded in (pre-fix it was purged).
    const settled = await waitFor(
      () => readTurn(stack.v1, conversationA.id, longTurn.id),
      (turn) => turn !== null && turn.status !== "running",
      "the long turn to finish",
      420_000,
    );
    expect(settled?.status).toBe("done");
    const aTranscript = transcriptText(
      await fetchTranscript(stack.v1, conversationA.id),
    );
    expect(aTranscript).toContain("CI-RESULT: CI-FINISHED-OK");
    expect(aTranscript.toUpperCase()).toContain("BANANA");

    // Distinct sessions per conversation — the root fix, observed on the
    // live rows the incident corrupted.
    const rows = await cx.prisma.conversation.findMany({
      where: { id: { in: [conversationA.id, conversationB.id] } },
      select: { id: true, harnessSessionRef: true },
    });
    const refs = rows.map((row) => row.harnessSessionRef);
    expect(refs[0]).toBeTruthy();
    expect(refs[1]).toBeTruthy();
    expect(refs[0]).not.toBe(refs[1]);

    // ---- Stop actually stops: abort a second long turn mid-run, then the
    // session serves the next message (no orphan wedges it).
    const abortable = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversationA.id}/turns`, {
        message:
          "Run in the foreground: `for i in $(seq 1 60); do sleep 5; done; " +
          "echo NEVER`. Do not use background tasks. Reply when done.",
      }),
    );
    await waitFor(
      () => fetchTranscript(stack.v1, conversationA.id),
      (events) =>
        events.filter((event) => event.type === "tool.started").length >= 2,
      "the abortable turn's bash call to start",
      240_000,
    );
    const abortRes = await stack.v1.post(`/v1/turns/${abortable.id}/abort`);
    expect(abortRes.ok).toBe(true);
    const aborted = await waitFor(
      () => readTurn(stack.v1, conversationA.id, abortable.id),
      (turn) => turn !== null && turn.status !== "running",
      "the aborted turn to settle",
      120_000,
    );
    expect(aborted?.status).toBe("aborted");

    const afterAbort = await runTurn(
      stack.v1,
      conversationA.id,
      "Reply with one line containing exactly: OK-AFTER-ABORT",
      240_000,
    );
    expect(afterAbort.status).toBe("done");
    expect(
      transcriptText(await fetchTranscript(stack.v1, conversationA.id)),
    ).toContain("OK-AFTER-ABORT");

    // Nothing anywhere died silently.
    await noTurnFailed(stack.v1, conversationA.id);
    await noTurnFailed(memberB, conversationB.id);

    await stack.runner.pausePump();
  },
);

liveScenario(
  "restart/resume on a live agent: the session survives a park and wake",
  async (cx) => {
    // A short idle window so the sandbox genuinely parks between turns —
    // the wake then resumes the SAME jcode session by ref in a fresh
    // container (the restart shape the resume path exists for).
    const stack = await cx.startStack({
      apiEnv: { SANDBOX_IDLE_STOP_SECONDS: "3" },
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

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    const first = await runTurn(
      stack.v1,
      conversation.id,
      "Remember this codeword: PINEAPPLE-42. Reply with exactly: NOTED",
      240_000,
    );
    expect(first.status).toBe("done");

    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "the sandbox to park",
      120_000,
    );

    const second = await runTurn(
      stack.v1,
      conversation.id,
      "What was the codeword I told you earlier? Reply with one line " +
        "containing exactly: CODEWORD: <the codeword>",
      300_000,
    );
    expect(second.status).toBe("done");
    expect(
      transcriptText(await fetchTranscript(stack.v1, conversation.id)),
    ).toContain("PINEAPPLE-42");

    await noTurnFailed(stack.v1, conversation.id);
    await stack.runner.pausePump();
  },
);

liveScenario(
  "a barrage of mid-turn messages is never lost — every message gets consumed",
  async (cx) => {
    // The user's exact complaint: "he sent messages during the task and it
    // wasn't responding". Several messages land while a long turn runs; each
    // must either JOIN the live run or run as its own turn right after —
    // never a silent drop, never a failed row.
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
      harness: "jcode",
    });
    await seedAnthropicGrant(cx.prisma, cx.ids, { value: OAUTH_TOKEN });
    await markOauth(cx);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    const longTurn = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
        message:
          "Run this exact bash command in the foreground and wait (no " +
          "background tasks): `for i in $(seq 1 12); do sleep 5; done; echo " +
          "WATCH-DONE`. Then reply including exactly: WATCH-RESULT: WATCH-DONE",
      }),
    );
    await waitFor(
      () => fetchTranscript(stack.v1, conversation.id),
      (events) => events.some((event) => event.type === "tool.started"),
      "the long turn's bash call to start",
      240_000,
    );

    // The barrage: three distinct asks, seconds apart, all mid-turn.
    const asks = [
      "Also include the word APPLE in your final reply.",
      "Also include the word CHERRY in your final reply.",
      "And finally include the word MANGO in your final reply.",
    ];
    for (const message of asks) {
      const sent = await stack.v1.post(
        `/v1/conversations/${conversation.id}/messages`,
        { message },
      );
      expect(sent.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    // The long turn settles; then every barrage message must be consumed —
    // joined into the run, or promoted and run as its own turn.
    await waitFor(
      () => readTurn(stack.v1, conversation.id, longTurn.id),
      (turn) => turn !== null && turn.status !== "running",
      "the long turn to finish",
      420_000,
    );
    const settledTurns = await waitFor(
      async () => {
        const body = await stack.v1.json<{
          turns: { id: string; status: string }[];
        }>(await stack.v1.get(`/v1/conversations/${conversation.id}/turns`));
        return body.turns;
      },
      (turns) =>
        turns.every(
          (turn) =>
            !["queued", "dispatched", "running", "joining"].includes(
              turn.status,
            ),
        ),
      "every barrage message to settle",
      420_000,
    );

    const failed = settledTurns.filter((turn) => turn.status === "failed");
    expect(failed, JSON.stringify(failed)).toHaveLength(0);

    // Every word arrived SOMEWHERE in the conversation's answers — steered
    // into the long turn or answered by its own promoted turn.
    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    ).toUpperCase();
    expect(transcript).toContain("WATCH-RESULT: WATCH-DONE");
    for (const word of ["APPLE", "CHERRY", "MANGO"]) {
      expect(transcript, `missing ${word}`).toContain(word);
    }

    await stack.runner.pausePump();
  },
);

liveScenario(
  "two conversations' FIRST turns race a cold sandbox — one daemon, two sessions",
  async (cx) => {
    // The launch-memo race: a brand-new container receives two conversations
    // at once; both startSessions race ensureInstance. Exactly one daemon
    // may launch (a second launch yanks the live socket), and each
    // conversation must land on its own session.
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
      harness: "jcode",
    });
    await seedAnthropicGrant(cx.prisma, cx.ids, { value: OAUTH_TOKEN });
    await markOauth(cx);
    const secondKey = await seedSecondMember(cx);
    stack.runner.pump();

    const memberB = v1Client(stack.api.origin, secondKey, cx.ids.workspace);
    const conversationA = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const conversationB = await memberB.json<{ id: string }>(
      await memberB.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    const [turnA, turnB] = await Promise.all([
      runTurn(
        stack.v1,
        conversationA.id,
        "Reply with one line containing exactly: RACE-A-OK",
        300_000,
      ),
      runTurn(
        memberB,
        conversationB.id,
        "Reply with one line containing exactly: RACE-B-OK",
        300_000,
      ),
    ]);
    expect(turnA.status).toBe("done");
    expect(turnB.status).toBe("done");
    expect(
      transcriptText(await fetchTranscript(stack.v1, conversationA.id)),
    ).toContain("RACE-A-OK");
    expect(
      transcriptText(await fetchTranscript(memberB, conversationB.id)),
    ).toContain("RACE-B-OK");

    const rows = await cx.prisma.conversation.findMany({
      where: { id: { in: [conversationA.id, conversationB.id] } },
      select: { harnessSessionRef: true },
    });
    expect(rows[0]?.harnessSessionRef).toBeTruthy();
    expect(rows[1]?.harnessSessionRef).toBeTruthy();
    expect(rows[0]?.harnessSessionRef).not.toBe(rows[1]?.harnessSessionRef);

    await stack.runner.pausePump();
  },
);
