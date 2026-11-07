import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { contextTokens, fakeDirective } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * Context sizing end to end: the real api-server poll runs the context-fit
 * job, and the size it picks rides the next turn's delivery through the real
 * runner into a real sandbox, where the fake harness echoes what it was
 * handed. What the pg suite cannot see: the job firing on the poll, and the
 * size crossing every hop (claim, runner wire, supervisor, harness).
 *
 * The full-context history is seeded: the fake's own turns report no usage,
 * and a real model filling 200k five times is what the live suites are for.
 */

const FULL_TURN_TOKENS = 190_000;

scenario(
  "the platform grows a conversation that keeps filling its context, and the next turn runs at the new size",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    // The workspace's own key: no platform limit applies to the size.
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    // Before any evidence: the turn carries no size (the harness default).
    const before = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([contextTokens()]),
    );
    expect(before.status).toBe("done");

    // Five turns that each nearly filled the default 200k.
    const now = Date.now();
    await cx.prisma.turn.createMany({
      data: Array.from({ length: 5 }, (_, i) => {
        const at = new Date(now - (5 - i) * 1000);
        return {
          conversationId: conversation.id,
          message: `full ${i}`,
          source: "web",
          status: "done",
          createdAt: at,
          updatedAt: at,
          finishedAt: at,
          usage: {
            inputTokens: 10,
            outputTokens: 200,
            cacheReadInputTokens: FULL_TURN_TOKENS - 10,
            promptTokens: FULL_TURN_TOKENS,
          },
        };
      }),
    });

    // The poll's next context-fit pass (30 s throttle) grows it one rung.
    const sized = await waitFor(
      () =>
        cx.prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
          select: { contextTokens: true, contextTokensChangedAt: true },
        }),
      (row) => row.contextTokens !== null,
      "the context-fit job to size the conversation",
      90_000,
    );
    expect(sized.contextTokens).toBe(1_000_000);
    expect(sized.contextTokensChangedAt).not.toBeNull();

    // Audited as the platform, never as a person.
    const audit = await cx.prisma.auditLog.findMany({
      where: { serviceActor: "context-fit" },
      select: { actorKind: true, metadata: true },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorKind).toBe("service");
    expect(audit[0]?.metadata).toMatchObject({
      conversationId: conversation.id,
      contextTokens: 1_000_000,
      previousContextTokens: null,
    });

    // The next turn carries the new size all the way into the harness.
    const after = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([contextTokens()]),
    );
    expect(after.status).toBe("done");

    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(transcript).toContain("[contextTokens none]");
    expect(transcript).toContain("[contextTokens 1000000]");

    await stack.runner.pausePump();
  },
  240_000,
);
