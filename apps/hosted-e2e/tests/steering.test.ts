import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, sleep, text } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  readTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * Mid-run steering, end to end: a message posted while a turn runs JOINS the
 * live run (the `[steered: …]` injection + the `message.joined` confirmation
 * in the transcript) instead of queueing behind it — the sleep step is the
 * runway the directive seam exists to provide, the thing the in-process
 * steering tests could reach only through a constructor option.
 */

scenario("a follow-up joins the live turn mid-run", async (cx) => {
  const stack = await cx.startStack();
  if (stack.runner === null) throw new Error("runner expected");
  await seedTenant(cx.prisma, cx.ids);
  await seedHostedAgent(cx.prisma, cx.ids, { runnerId: stack.runner.runnerId });
  await seedAnthropicGrant(cx.prisma, cx.ids);
  stack.runner.pump();

  const conversation = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );

  // A long turn: enough runway for the follow-up to arrive, claim, steer.
  const created = await stack.v1.json<{ id: string }>(
    await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
      message: fakeDirective([sleep(20_000), text("after the pause")]),
    }),
  );

  // Wait until the turn is genuinely RUNNING (the harness started), then
  // send the follow-up through the whatever-the-agent-is-doing door.
  await waitFor(
    () => readTurn(stack.v1, conversation.id, created.id),
    (turn) => turn?.status === "running",
    "the long turn to start",
  );
  const followUp = await stack.v1.post(
    `/v1/conversations/${conversation.id}/messages`,
    { message: "change of plan mid-flight" },
  );
  expect(followUp.ok).toBe(true);

  await waitFor(
    () => readTurn(stack.v1, conversation.id, created.id),
    (turn) => turn !== null && ["done", "failed"].includes(turn.status),
    "the steered turn to settle",
    90_000,
  );

  const transcript = transcriptText(
    await fetchTranscript(stack.v1, conversation.id),
  );
  expect(transcript).toContain("[steered: change of plan mid-flight]");
  expect(transcript).toContain("after the pause");

  await stack.runner.pausePump();
});
