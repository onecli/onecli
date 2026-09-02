import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, http } from "../src/fake-dsl.js";
import { fetchTranscript, runTurn, transcriptText } from "../src/v1.js";

/**
 * THE ZERO-CREDENTIAL PROOF, from the agent's own path: an HTTP call made
 * INSIDE the sandbox (the fake's `http` op rides the container's proxy env +
 * MITM CA, exactly as any agent traffic does) transits the per-test gateway,
 * which injects the granted anthropic key — witnessed on BOTH sides: the
 * stub upstream records the real secret in `x-api-key`, and the transcript
 * records the 200. No fake behavior can forge the stub-side witness.
 *
 * And door 1's negative: an agent with NO injectable key is answered in the
 * thread (`no_model_key`), and no sandbox ever starts for it.
 */

scenario(
  "the gateway injects the granted key into in-sandbox traffic",
  async (cx) => {
    const upstream = await cx.upstreamTls();
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    const secretValue = `sk-ant-e2e-${cx.ids.nonce}`;
    await seedAnthropicGrant(cx.prisma, cx.ids, {
      hostPattern: "127.0.0.1",
      value: secretValue,
    });
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    const turn = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([
        http(`https://127.0.0.1:${upstream.port}/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": "placeholder" },
          body: JSON.stringify({ probe: true }),
        }),
      ]),
    );
    expect(turn.status).toBe("done");

    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(transcript).toContain("[http 200]");

    // The wire-side witness: the header that reached the upstream is the REAL
    // secret — injected by the gateway, never present in the container.
    const requests = upstream.requests();
    expect(requests.length).toBe(1);
    expect(requests[0]?.headers["x-api-key"]).toBe(secretValue);

    await stack.runner.pausePump();
  },
);

scenario(
  "no injectable key: answered in-thread, no sandbox ever starts",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    // Deliberately NO grant: door 1 must answer at send time.
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const turn = await runTurn(stack.v1, conversation.id, "hello?");
    expect(turn.status).toBe("failed");
    expect(turn.errorCode).toBe("no_model_key");

    // No CONTAINER was ever spent on a turn that could only 401. The row may
    // read `failed` — door 2 PARKS an unstartable claim (the start arm claims
    // every unprovisioned box; the payload build refuses) — but the ref stays
    // null: nothing was created on the daemon.
    const sandbox = await cx.prisma.sandbox.findUnique({
      where: { id: cx.ids.sandbox },
    });
    expect(sandbox?.containerRef).toBeNull();

    await stack.runner.pausePump();
  },
);
