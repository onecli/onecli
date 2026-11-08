import { expect } from "vitest";
import { scenario, type Cx } from "../src/scenario.js";
import { containerNameFor, dockerLogs } from "../src/docker.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fetchTranscript, runTurn, waitFor, type V1Client } from "../src/v1.js";

/**
 * Memory reviews end to end: the real api-server poll, a real runner and a
 * real sandbox container. What the pg suite cannot see: the review firing
 * through the poll, the excerpt reaching the harness on the context channel
 * (the fake harness's default answer echoes the prompt it was handed), each
 * review running on a fresh harness session, the box's idle clocks left
 * alone, and nothing delivered into the person's thread.
 *
 * Two reviews of one conversation, because only the second can tell a fresh
 * session from a kept one: the first review conversation holds no session
 * either way.
 */

const FIRST_STRETCH = [
  "our quarters close on the 25th",
  "a Strategic account has an exec sponsor",
  "call it the Renewal Owner field",
] as const;
const SECOND_STRETCH = [
  "renewals are owned by account managers",
  "draft every renewal email in British English",
  "the EMEA team works Sunday to Thursday",
] as const;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const say = async (
  v1: V1Client,
  conversationId: string,
  lines: readonly string[],
) => {
  for (const line of lines) {
    expect((await runTurn(v1, conversationId, line)).status).toBe("done");
  }
};

/** Move the person's turns and the box's idle clocks back past the review's
 * idle window, as a real quiet stretch moves them (the clocks stay inside
 * the park window, so the box is still running for the review). */
const goQuiet = async (cx: Cx, turnIds: string[], turnsAt: Date) => {
  const boxAt = minutesAgo(21);
  await cx.prisma.turn.updateMany({
    where: { id: { in: turnIds } },
    data: { createdAt: turnsAt, updatedAt: turnsAt },
  });
  await cx.prisma.sandbox.update({
    where: { id: cx.ids.sandbox },
    data: { lastActiveAt: boxAt, lastEngagedAt: boxAt },
  });
  return boxAt;
};

const awaitReview = async (cx: Cx, reviewedId: string, after: string[]) => {
  const review = await waitFor(
    () =>
      cx.prisma.turn.findFirst({
        where: {
          id: { notIn: after },
          source: "memory_review",
          conversation: {
            agentId: cx.ids.agent,
            source: "memory_review",
            externalRef: reviewedId,
          },
        },
        select: { id: true, status: true, conversationId: true },
      }),
    (turn) => turn !== null && ["done", "failed"].includes(turn.status),
    "a review turn to settle",
    120_000,
  );
  if (review === null) throw new Error("unreachable: no review turn");
  expect(review.status).toBe("done");
  return review;
};

/** The prompt the harness was handed: the fake answers with it. */
const promptOf = async (cx: Cx, turnId: string) =>
  JSON.stringify(
    (
      await cx.prisma.turnEvent.findFirstOrThrow({
        where: { turnId, type: "text" },
        orderBy: { seq: "desc" },
        select: { payload: true },
      })
    ).payload,
  );

const expectClocks = async (cx: Cx, at: Date) => {
  const box = await cx.prisma.sandbox.findUniqueOrThrow({
    where: { id: cx.ids.sandbox },
    select: { lastActiveAt: true, lastEngagedAt: true },
  });
  expect(box.lastActiveAt?.getTime()).toBe(at.getTime());
  expect(box.lastEngagedAt?.getTime()).toBe(at.getTime());
};

scenario(
  "each quiet stretch is reviewed once, on a fresh session, without holding the box up",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const personTurnIds = async () =>
      (
        await cx.prisma.turn.findMany({
          where: { conversationId: conversation.id },
          select: { id: true },
        })
      ).map((turn) => turn.id);

    // First stretch: the poll fires a review in its own hidden conversation.
    await say(stack.v1, conversation.id, FIRST_STRETCH);
    const firstIds = await personTurnIds();
    const firstClocks = await goQuiet(cx, firstIds, minutesAgo(25));
    const first = await awaitReview(cx, conversation.id, []);

    // The excerpt reached the harness on the context channel, framed as the
    // conversation to review, ahead of the stored instruction, which itself
    // carries none of the person's words.
    const firstPrompt = await promptOf(cx, first.id);
    expect(firstPrompt).toContain("[Conversation to review for memory");
    for (const line of FIRST_STRETCH) {
      expect(firstPrompt).toContain(`Person: ${line}`);
    }
    expect(firstPrompt).toContain("[Memory review");
    const stored = await cx.prisma.turn.findUniqueOrThrow({
      where: { id: first.id },
      select: { message: true },
    });
    for (const line of FIRST_STRETCH)
      expect(stored.message).not.toContain(line);

    // Not engagement: the review left the idle clocks where the quiet
    // stretch put them, so the park still comes on time.
    await expectClocks(cx, firstClocks);

    // Second stretch, after the first review (moved back so the new turns
    // can sit quiet AND postdate it).
    await cx.prisma.turn.update({
      where: { id: first.id },
      data: { createdAt: minutesAgo(24), updatedAt: minutesAgo(24) },
    });
    await say(stack.v1, conversation.id, SECOND_STRETCH);
    const secondIds = (await personTurnIds()).filter(
      (id) => !firstIds.includes(id),
    );
    const secondClocks = await goQuiet(cx, secondIds, minutesAgo(21));
    const second = await awaitReview(cx, conversation.id, [first.id]);
    expect(second.conversationId).toBe(first.conversationId);
    await expectClocks(cx, secondClocks);

    // Only what is new since the last review.
    const secondPrompt = await promptOf(cx, second.id);
    for (const line of SECOND_STRETCH) {
      expect(secondPrompt).toContain(`Person: ${line}`);
    }
    for (const line of FIRST_STRETCH) expect(secondPrompt).not.toContain(line);

    // A fresh harness session per review: the first one's session was let
    // go, so the second starts its own (a kept session would log no second
    // start), and neither resumes.
    const starts = (await dockerLogs(containerNameFor(cx.ids.sandbox)))
      .split("\n")
      .filter(
        (line) =>
          line.includes('"harness session started"') &&
          line.includes(first.conversationId),
      );
    expect(starts).toHaveLength(2);
    for (const start of starts) expect(start).toContain('"resumed":false');

    // Nothing delivered into the person's thread.
    const events = await fetchTranscript(stack.v1, conversation.id);
    expect(
      events.some((event) => [first.id, second.id].includes(event.turnId)),
    ).toBe(false);
    expect(await personTurnIds()).toHaveLength(
      FIRST_STRETCH.length + SECOND_STRETCH.length,
    );

    // Reviewed once per stretch: the next pass (30s throttle) finds nothing.
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    expect(
      await cx.prisma.turn.count({
        where: { conversationId: first.conversationId },
      }),
    ).toBe(2);

    await stack.runner.pausePump();
  },
  300_000,
);
