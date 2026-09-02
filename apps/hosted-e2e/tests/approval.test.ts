import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import { decideApproval, waitForApproval } from "../src/control.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, http } from "../src/fake-dsl.js";
import { fetchTranscript, runTurn, transcriptText } from "../src/v1.js";

/**
 * The approval hold, on the HOSTED path: the in-sandbox HTTP call hits a
 * `requireApproval` grant, the gateway parks the request mid-flight, a human
 * decides through the gateway's own control surface (an `oc_` key — the
 * gateway-e2e pattern), and the SAME held request then completes or is
 * refused. The sandbox side needs nothing special — undici's defaults
 * outlast the hold, which is invariant 4 doing its job.
 */

scenario("approve releases the held in-sandbox request", async (cx) => {
  const upstream = await cx.upstreamTls();
  const stack = await cx.startStack();
  if (stack.runner === null) throw new Error("runner expected");
  await seedTenant(cx.prisma, cx.ids);
  await seedHostedAgent(cx.prisma, cx.ids, { runnerId: stack.runner.runnerId });
  await seedAnthropicGrant(cx.prisma, cx.ids, {
    hostPattern: "127.0.0.1",
    requireApproval: true,
  });
  stack.runner.pump();

  const conversation = await stack.v1.json<{ id: string }>(
    await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
  );

  // The turn holds until the decision, so run it and decide concurrently.
  const turnPromise = runTurn(
    stack.v1,
    conversation.id,
    fakeDirective([
      http(`https://127.0.0.1:${upstream.port}/held`, {
        headers: { "x-api-key": "placeholder" },
        timeoutMs: 60_000,
      }),
    ]),
  );

  const approval = await waitForApproval(stack.gateway, cx.ids.apiKey, 60_000);
  // Nothing had reached the upstream while the request was held.
  expect(upstream.requests().length).toBe(0);
  const decision = await decideApproval(
    stack.gateway,
    cx.ids.apiKey,
    approval.id,
    "approve",
  );
  expect(decision.status).toBe(200);

  const turn = await turnPromise;
  expect(turn.status).toBe("done");
  const transcript = transcriptText(
    await fetchTranscript(stack.v1, conversation.id),
  );
  expect(transcript).toContain("[http 200]");
  expect(upstream.requests().length).toBe(1);

  await stack.runner.pausePump();
});

scenario(
  "deny refuses the held request; the turn still settles",
  async (cx) => {
    const upstream = await cx.upstreamTls();
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids, {
      hostPattern: "127.0.0.1",
      requireApproval: true,
    });
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const turnPromise = runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([
        http(`https://127.0.0.1:${upstream.port}/held`, {
          headers: { "x-api-key": "placeholder" },
          timeoutMs: 60_000,
        }),
      ]),
    );

    const approval = await waitForApproval(
      stack.gateway,
      cx.ids.apiKey,
      60_000,
    );
    await decideApproval(stack.gateway, cx.ids.apiKey, approval.id, "deny");

    // The agent's call fails, the TURN does not: the refusal is an answer the
    // model reads (a non-2xx echoed into the transcript), never a crash.
    const turn = await turnPromise;
    expect(turn.status).toBe("done");
    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(transcript).toMatch(/\[http (4\d\d|error)/);
    expect(upstream.requests().length).toBe(0);

    await stack.runner.pausePump();
  },
);
