import type { PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, tool } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * §3.9 keep-awake as ENGAGEMENT, end to end, through real containers.
 *
 * The incident behind this suite: a background process that merely EXISTS
 * (an idle server, a forgotten `sleep`) held its box awake for days. The
 * rule now: a process holds the box only while it is BUSY (output inside
 * the idle window, or CPU above a small threshold, as the supervisor reads
 * from the guest's /proc), and an idle one is PARKED like any quiet box,
 * with a quiet notice in the chat and no wake turn. The ceiling eviction
 * still bounds the busy ones. The precise SQL laws live in the pg suites;
 * this proves the whole path — tool call → local execute → CPU/output
 * sampling → process frames → keep-awake → park/notice — in real boxes.
 */

/** An idle process: alive, listening, printing nothing, burning nothing. */
const IDLE = "sleep 300";
/** A busy one: a tight loop that never prints. CPU is the only signal. */
const BUSY = "while :; do :; done";

/**
 * The supervisor's CPU probe needs two samples (one tick apart, ~2s) before
 * it can say busy, and the verdict then rides a frame to the control plane.
 * A box whose idle window is shorter than that can reach the stop arm first
 * (production's 30-minute window never can), so the busy scenarios run a
 * window wider than two ticks and assert the hold only once the verdict is
 * in; the idle scenario keeps the 1s window, since nothing there is busy.
 */
const BUSY_IDLE_WINDOW = { SANDBOX_IDLE_STOP_SECONDS: "4" };
const waitBusy = (prisma: PrismaClient, sandboxId: string) =>
  waitFor(
    () =>
      prisma.sandboxProcess.findFirst({
        where: { sandboxId, status: "running" },
        select: { cpuBusy: true },
      }),
    (row) => row?.cpuBusy === true,
    "the busy verdict to land",
  );

scenario(
  "an IDLE background process no longer holds the box: it parks, the chat gets a notice, nothing wakes the agent",
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
      fakeDirective([tool("process_start", { command: IDLE, name: "server" })]),
    );
    expect(turn.status).toBe("done");
    const process = await waitFor(
      () =>
        cx.prisma.sandboxProcess.findFirst({
          where: { sandboxId: cx.ids.sandbox, status: "running" },
          select: { id: true },
        }),
      (row) => row !== null,
      "the process row to mirror",
    );

    // The turn-end safety net armed a PLATFORM watch on it: the one that
    // used to hold the box for its 24h expiry.
    await waitFor(
      () =>
        cx.prisma.processWatch.findFirst({
          where: { processId: process!.id, status: "armed" },
          select: { origin: true },
        }),
      (watch) => watch?.origin === "platform",
      "the safety-net watch",
    );

    // The box PARKS past the idle window, with the park's own reason…
    const parked = await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "the idle box to park",
      60_000,
    );
    expect(parked?.stopReason).toBe("idle");

    // …its process reads PARKED (not lost), the watch fires as `parked`…
    await waitFor(
      () =>
        cx.prisma.processWatch.findFirst({
          where: { processId: process!.id },
          select: { status: true, trigger: true },
        }),
      (watch) => watch?.status === "fired",
      "the parked watch to settle",
    );
    expect(
      (
        await cx.prisma.sandboxProcess.findUniqueOrThrow({
          where: { id: process!.id },
          select: { status: true },
        })
      ).status,
    ).toBe("parked");

    // …as ONE born-done notice in the chat, and NO wake: the box stays
    // parked (the old restart loop started with exactly this wake).
    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(transcript).toContain("was put to sleep");
    expect(
      await cx.prisma.conversation.count({
        where: { agentId: cx.ids.agent, source: "watch" },
      }),
    ).toBe(0);
    await new Promise((r) => setTimeout(r, 4_000));
    expect(
      (
        await cx.prisma.sandbox.findUniqueOrThrow({
          where: { id: cx.ids.sandbox },
        })
      ).status,
    ).toBe("stopped");

    await stack.runner.pausePump();
  },
);

scenario(
  "a BUSY background process (CPU, no output) holds the box awake past idle-stop",
  async (cx) => {
    const stack = await cx.startStack({ apiEnv: BUSY_IDLE_WINDOW });
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
      fakeDirective([tool("process_start", { command: BUSY, name: "crunch" })]),
    );
    expect(turn.status).toBe("done");

    // The supervisor's CPU probe reads the loop from /proc and the frame
    // carries the verdict to the control plane.
    await waitBusy(cx.prisma, cx.ids.sandbox);

    // The box SURVIVES well past the idle window: keep-awake.
    await new Promise((r) => setTimeout(r, 10_000));
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
      apiEnv: { ...BUSY_IDLE_WINDOW, MAX_HELD_AWAKE_SANDBOXES: "1" },
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
      tool("process_start", { command: BUSY, name: "holder" }),
    ]);

    // Box A first (the OLDER idle clock), then box B.
    const conversationA = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    expect((await runTurn(stack.v1, conversationA.id, holdPlan)).status).toBe(
      "done",
    );
    await waitBusy(cx.prisma, cx.ids.sandbox);
    await new Promise((r) => setTimeout(r, 1_500));
    const conversationB = await v1B.json<{ id: string }>(
      await v1B.put(`/v1/agents/${cx.ids.secondAgent}/conversations/direct`),
    );
    expect((await runTurn(v1B, conversationB.id, holdPlan)).status).toBe(
      "done",
    );
    await waitBusy(cx.prisma, cx.ids.secondSandbox);

    // Ceiling 1, two held boxes: the OLDER (A) loses the exemption; B stays.
    const evicted = await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "the oldest held box to be evicted",
      60_000,
    );
    expect(evicted?.stopReason).toBe("evict");
    const survivor = await cx.prisma.sandbox.findUnique({
      where: { id: cx.ids.secondSandbox },
    });
    expect(survivor?.status).toBe("running");

    await stack.runner.pausePump();
  },
);
