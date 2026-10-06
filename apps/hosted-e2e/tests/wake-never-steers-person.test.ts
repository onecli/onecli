import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, sleep, text, tool } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  readTurn,
  runTurn,
  transcriptText,
  waitFor,
  type TurnRow,
} from "../src/v1.js";

/**
 * A wake never steers into a person's exchange, end to end (live
 * 2026-10-03: a CI watch fired while the agent answered an unrelated
 * question, the wake joined that answer, and the platform's instruction was
 * mirrored into the person's Slack DM as if they had typed it).
 *
 * The person's turn is still RUNNING when the watched job exits. The wake
 * must not ride that turn as a follow-up: the person's answer stays theirs,
 * and the wake arrives afterwards as its own visible turn.
 */

scenario(
  "a watch that fires during the person's running turn waits, then arrives as its own turn",
  async (cx) => {
    const stack = await cx.startStack({
      apiEnv: { SANDBOX_IDLE_STOP_SECONDS: "3600" },
    });
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const lead = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );

    // Turn 1: a short job, and a watch on it whose prompt is a directive so
    // the wake's own answer is recognizable.
    const start = await runTurn(
      stack.v1,
      lead.id,
      fakeDirective([
        tool("process_start", { command: "sleep 5; echo done", name: "ci" }),
        text("started"),
      ]),
    );
    expect(start.status).toBe("done");
    const proc = await waitFor(
      () =>
        cx.prisma.sandboxProcess.findFirst({
          where: { sandboxId: cx.ids.sandbox, name: "ci" },
          select: { ref: true },
        }),
      (row) => row !== null,
      "the job to mirror",
    );
    const arm = await runTurn(
      stack.v1,
      lead.id,
      fakeDirective([
        tool("process_watch", {
          processId: proc!.ref,
          kind: "exit",
          prompt: fakeDirective([text("CI REPORT")]),
        }),
        text("watch armed"),
      ]),
    );
    expect(arm.status).toBe("done");

    // Turn 3: the PERSON asks something long-running; the job exits while
    // this turn is still running.
    const asked = await stack.v1.json<{ id: string }>(
      await stack.v1.post(`/v1/conversations/${lead.id}/turns`, {
        message: fakeDirective([sleep(20_000), text("DISK ANSWER")]),
      }),
    );
    await waitFor(
      () => readTurn(stack.v1, lead.id, asked.id),
      (turn) => turn?.status === "running",
      "the person's turn to start",
    );
    await waitFor(
      () =>
        cx.prisma.processWatch.findFirst({
          where: { originConversationId: lead.id },
          select: { status: true },
        }),
      (watch) => watch?.status === "triggered" || watch?.status === "fired",
      "the watched job to exit while the person's turn runs",
      60_000,
    );

    // Settle the PERSON's turn first: before the fix the wake joined it
    // here (a `joined` watch row hanging off this turn), so no standalone
    // wake ever ran and waiting for one only timed out.
    const person = await waitFor(
      () => readTurn(stack.v1, lead.id, asked.id),
      (turn) => turn !== null && ["done", "failed"].includes(turn.status),
      "the person's turn to settle",
      90_000,
    );
    expect(person?.status).toBe("done");
    expect(
      await cx.prisma.turn.count({ where: { followUpOfTurnId: asked.id } }),
    ).toBe(0);

    // The wake then runs as its own top-level turn, after the person's.
    await waitFor(
      async () =>
        (
          await stack.v1.json<{ turns: TurnRow[] }>(
            await stack.v1.get(`/v1/conversations/${lead.id}/turns`),
          )
        ).turns,
      (rows) => rows.some((t) => t.source === "watch" && t.status === "done"),
      "the wake to run as its own turn",
      180_000,
    );
    const rows = await cx.prisma.turn.findMany({
      where: { conversationId: lead.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, source: true, userId: true, followUpOfTurnId: true },
    });
    const wakes = rows.filter((row) => row.source === "watch");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ userId: null, followUpOfTurnId: null });
    expect(rows.findIndex((row) => row.id === wakes[0]!.id)).toBeGreaterThan(
      rows.findIndex((row) => row.id === asked.id),
    );

    const transcript = transcriptText(await fetchTranscript(stack.v1, lead.id));
    expect(transcript).toContain("DISK ANSWER");
    expect(transcript).toContain("CI REPORT");
    expect(transcript).not.toContain("[steered: [Watch on process");

    await stack.runner.pausePump();
  },
);
