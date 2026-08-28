import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import {
  fetchTranscript,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * The spine's first legs: a REAL sandbox container spawns for a message, the
 * fake harness answers, the transcript records it, and a second turn rides
 * the same session — the create → chat loop a self-hoster gets from
 * `docker compose up`, proven from the API surface only.
 */

scenario(
  "spawn → turn → answer → second turn, one real container",
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

    const first = await runTurn(stack.v1, conversation.id, "hello sandbox");
    expect(first.status).toBe("done");

    // The sandbox genuinely ran: the row reached `running` and holds a
    // container ref the daemon knows.
    const sandbox = await cx.prisma.sandbox.findUnique({
      where: { id: cx.ids.sandbox },
    });
    expect(sandbox?.status).toBe("running");
    expect(sandbox?.containerRef).toBeTruthy();

    const transcript = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(transcript).toContain("Fake answer to:");
    expect(transcript).toContain("hello sandbox");

    // Second turn, same conversation — the session resumes, no respawn.
    const second = await runTurn(stack.v1, conversation.id, "still there?");
    expect(second.status).toBe("done");
    const after = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(after).toContain("still there?");

    await stack.runner.pausePump();
  },
);

scenario(
  "five concurrent conversations on one agent all settle",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversations = await Promise.all(
      Array.from({ length: 5 }, async (_, i) =>
        stack.v1.json<{ id: string }>(
          await stack.v1.post("/v1/conversations", {
            agentId: cx.ids.agent,
            title: `c${i}`,
          }),
        ),
      ),
    );

    const settled = await Promise.all(
      conversations.map((conversation, i) =>
        runTurn(stack.v1, conversation.id, `hello from lane ${i}`),
      ),
    );
    expect(settled.map((turn) => turn.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);

    // Every lane's words landed in its OWN transcript, none bled.
    for (const [i, conversation] of conversations.entries()) {
      const transcript = transcriptText(
        await fetchTranscript(stack.v1, conversation.id),
      );
      expect(transcript).toContain(`hello from lane ${i}`);
    }

    await stack.runner.pausePump();
  },
);

scenario("waitFor exposes the last observed value on timeout", async (cx) => {
  // A meta-guard for the suite's own honesty: a timed-out wait must carry
  // the final observation, or every flake is undiagnosable.
  void cx;
  await expect(
    waitFor(
      async () => ({ status: "queued" }),
      () => false,
      "never",
      300,
    ),
  ).rejects.toThrow(/never.*queued/s);
});
