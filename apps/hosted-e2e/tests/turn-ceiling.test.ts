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
 * The turn ceiling, end to end through a real sandbox: a run that outlives
 * its (scenario-tiny) wall-clock budget gets the wrap-up warning steered into
 * it, is then failed with the honest `turn_time_limit` copy, and — the part
 * the row alone cannot prove — the orphaned sandbox is actually STOPPED: the
 * sweep's abort flag rides the claim arm's failed leg to the supervisor,
 * whose late terminal report then has its sessionRef salvaged onto the
 * conversation. The salvage is the proof of the whole chain: it only exists
 * if the abort reached the sandbox and the real close came back after the
 * sweep had already won.
 */

scenario(
  "a turn that outlives the ceiling is warned, failed, and stopped",
  async (cx) => {
    const stack = await cx.startStack({
      // Scenario-tiny clocks: the warning window opens 10s in (30 − 20) and
      // the sweep lands at 30s. The window is deliberately WIDE — the ceiling
      // clock starts at the POST, and a real container boot eats the first
      // several seconds, so a tight window can close before the turn is even
      // `running` (which the warning arm requires). The stall arm stays at
      // its default — a live supervisor heartbeats, so it never fires here
      // (its proofs are pg-level).
      apiEnv: {
        TURN_CEILING_SECONDS: "30",
        TURN_CEILING_WARNING_SECONDS: "20",
      },
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

    // A run far longer than the ceiling: the sleeps are the runway, the
    // trailing text is the canary — it must never reach the transcript,
    // because the abort ends the run mid-sleep. Sleeps INTERLEAVED with tick
    // events, deliberately: the fake honours aborts and echoes steers only
    // at event boundaries, so a silent 60s sleep would defer both the
    // warning's echo and the abort to the very end — ticks every 3s are what
    // make "the warning joined mid-run" and "the abort cut it short"
    // observable at realistic times.
    const created = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${conversation.id}/turns`, {
        message: fakeDirective([
          ...Array.from({ length: 18 }, (_, i) => [
            sleep(3_000),
            text(`tick-${i} `),
          ]).flat(),
          text("never reached"),
        ]),
      }),
    );

    await waitFor(
      () => readTurn(stack.v1, conversation.id, created.id),
      (turn) => turn?.status === "running",
      "the long turn to start",
    );

    // The sweep fails it at the ceiling with the honest copy, not the red-box
    // prose — and the warning steered in before that.
    const settled = await waitFor(
      () => readTurn(stack.v1, conversation.id, created.id),
      (turn) => turn !== null && turn.status !== "running",
      "the ceiling to end the turn",
      60_000,
    );
    expect(settled?.status).toBe("failed");
    expect(settled?.errorCode).toBe("turn_time_limit");
    expect(settled?.error).toContain("reached its time limit");

    // The orphan was genuinely stopped, and its dying report was salvaged:
    // the abort flag was claimed off the failed row, and the late turn.result
    // (a fenced no-op for the row itself) still landed its sessionRef — the
    // resume handle the next turn needs.
    await waitFor(
      () =>
        cx.prisma.conversation.findUnique({
          where: { id: conversation.id },
          select: { harnessSessionRef: true },
        }),
      (row) => row?.harnessSessionRef != null,
      "the aborted run's session ref to be salvaged",
      30_000,
    );
    const row = await cx.prisma.turn.findUniqueOrThrow({
      where: { id: created.id },
      select: { abortRequested: true },
    });
    expect(row.abortRequested).toBe(false);

    // The transcript is read only NOW: deltas are live-only, and the durable
    // accumulated text lands when the abort ends the stream — which the
    // salvage above just proved happened. It must carry the warning's echo
    // (steered in mid-run) and must NOT carry the canary: the post-sleep
    // text never arrived, so the sandbox really did stop instead of
    // streaming into the failed row.
    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(transcript).toContain("approaching its time limit");
    expect(transcript).not.toContain("never reached");

    await stack.runner.pausePump();
  },
);
