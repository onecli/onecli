import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, state } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * §3.9 sleep is the default state, end to end: an idle box PARKS (container
 * gone, home volume kept), the next message WAKES it, and the conversation
 * continues — `[state turnsRun=2]` is the durable-session proof, possible
 * only because the fake now persists its sessions on the home volume the way
 * jcode does (the CP re-sends `harnessSessionRef` after every wake).
 */

scenario("idle park keeps the volume, wake resumes the session", async (cx) => {
  const stack = await cx.startStack({
    apiEnv: { SANDBOX_IDLE_STOP_SECONDS: "1" },
  });
  if (stack.runner === null) throw new Error("runner expected");
  await seedTenant(cx.prisma, cx.ids);
  await seedHostedAgent(cx.prisma, cx.ids, { runnerId: stack.runner.runnerId });
  await seedAnthropicGrant(cx.prisma, cx.ids);
  stack.runner.pump();

  const conversation = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );

  const first = await runTurn(
    stack.v1,
    conversation.id,
    fakeDirective([state()]),
  );
  expect(first.status).toBe("done");
  const firstTranscript = transcriptText(
    await fetchTranscript(stack.v1, conversation.id),
  );
  expect(firstTranscript).toMatch(/\[state sessionRef=\S+ turnsRun=1\]/);

  // The 1s idle window passes and the pump's next poll claims the stop.
  const parked = await waitFor(
    () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
    (sandbox) => sandbox?.status === "stopped",
    "sandbox to park",
  );
  expect(parked?.homeRef).toBeTruthy();

  // Wake: just say something. Same conversation, same session, turn 2.
  const second = await runTurn(
    stack.v1,
    conversation.id,
    fakeDirective([state()]),
  );
  expect(second.status).toBe("done");
  const transcript = transcriptText(
    await fetchTranscript(stack.v1, conversation.id),
  );
  expect(transcript).toMatch(/\[state sessionRef=\S+ turnsRun=2\]/);

  await stack.runner.pausePump();
});
