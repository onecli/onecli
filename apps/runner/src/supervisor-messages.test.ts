import { describe, expect, it, vi } from "vitest";
import type {
  RunnerEvent,
  RunnerMemoryWriteResponse,
  SupervisorMessage,
} from "@onecli/agent-protocol";
import {
  createSupervisorMessageHandler,
  FILE_UPLOAD_STALE_MS,
  MAX_INFLIGHT_FILE_UPLOADS_PER_SANDBOX,
  MAX_INFLIGHT_MEMORY_WRITES_PER_SANDBOX,
  type OutboundFile,
} from "./supervisor-messages";
import { createHash } from "node:crypto";
import {
  ATTACHMENT_CHUNK_RAW_BYTES,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  type RunnerAttachmentUploadResponse,
} from "@onecli/agent-protocol";

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
  uploadAttachment?: (
    sandboxId: string,
    file: OutboundFile,
  ) => Promise<RunnerAttachmentUploadResponse>;
  now?: () => number;
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
    uploadAttachment:
      options.uploadAttachment ??
      (async () => ({ ok: true, attachmentId: "att-1" })),
    sendToSandbox: (sandboxId, item) => {
      sent.push({ sandboxId, item });
      return true;
    },
    containerRefOf: options.containerRefOf ?? (() => "cont-default"),
    ...(options.now && { now: options.now }),
  });
  for (const message of messages) handle("sb-1", message);
  return { reported, added, flushed, sent, handle };
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

/**
 * The send_file arm: chunk-run reassembly (one in-progress run per sandbox,
 * fail-closed on any discontinuity), the checksum/size belts, the in-flight
 * relay ceiling, the stale sweep — and the law that EVERY run gets exactly
 * one file.result, so the supervisor's correlator never waits out a timeout.
 */
describe("the file.part arm (send_file)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  /** Split bytes into legal file.part frames for one upload. */
  const partsFor = (
    uploadId: string,
    bytes: Buffer,
    overrides: Partial<Extract<SupervisorMessage, { kind: "file.part" }>> = {},
  ): Extract<SupervisorMessage, { kind: "file.part" }>[] => {
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.byteLength; i += ATTACHMENT_CHUNK_RAW_BYTES) {
      chunks.push(bytes.subarray(i, i + ATTACHMENT_CHUNK_RAW_BYTES));
    }
    if (chunks.length === 0) chunks.push(Buffer.alloc(0));
    return chunks.map((chunk, i) => ({
      kind: "file.part" as const,
      uploadId,
      conversationId: "cv-1",
      turnId: "t-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256: sha(bytes),
      part: i + 1,
      of: chunks.length,
      dataBase64: chunk.toString("base64"),
      ...overrides,
    }));
  };

  const results = (sent: { item: unknown }[]) =>
    sent
      .map((s) => s.item as { kind: string })
      .filter((i) => i.kind === "file.result") as Extract<
      WorkItemLike,
      { kind: "file.result" }
    >[];
  type WorkItemLike = {
    kind: "file.result";
    uploadId: string;
    ok: boolean;
    attachmentId?: string;
    retryable?: boolean;
    error?: string;
  };

  it("reassembles a multi-part run byte-exactly, relays it once, and answers ok with the attachment id", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 2 + 5, 7);
    const uploaded: OutboundFile[] = [];
    const { sent } = drive(partsFor("up-1", bytes), {
      uploadAttachment: async (_sb, file) => {
        uploaded.push(file);
        return { ok: true, attachmentId: "att-9" };
      },
    });
    await settle();
    expect(uploaded).toHaveLength(1);
    expect(Buffer.compare(uploaded[0]!.bytes, bytes)).toBe(0);
    expect(uploaded[0]).toMatchObject({
      uploadId: "up-1",
      conversationId: "cv-1",
      turnId: "t-1",
      name: "report.pdf",
      sha256: sha(bytes),
    });
    expect(results(sent)).toEqual([
      {
        kind: "file.result",
        uploadId: "up-1",
        ok: true,
        attachmentId: "att-9",
      },
    ]);
  });

  it("carries the caption through when present, and omits it when absent", async () => {
    const bytes = Buffer.from("x");
    const uploaded: OutboundFile[] = [];
    drive(partsFor("up-c", bytes, { caption: "look" }), {
      uploadAttachment: async (_sb, file) => {
        uploaded.push(file);
        return { ok: true, attachmentId: "a" };
      },
    });
    await settle();
    expect(uploaded[0]?.caption).toBe("look");
    drive(partsFor("up-d", bytes), {
      uploadAttachment: async (_sb, file) => {
        uploaded.push(file);
        return { ok: true, attachmentId: "a" };
      },
    });
    await settle();
    expect("caption" in uploaded[1]!).toBe(false);
  });

  it("CHECKSUM: a run whose bytes do not hash to the declared sha is refused and never relayed", async () => {
    const bytes = Buffer.from("real bytes");
    const relayed = vi.fn(async () => ({ ok: true, attachmentId: "a" }));
    const { sent } = drive(
      partsFor("up-2", bytes, { sha256: sha(Buffer.from("other")) }),
      { uploadAttachment: relayed },
    );
    await settle();
    expect(relayed).not.toHaveBeenCalled();
    expect(results(sent)).toEqual([
      expect.objectContaining({ uploadId: "up-2", ok: false }),
    ]);
    expect(results(sent)[0]!.error).toMatch(/checksum/);
  });

  it("SIZE: a declared size over the cap is refused on part 1 before any byte is buffered", async () => {
    const relayed = vi.fn(async () => ({ ok: true, attachmentId: "a" }));
    const { sent } = drive(
      partsFor("up-3", Buffer.from("x"), {
        sizeBytes: MAX_OUTBOUND_ATTACHMENT_BYTES + 1,
      }),
      { uploadAttachment: relayed },
    );
    await settle();
    expect(relayed).not.toHaveBeenCalled();
    expect(results(sent)[0]).toMatchObject({ uploadId: "up-3", ok: false });
    expect(results(sent)[0]!.error).toMatch(/capped/);
  });

  it("SIZE: more bytes than declared abandons the run; fewer is refused at the end", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES + 10, 1);
    const relayed = vi.fn(async () => ({ ok: true, attachmentId: "a" }));
    // Lie small: declared size is one chunk, but two arrive.
    const over = partsFor("up-4", bytes, {
      sizeBytes: ATTACHMENT_CHUNK_RAW_BYTES,
    });
    const { sent: s1 } = drive(over, { uploadAttachment: relayed });
    await settle();
    expect(results(s1)[0]).toMatchObject({ uploadId: "up-4", ok: false });
    expect(results(s1)[0]!.error).toMatch(/exceeded/);
    // Lie big: declared larger than what arrives.
    const under = partsFor("up-5", Buffer.from("abc"), { sizeBytes: 999 });
    const { sent: s2 } = drive(under, { uploadAttachment: relayed });
    await settle();
    expect(results(s2)[0]).toMatchObject({ uploadId: "up-5", ok: false });
    expect(results(s2)[0]!.error).toMatch(/shorter/);
    expect(relayed).not.toHaveBeenCalled();
  });

  it("DISCONTINUITY: an out-of-order part abandons the run fail-closed, answering it", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 3, 2);
    const [p1, , p3] = partsFor("up-6", bytes);
    const relayed = vi.fn(async () => ({ ok: true, attachmentId: "a" }));
    const { sent } = drive([p1!, p3!], { uploadAttachment: relayed });
    await settle();
    expect(relayed).not.toHaveBeenCalled();
    expect(results(sent)).toEqual([
      expect.objectContaining({ uploadId: "up-6", ok: false }),
    ]);
    expect(results(sent)[0]!.error).toMatch(/out of order/);
  });

  it("DISCONTINUITY: a new run starting mid-run abandons the old one (answered) and proceeds with the new", async () => {
    const big = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 2, 3);
    const small = Buffer.from("small");
    const [first] = partsFor("up-7", big);
    const relayed = vi.fn(async () => ({ ok: true, attachmentId: "a" }));
    const { sent } = drive([first!, ...partsFor("up-8", small)], {
      uploadAttachment: relayed,
    });
    await settle();
    const r = results(sent);
    expect(r.map((x) => [x.uploadId, x.ok])).toEqual([
      ["up-7", false],
      ["up-8", true],
    ]);
    expect(relayed).toHaveBeenCalledTimes(1);
  });

  it("IN-FLIGHT CEILING: past MAX_INFLIGHT_FILE_UPLOADS_PER_SANDBOX, a complete run is refused retryable without a round-trip", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const relayed = vi.fn(async () => {
      await gate;
      return { ok: true, attachmentId: "a" };
    });
    const runs = Array.from(
      { length: MAX_INFLIGHT_FILE_UPLOADS_PER_SANDBOX + 1 },
      (_, i) => partsFor(`up-f${i}`, Buffer.from(`f${i}`)),
    ).flat();
    const { sent } = drive(runs, { uploadAttachment: relayed });
    await settle();
    expect(relayed).toHaveBeenCalledTimes(
      MAX_INFLIGHT_FILE_UPLOADS_PER_SANDBOX,
    );
    const refused = results(sent).filter((x) => !x.ok);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ retryable: true });
    release();
    await settle();
    expect(results(sent).filter((x) => x.ok)).toHaveLength(
      MAX_INFLIGHT_FILE_UPLOADS_PER_SANDBOX,
    );
  });

  it("TRANSPORT: a relay that throws is answered retryable, never silently", async () => {
    const { sent } = drive(partsFor("up-9", Buffer.from("x")), {
      uploadAttachment: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await settle();
    expect(results(sent)[0]).toMatchObject({
      uploadId: "up-9",
      ok: false,
      retryable: true,
    });
    expect(results(sent)[0]!.error).toMatch(/could not be reached/);
  });

  it("STALE SWEEP: a run with no part for FILE_UPLOAD_STALE_MS is dropped and answered when the next frame arrives", async () => {
    let clock = 1_000_000;
    const big = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 2, 4);
    const [first] = partsFor("up-stale", big);
    const { sent, handle } = drive([first!], { now: () => clock });
    clock += FILE_UPLOAD_STALE_MS + 1;
    // Any frame from another sandbox triggers the sweep.
    handle("sb-2", partsFor("up-other", Buffer.from("y"))[0]!);
    await settle();
    expect(results(sent).map((x) => [x.uploadId, x.ok])).toContainEqual([
      "up-stale",
      false,
    ]);
    expect(results(sent).find((x) => x.uploadId === "up-stale")!.error).toMatch(
      /stalled/,
    );
  });

  it("answers the api's refusal verbatim (caps, fence) with the ok:false shape", async () => {
    const { sent } = drive(partsFor("up-10", Buffer.from("x")), {
      uploadAttachment: async () => ({
        ok: false,
        error: "You can send at most 10 files per reply.",
      }),
    });
    await settle();
    expect(results(sent)[0]).toEqual({
      kind: "file.result",
      uploadId: "up-10",
      ok: false,
      error: "You can send at most 10 files per reply.",
    });
  });
});
