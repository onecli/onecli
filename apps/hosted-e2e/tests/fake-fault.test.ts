import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, failNextStart } from "../src/fake-dsl.js";
import { runTurn } from "../src/v1.js";

/**
 * The dead-harness leg: a scripted launch failure (the fake's armed
 * fail-then-throw, the exact order of the real adapter's launch path) fails
 * the turn with readable copy instead of hanging it — and the conversation
 * recovers on a fresh container, because a dead harness means a dead box,
 * not a dead thread.
 */

scenario(
  "a harness that dies at launch fails the turn honestly, then recovers",
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

    // Turn 1 arms the one-shot launch failure (and completes normally).
    const arming = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([failNextStart("scripted harness death")]),
    );
    expect(arming.status).toBe("done");

    // Turn 2's session start dies. The turn must settle — failed or revived to
    // done on a respawned box — never hang to the ceiling.
    const doomed = await runTurn(
      stack.v1,
      conversation.id,
      "are you alive?",
      120_000,
    );
    expect(["failed", "done"]).toContain(doomed.status);

    // Whatever turn 2's outcome, the thread recovers.
    const recovered = await runTurn(stack.v1, conversation.id, "and now?");
    expect(recovered.status).toBe("done");

    await stack.runner.pausePump();
  },
);
