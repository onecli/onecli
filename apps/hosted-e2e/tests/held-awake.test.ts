import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, tool } from "../src/fake-dsl.js";
import { runTurn, waitFor } from "../src/v1.js";

/**
 * §3.9 keep-awake + the step-13 ceiling, END TO END: a real background
 * process (started through the platform-tool channel — the fake's `tool` op
 * dials the same socket the MCP bridge does) holds a box out of idle-stop;
 * over the operator ceiling, the oldest-idle held box is evicted while the
 * newest survives. The precise SQL laws live in the pg suites; this proves
 * the whole path — tool call → local execute → process rows → keep-awake →
 * eviction — through real containers.
 */

scenario(
  "a live background process holds the box awake past idle-stop",
  async (cx) => {
    const stack = await cx.startStack({
      apiEnv: { SANDBOX_IDLE_STOP_SECONDS: "1" },
    });
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
    const turn = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([
        tool("process_start", { command: "sleep 300", name: "watcher" }),
      ]),
    );
    expect(turn.status).toBe("done");

    // The process row reached the control plane…
    await waitFor(
      () =>
        cx.prisma.sandboxProcess.findFirst({
          where: { sandboxId: cx.ids.sandbox, status: "running" },
        }),
      (row) => row !== null,
      "the process row to mirror",
    );

    // …and the box SURVIVES well past the 1s idle window: keep-awake.
    await new Promise((r) => setTimeout(r, 6_000));
    const sandbox = await cx.prisma.sandbox.findUnique({
      where: { id: cx.ids.sandbox },
    });
    expect(sandbox?.status).toBe("running");

    // The signal reads true at every level the dashboard consumes.
    const agents = await stack.v1.json<
      Array<{ id: string; workingInBackground?: boolean }>
    >(await stack.v1.get("/v1/agents"));
    expect(
      agents.find((agent) => agent.id === cx.ids.agent)?.workingInBackground,
    ).toBe(true);

    await stack.runner.pausePump();
  },
);

scenario(
  "over the ceiling, the oldest-idle held box is evicted (LRU)",
  async (cx) => {
    const stack = await cx.startStack({
      apiEnv: {
        SANDBOX_IDLE_STOP_SECONDS: "1",
        MAX_HELD_AWAKE_SANDBOXES: "1",
      },
    });
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids, "first");
    await seedTenant(cx.prisma, cx.ids, "second");
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
      which: "first",
    });
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
      which: "second",
    });
    await seedAnthropicGrant(cx.prisma, cx.ids, { which: "first" });
    await seedAnthropicGrant(cx.prisma, cx.ids, { which: "second" });
    stack.runner.pump();

    const v1B = cx.v1For(stack.api.origin, "second");
    const holdPlan = fakeDirective([
      tool("process_start", { command: "sleep 300", name: "holder" }),
    ]);

    // Box A first (the OLDER idle clock), then box B.
    const conversationA = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversationA.id, holdPlan)).status).toBe(
      "done",
    );
    await new Promise((r) => setTimeout(r, 1_500));
    const conversationB = await v1B.json<{ id: string }>(
      await v1B.put(`/v1/agents/${cx.ids.secondAgent}/conversations/direct`),
    );
    expect((await runTurn(v1B, conversationB.id, holdPlan)).status).toBe(
      "done",
    );

    // Ceiling 1, two held boxes: the OLDER (A) loses the exemption; B stays.
    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "the oldest held box to be evicted",
      60_000,
    );
    const survivor = await cx.prisma.sandbox.findUnique({
      where: { id: cx.ids.secondSandbox },
    });
    expect(survivor?.status).toBe("running");

    await stack.runner.pausePump();
  },
);
