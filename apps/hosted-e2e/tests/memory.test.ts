import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import { containerNameFor, dockerExec, dockerKill } from "../src/docker.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { fakeDirective, sleep, text } from "../src/fake-dsl.js";
import { runTurn, waitFor } from "../src/v1.js";

/**
 * Memory write-back durability (step 8 through step 13's lens), harness-
 * agnostic by design: the harvester watches the FILESYSTEM, so a
 * `docker exec` write into `/workspace/memory/` is indistinguishable from an
 * agent's own — and the two laws the deleted dev script held are re-proven
 * here: an unsynced write survives a hard kill (the boot harvest), and a
 * human delete while parked stays deleted (the ledger's no-resurrection).
 */

interface MemoryRow {
  id: string;
  key: string;
}

scenario(
  "a file write is harvested; a hard kill cannot lose it",
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
    // Boot the box with an ordinary turn.
    const boot = await runTurn(stack.v1, conversation.id, "wake up");
    expect(boot.status).toBe("done");

    const container = containerNameFor(cx.ids.sandbox);
    await dockerExec(container, [
      "sh",
      "-c",
      "mkdir -p /workspace/memory && printf 'the sky was green today' > /workspace/memory/observation.md",
    ]);
    // KILL right away — whether the 1.5s harvester got there first or not, the
    // write must reach the platform: immediately, or via the next boot's
    // harvest off the durable volume. Either path is a pass; losing it is not.
    await dockerKill(container);

    // The next message respawns the box; the boot harvest delivers the file.
    await runTurn(stack.v1, conversation.id, "and again");
    const memories = await waitFor(
      async () =>
        (
          await stack.v1.json<{ memories: MemoryRow[] }>(
            await stack.v1.get(`/v1/agents/${cx.ids.agent}/memories`),
          )
        ).memories,
      (rows) => rows.some((row) => row.key === "observation"),
      "the harvested memory row",
      90_000,
    );
    expect(memories.some((row) => row.key === "observation")).toBe(true);

    await stack.runner.pausePump();
  },
);

scenario(
  "a human delete while parked is not resurrected by the next boot",
  async (cx) => {
    const stack = await cx.startStack({
      apiEnv: { SANDBOX_IDLE_STOP_SECONDS: "2" },
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
    // A LONG first turn: the write lands while the box is provably awake (an
    // active turn blocks the idle-stop claim), so the 1.5s-paced harvester
    // gets its window before the park.
    const holdOpen = stack.v1.post(
      `/v1/conversations/${conversation.id}/turns`,
      {
        message: fakeDirective([sleep(8_000), text("held the door open")]),
      },
    );
    const container = containerNameFor(cx.ids.sandbox);
    await waitFor(
      () =>
        dockerExec(container, ["true"]).then(
          () => true,
          () => false,
        ),
      (up) => up,
      "the container to come up",
    );
    await dockerExec(container, [
      "sh",
      "-c",
      "mkdir -p /workspace/memory && printf 'delete me later' > /workspace/memory/ephemeral.md",
    ]);
    await holdOpen;
    const harvested = await waitFor(
      async () =>
        (
          await stack.v1.json<{ memories: MemoryRow[] }>(
            await stack.v1.get(`/v1/agents/${cx.ids.agent}/memories`),
          )
        ).memories,
      (rows) => rows.some((row) => row.key === "ephemeral"),
      "the memory to be harvested",
    );
    const row = harvested.find((memory) => memory.key === "ephemeral");
    if (row === undefined) throw new Error("unreachable");

    // Park, then the human deletes while nothing is running.
    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "the box to park",
    );
    const deleted = await stack.v1.del(
      `/v1/agents/${cx.ids.agent}/memories/${row.id}`,
    );
    expect(deleted.ok).toBe(true);

    // Wake. The stale file on the volume must NOT re-mint the row: the ledger
    // remembers it was uploaded once, and the projection prunes it.
    await runTurn(stack.v1, conversation.id, "good morning");
    await new Promise((r) => setTimeout(r, 4_000)); // a full harvest cycle
    const after = await stack.v1.json<{ memories: MemoryRow[] }>(
      await stack.v1.get(`/v1/agents/${cx.ids.agent}/memories`),
    );
    expect(after.memories.some((memory) => memory.key === "ephemeral")).toBe(
      false,
    );

    await stack.runner.pausePump();
  },
);
