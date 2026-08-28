import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, text, tool } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  openStream,
  runTurn,
  transcriptText,
  waitFor,
  type TurnRow,
} from "../src/v1.js";

/**
 * THE WAKE-DELIVERY CONTRACT, end to end (the production incident's shape,
 * deterministic on the fake harness): work outstanding when a turn ends is
 * net-watched, its completion fires ONE visible wake turn INSIDE the lead
 * conversation (resuming that conversation's own session — not a hidden
 * per-watch conversation with a stranger session), and the wake announces
 * itself with real boundary events on the LIVE stream, so an open client
 * renders it without any refetch trigger.
 *
 * Pre-fix, this exact flow was: N hidden wake conversations, event-invisible
 * delivery rows, and the actual deliverable produced in a turn nobody could
 * see — "the ranking never arrived".
 */

scenario(
  "work left running at turn end wakes ONE visible turn in the lead chat, with live boundary events",
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

    // The live tail opens BEFORE the wake exists — proving the boundary
    // events FLOW to an attached consumer, not merely persist.
    const tap = await openStream(
      stack.api.origin,
      cx.ids.apiKey,
      cx.ids.workspace,
      lead.id,
    );
    try {
      // The lead "fans out" (one background job standing in for the batch)
      // and ends its turn — the incident's exact shape.
      const leadTurn = await runTurn(
        stack.v1,
        lead.id,
        fakeDirective([
          tool("process_start", {
            command: "sleep 4; echo RANK-A-7-B-3",
            name: "ranker",
          }),
          text("fanned out; ending my turn"),
        ]),
      );
      expect(leadTurn.status).toBe("done");

      // The turn-end net armed a watch ANCHORED TO THE LEAD CHAT.
      const armed = await waitFor(
        () =>
          cx.prisma.processWatch.findMany({
            where: { originConversationId: lead.id },
            select: { status: true, kind: true },
          }),
        (rows) => rows.length === 1,
        "the turn-end net to arm one watch on the lead chat",
        60_000,
      );
      expect(armed[0]?.kind).toBe("exit");

      // The job finishes → the wake fires IN the lead conversation.
      const turns = await waitFor(
        async () =>
          (
            await stack.v1.json<{ turns: TurnRow[] }>(
              await stack.v1.get(`/v1/conversations/${lead.id}/turns`),
            )
          ).turns,
        (rows) => rows.some((t) => t.source === "watch" && t.status === "done"),
        "the wake turn to run in the lead chat",
        180_000,
      );
      const wake = turns.find((t) => t.source === "watch");
      expect(wake).toBeDefined();
      expect(wake?.userId).toBeNull();
      // ONE wake turn, not one per watch; and nothing left hanging.
      expect(turns.filter((t) => t.source === "watch")).toHaveLength(1);
      expect(
        turns.filter((t) => !["done", "failed", "aborted"].includes(t.status)),
      ).toHaveLength(0);

      // No hidden per-watch conversation was minted.
      expect(
        await cx.prisma.conversation.count({
          where: { agentId: cx.ids.agent, source: "watch" },
        }),
      ).toBe(0);

      // The RESULT reached the lead chat (pre-fix: silence). The fake echoes
      // its wake message, which embeds the job's output excerpt.
      const transcript = transcriptText(
        await fetchTranscript(stack.v1, lead.id),
      );
      expect(transcript).toContain("RANK-A-7-B-3");

      // THE VISIBILITY LAW: the wake turn's transcript carries real
      // boundary events…
      const events = await fetchTranscript(stack.v1, lead.id);
      const wakeKinds = events
        .filter((e) => e.turnId === wake!.id)
        .map((e) => e.type);
      expect(wakeKinds).toContain("turn.started");
      expect(wakeKinds).toContain("text");
      expect(wakeKinds).toContain("turn.done");

      // …and they FLOWED live to the attached stream.
      await tap.waitForFrame(
        (f) => f.data.turnId === wake!.id && f.data.type === "turn.done",
        "turn.done for the wake turn on the live stream",
        30_000,
      );
    } finally {
      await tap.close();
      await stack.runner.pausePump();
    }
  },
);

scenario(
  "an explicitly armed watch delivers its EXACT scripted answer into the lead chat",
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

    // Turn 1: start the job. Turn 2: arm a watch whose prompt is ITSELF a
    // scripted directive — the fired wake turn's message embeds the prompt,
    // the fake finds the directive line, and the wake's answer is exact.
    const start = await runTurn(
      stack.v1,
      lead.id,
      fakeDirective([
        tool("process_start", { command: "sleep 6; echo done", name: "job" }),
        text("started"),
      ]),
    );
    expect(start.status).toBe("done");

    const proc = await waitFor(
      () =>
        cx.prisma.sandboxProcess.findFirst({
          where: { sandboxId: cx.ids.sandbox, name: "job" },
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
          prompt: fakeDirective([text("RANKING: helper-b > helper-a")]),
        }),
        text("watch armed"),
      ]),
    );
    expect(arm.status).toBe("done");

    const turns = await waitFor(
      async () =>
        (
          await stack.v1.json<{ turns: TurnRow[] }>(
            await stack.v1.get(`/v1/conversations/${lead.id}/turns`),
          )
        ).turns,
      (rows) => rows.some((t) => t.source === "watch" && t.status === "done"),
      "the scripted wake to run in the lead chat",
      180_000,
    );
    expect(turns.filter((t) => t.source === "watch")).toHaveLength(1);

    const transcript = transcriptText(await fetchTranscript(stack.v1, lead.id));
    expect(transcript).toContain("RANKING: helper-b > helper-a");

    await stack.runner.pausePump();
  },
);
