import { describe, expect, it, vi } from "vitest";
import type {
  RunnerEvent,
  RunnerMemoryWriteResponse,
  SupervisorMessage,
} from "@onecli/agent-protocol";
import {
  createSupervisorMessageHandler,
  MAX_INFLIGHT_MEMORY_WRITES_PER_SANDBOX,
} from "./supervisor-messages";

/**
 * The supervisor→control-plane mapping. Its interesting cases are the ones a
 * healthy sandbox never reaches, which is exactly why they are worth pinning.
 */

interface DriveOptions {
  toolCall?: (
    sandboxId: string,
    call: Extract<SupervisorMessage, { kind: "tool.call" }>,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  memoryWrite?: (
    sandboxId: string,
    write: Extract<SupervisorMessage, { kind: "memory.write" }>,
  ) => Promise<RunnerMemoryWriteResponse>;
  /** Step 10: the runner's container map (undefined ⇒ "no record"). */
  containerRefOf?: (sandboxId: string) => string | undefined;
}

const drive = (messages: SupervisorMessage[], options: DriveOptions = {}) => {
  const reported: RunnerEvent[] = [];
  const added: string[] = [];
  const flushed: string[] = [];
  const sent: { sandboxId: string; item: unknown }[] = [];
  const handle = createSupervisorMessageHandler({
    report: (event) => reported.push(event),
    collector: {
      add: (_sandboxId, _conversationId, turnId) => added.push(turnId),
      flush: (turnId) => flushed.push(turnId),
    },
    toolCall: options.toolCall ?? (async () => ({ ok: true, result: null })),
    memoryWrite: options.memoryWrite ?? (async () => ({ ok: true })),
    sendToSandbox: (sandboxId, item) => {
      sent.push({ sandboxId, item });
      return true;
    },
    containerRefOf: options.containerRefOf ?? (() => "cont-default"),
  });
  for (const message of messages) handle("sb-1", message);
  return { reported, added, flushed, sent };
};

describe("supervisor message handler", () => {
  it("turns an unhealthy report into a STOPPED sandbox", () => {
    // The recovery hinge for a dead harness. `stopped` is what rejoins the
    // ordinary wake path — `failed` would sit out the start-retry backoff, and
    // no report at all leaves the control plane believing a bricked sandbox is
    // healthy, which is the bug this exists to close.
    const { reported } = drive([
      { kind: "unhealthy", reason: "harness connection closed" },
    ]);

    expect(reported).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "stopped",
        error: "harness connection closed",
      },
    ]);
  });

  it("relays a progress heartbeat as its own report, never through the collector", () => {
    // Its own single-event post on purpose: an old control plane rejecting
    // the unknown kind must lose one heartbeat, not a transcript batch. And
    // the sandboxId is the channel's, whatever the body claimed.
    const { reported, added, flushed } = drive([
      { kind: "progress", turnId: "t1", conversationId: "cv1" },
    ]);

    expect(reported).toEqual([
      {
        kind: "turn.progress",
        sandboxId: "sb-1",
        conversationId: "cv1",
        turnId: "t1",
      },
    ]);
    expect(added).toEqual([]);
    expect(flushed).toEqual([]);
  });

  it("attributes every message to the AUTHENTICATED sandbox", () => {
    // A supervisor may only ever speak for itself: the id comes from the
    // channel, never from a body it chose.
    const { reported } = drive([
      { kind: "ready", harness: "jcode" },
      {
        kind: "turn.result",
        turnId: "t1",
        conversationId: "cv-1",
        status: "done",
      },
      { kind: "unhealthy", reason: "gone" },
    ]);

    expect(reported).toHaveLength(3);
    expect(
      reported.every(
        (event) => "sandboxId" in event && event.sandboxId === "sb-1",
      ),
    ).toBe(true);
  });

  it("forwards the failure class beside the raw error, verbatim", () => {
    // The runner never interprets the code — the control plane's allowlist
    // owns its meaning. Dropping it here would down-grade every death to the
    // uncoded raw-string path.
    const { reported } = drive([
      {
        kind: "turn.result",
        turnId: "t1",
        conversationId: "cv-1",
        status: "failed",
        error: "harness launch failed: Error: spawn ENOENT",
        errorCode: "agent_start_failed",
      },
    ]);

    expect(reported[0]).toMatchObject({
      kind: "turn.finished",
      status: "failed",
      error: "harness launch failed: Error: spawn ENOENT",
      errorCode: "agent_start_failed",
    });
  });

  it("forwards harness_busy verbatim too — a NEW code needs no runner change", async () => {
    // The open-string law end to end: the adapter minted this code after the
    // busy self-heal exhausted; the runner is a pipe.
    const { reported } = drive([
      {
        kind: "turn.result",
        turnId: "t1",
        conversationId: "cv-1",
        status: "failed",
        error: "Already processing a message",
        errorCode: "harness_busy",
      },
    ]);

    expect(reported[0]).toMatchObject({
      kind: "turn.finished",
      status: "failed",
      error: "Already processing a message",
      errorCode: "harness_busy",
    });
  });

  it("flushes buffered text before the terminal report", () => {
    // Otherwise the transcript can record the turn finishing before the words
    // it said — `seq` is assigned control-plane-side, on arrival.
    const { flushed, reported } = drive([
      {
        kind: "turn.result",
        turnId: "t1",
        conversationId: "cv-1",
        status: "aborted",
      },
    ]);

    expect(flushed).toEqual(["t1"]);
    expect(reported[0]).toMatchObject({
      kind: "turn.finished",
      status: "aborted",
    });
  });
});

describe("the tool-call arm", () => {
  it("relays under the CHANNEL's sandbox id and answers on the sandbox channel, never the report chain", async () => {
    const calls: { sandboxId: string; tool: string }[] = [];
    const { reported, sent } = drive(
      [
        {
          kind: "tool.call",
          callId: "call-1",
          tool: "schedule_task",
          args: { name: "x" },
        },
      ],
      {
        toolCall: async (sandboxId, call) => {
          calls.push({ sandboxId, tool: call.tool });
          return { ok: true, result: { cronId: "cr-1" } };
        },
      },
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(calls).toEqual([{ sandboxId: "sb-1", tool: "schedule_task" }]);
    expect(sent[0]!.item).toEqual({
      kind: "tool.result",
      callId: "call-1",
      ok: true,
      result: { cronId: "cr-1" },
    });
    // Its OWN path: nothing entered the ordered-but-lossy report chain.
    expect(reported).toHaveLength(0);
  });

  it("a control-plane failure becomes a tool ERROR, never silence", async () => {
    // MUTATION-PROOF: swallow the throw in relayToolCall and this fails —
    // the supervisor's correlator would wait out its full timeout.
    const { sent } = drive(
      [{ kind: "tool.call", callId: "call-2", tool: "list_tasks", args: {} }],
      { toolCall: async () => Promise.reject(new Error("api unreachable")) },
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const item = sent[0]!.item as { ok: boolean; error?: string };
    expect(item.ok).toBe(false);
    expect(item.error).toContain("api unreachable");
  });

  it("bounds an oversized result at the sender instead of shipping a droppable frame", async () => {
    const { sent } = drive(
      [{ kind: "tool.call", callId: "call-3", tool: "list_tasks", args: {} }],
      {
        toolCall: async () => ({ ok: true, result: "x".repeat(70_000) }),
      },
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const item = sent[0]!.item as { ok: boolean; error?: string };
    expect(item.ok).toBe(false);
    expect(item.error).toContain("too large");
  });
});

describe("the memory.write arm", () => {
  const write = {
    kind: "memory.write" as const,
    writeId: "w-1",
    key: "deploy-notes",
    content: "Ship on Tuesdays.",
  };

  it("relays under the CHANNEL's sandbox id and answers on the sandbox channel, never the report chain", async () => {
    const writes: { sandboxId: string; key: string }[] = [];
    const { reported, sent } = drive([write], {
      memoryWrite: async (sandboxId, message) => {
        writes.push({ sandboxId, key: message.key });
        return { ok: true, created: true, revisionSeq: 1, noop: false };
      },
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(writes).toEqual([{ sandboxId: "sb-1", key: "deploy-notes" }]);
    expect(sent[0]!.item).toEqual({
      kind: "memory.write.result",
      writeId: "w-1",
      ok: true,
      created: true,
      revisionSeq: 1,
      noop: false,
    });
    expect(reported).toHaveLength(0);
  });

  it("a control-plane failure becomes a RETRYABLE error, never silence", async () => {
    // MUTATION-PROOF: swallow the throw in relayMemoryWrite and this fails —
    // the harvester would wait out its full timeout, and without `retryable`
    // it would wrongly park the write until the file changes again.
    const { sent } = drive([write], {
      memoryWrite: async () => Promise.reject(new Error("api unreachable")),
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const item = sent[0]!.item as {
      ok: boolean;
      retryable?: boolean;
      error?: string;
    };
    expect(item.ok).toBe(false);
    expect(item.retryable).toBe(true);
    expect(item.error).toContain("api unreachable");
  });

  it("forwards a refusal (ok:false, no retryable) verbatim", async () => {
    const { sent } = drive([write], {
      memoryWrite: async () => ({
        ok: false,
        error: "This memory is too large to sync",
      }),
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.item).toEqual({
      kind: "memory.write.result",
      writeId: "w-1",
      ok: false,
      error: "This memory is too large to sync",
    });
  });

  it("caps in-flight relays per sandbox — the flood is refused retryably WITHOUT a control-plane round-trip", async () => {
    // MUTATION-PROOF (lens-3 catch): remove the in-flight cap and the 9th
    // concurrent frame reaches memoryWrite, so `calls` hits 9 — an unbounded
    // supervisor flood OOMs the runner (each relay holds ~150KB). With the
    // cap, exactly MAX_INFLIGHT_MEMORY_WRITES_PER_SANDBOX relays are in
    // flight and the excess is answered locally.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { sent } = drive(
      Array.from({ length: 9 }, (_, i) => ({
        kind: "memory.write" as const,
        writeId: `w-${i}`,
        key: "k",
        content: "body",
      })),
      {
        memoryWrite: async () => {
          calls += 1;
          await held;
          return { ok: true };
        },
      },
    );

    // The 9th is refused immediately, retryably, without entering the handler.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(calls).toBe(MAX_INFLIGHT_MEMORY_WRITES_PER_SANDBOX); // 8 held, 1 rejected
    expect(sent[0]!.item).toMatchObject({
      kind: "memory.write.result",
      writeId: "w-8",
      ok: false,
      retryable: true,
    });

    // Draining the 8 frees the slots — a later write relays normally.
    release?.();
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(9));
  });
});

describe("the home.synced ack", () => {
  it("forwards the generation with the CHANNEL's sandbox id", () => {
    const { reported } = drive([{ kind: "home.synced", generation: 9 }]);
    expect(reported).toEqual([
      { kind: "home.synced", sandboxId: "sb-1", generation: 9 },
    ]);
  });
});

describe("process.state forwarding (step 10)", () => {
  const frame = {
    kind: "process.state" as const,
    process: {
      ref: "p-1",
      command: "sleep 5",
      status: "running" as const,
      startedAt: "2026-08-08T00:00:00.000Z",
      watches: [],
    },
  };

  it("stamps the runner's container ref (never the payload) and forwards", () => {
    const { reported } = drive([frame], {
      containerRefOf: () => "cont-xyz",
    });
    expect(reported).toEqual([
      {
        kind: "process.state",
        sandboxId: "sb-1",
        containerRef: "cont-xyz",
        process: frame.process,
      },
    ]);
  });

  it("DROPS a frame when the container is unknown — no unstamped fact ships", () => {
    const { reported } = drive([frame], { containerRefOf: () => undefined });
    expect(reported).toEqual([]);
  });
});
