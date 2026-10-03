import { describe, expect, it } from "vitest";
import { supervisorMessageSchema, workItemSchema } from "./transport";
import {
  ATTACHMENT_CHUNK_BASE64_CHARS,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_CAPTION_CHARS,
} from "./attachments";

/**
 * The tool-channel wire pair (step 7). The compat law matters more than the
 * happy path: an OLD peer must DROP an unknown kind (safeParse fails, the
 * message is discarded, the caller times out into a clean tool error) —
 * never crash, never half-parse.
 */
describe("the tool-call pair", () => {
  it("round-trips a tool.call with its optional calling-turn context", () => {
    const call = {
      kind: "tool.call",
      callId: "c-1",
      tool: "schedule_task",
      args: { name: "daily", schedule: "0 9 * * *" },
      conversationId: "conv-1",
      turnId: "t-1",
    };
    const parsed = supervisorMessageSchema.parse(call);
    expect(parsed).toEqual(call);

    const bare = supervisorMessageSchema.parse({
      kind: "tool.call",
      callId: "c-2",
      tool: "list_tasks",
      args: {},
    });
    expect(bare).not.toHaveProperty("conversationId");
  });

  it("round-trips both tool.result shapes", () => {
    expect(
      workItemSchema.parse({
        kind: "tool.result",
        callId: "c-1",
        ok: true,
        result: { tasks: [] },
      }).kind,
    ).toBe("tool.result");
    const failed = workItemSchema.parse({
      kind: "tool.result",
      callId: "c-1",
      ok: false,
      error: "This tool is not available.",
    });
    expect(failed.kind === "tool.result" && failed.ok).toBe(false);
  });

  it("an unknown kind is dropped, not crashed on — the old-peer compat law", () => {
    expect(
      workItemSchema.safeParse({ kind: "tool.call", callId: "x" }).success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({ kind: "tool.result", callId: "x" })
        .success,
    ).toBe(false);
  });

  it("bounds the error text — an oversized frame would be dropped whole", () => {
    expect(
      workItemSchema.safeParse({
        kind: "tool.result",
        callId: "c-1",
        ok: false,
        error: "x".repeat(2_001),
      }).success,
    ).toBe(false);
  });
});

/** The failure-classification field on the terminal frame: optional both
 * ways — a coded result parses, a bare one parses, so neither an old nor a
 * new peer can invalidate the one frame that must deliver. */
describe("turn.result errorCode", () => {
  const base = {
    kind: "turn.result",
    turnId: "t-1",
    conversationId: "cv-1",
    status: "failed",
    error: "harness connection closed",
  };

  it("parses with and without a code", () => {
    const coded = supervisorMessageSchema.parse({
      ...base,
      errorCode: "agent_restarted",
    });
    if (coded.kind !== "turn.result") throw new Error("wrong kind");
    expect(coded.errorCode).toBe("agent_restarted");

    const bare = supervisorMessageSchema.parse(base);
    if (bare.kind !== "turn.result") throw new Error("wrong kind");
    expect(bare.errorCode).toBeUndefined();
  });
});

/**
 * The delivery-only context field (step 8). The compat law again: a STALE
 * supervisor's non-strict parse silently drops the key — the turn still
 * delivers, just without its memory index. The desired degrade.
 */
describe("turn.deliver context", () => {
  const base = {
    kind: "turn.deliver",
    turnId: "t-1",
    conversationId: "conv-1",
    message: "hello",
  };

  it("parses without context (an old control plane, a memory-less agent)", () => {
    const parsed = workItemSchema.parse(base);
    expect(parsed).not.toHaveProperty("context");
  });

  it("round-trips with context", () => {
    const parsed = workItemSchema.parse({
      ...base,
      context:
        "[Your memory — …]\n- deploy-notes: how we deploy\n[End of memory]",
    });
    expect(parsed.kind === "turn.deliver" && parsed.context).toContain(
      "deploy-notes",
    );
  });

  it("rejects a context past its cap — truncation is the sender's job", () => {
    expect(
      workItemSchema.safeParse({ ...base, context: "x".repeat(16_001) })
        .success,
    ).toBe(false);
  });

  it("drops an UNKNOWN extra field silently — the stale-peer degrade this design relies on", () => {
    const parsed = workItemSchema.parse({
      ...base,
      someFutureField: "ignored",
    });
    expect(parsed).not.toHaveProperty("someFutureField");
  });
});

/**
 * The supervisor side of the home sync (step 9): the per-part frame the
 * runner fans out, and the ack. An OLD supervisor image must DROP the arm
 * (safeParse fails → warn + discard) — the desired degrade.
 */
describe("skills.changed + home.synced (supervisor wire)", () => {
  const frame = {
    kind: "skills.changed",
    generation: 2,
    part: 1,
    of: 2,
    files: [{ path: ".agents/skills/deploy/SKILL.md", content: "# d" }],
  };

  it("round-trips a middle part and a final part", () => {
    expect(workItemSchema.parse(frame).kind).toBe("skills.changed");
    const final = workItemSchema.parse({
      ...frame,
      part: 2,
      prune: [".agents/skills/deploy/SKILL.md"],
      instructions: "brief",
      agentName: "andy",
      channels: [
        {
          provider: "slack",
          status: "needs_attention",
          handle: "andy",
          workspaceName: null,
        },
      ],
    });
    expect(final.kind === "skills.changed" && final.prune).toHaveLength(1);
    expect(final.kind === "skills.changed" && final.channels).toHaveLength(1);
  });

  it("rejects traversal paths and non-positive part numbers", () => {
    expect(
      workItemSchema.safeParse({
        ...frame,
        files: [{ path: "../evil", content: "x" }],
      }).success,
    ).toBe(false);
    expect(workItemSchema.safeParse({ ...frame, part: 0 }).success).toBe(false);
  });

  it("round-trips the home.synced ack", () => {
    expect(
      supervisorMessageSchema.parse({ kind: "home.synced", generation: 4 })
        .kind,
    ).toBe("home.synced");
  });
});

describe("process.state (supervisor wire, step 10)", () => {
  const full = {
    kind: "process.state",
    process: {
      ref: "p-1",
      command: "sleep 120; echo FINISHED",
      name: "build",
      status: "exited",
      exitCode: 0,
      startedAt: "2026-08-08T00:00:00.000Z",
      endedAt: "2026-08-08T00:02:00.000Z",
      tail: "FINISHED\n",
      conversationId: "cv-1",
      turnId: "t-1",
      watches: [
        {
          ref: "w-1",
          kind: "exit",
          prompt: "Summarize the build result.",
          status: "triggered",
          trigger: "exited",
          triggeredAt: "2026-08-08T00:02:00.000Z",
          expiresAt: "2026-08-08T04:00:00.000Z",
        },
      ],
    },
  };

  it("round-trips full and minimal shapes", () => {
    expect(supervisorMessageSchema.parse(full)).toEqual(full);
    const minimal = {
      kind: "process.state",
      process: {
        ref: "p-2",
        command: "sleep 5",
        status: "running",
        startedAt: "2026-08-08T00:00:00.000Z",
        watches: [],
      },
    };
    expect(supervisorMessageSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects over-cap strings — sender truncation is load-bearing, not advisory", () => {
    const oversized = structuredClone(full);
    oversized.process.command = "x".repeat(2_001);
    expect(supervisorMessageSchema.safeParse(oversized).success).toBe(false);

    const badPrompt = structuredClone(full);
    badPrompt.process.watches[0]!.prompt = "y".repeat(2_001);
    expect(supervisorMessageSchema.safeParse(badPrompt).success).toBe(false);
  });

  it("refuses the control-plane-only states on the wire (lost, fired)", () => {
    const lost = structuredClone(full);
    (lost.process as { status: string }).status = "lost";
    expect(supervisorMessageSchema.safeParse(lost).success).toBe(false);

    const fired = structuredClone(full);
    (fired.process.watches[0] as { status: string }).status = "fired";
    expect(supervisorMessageSchema.safeParse(fired).success).toBe(false);
  });
});

/**
 * Outbound files (`send_file`, Tier 3): the supervisor's chunk frame and the
 * runner's one-per-upload answer. The belts here are what keep a 25 MB file
 * from ever producing a frame the runner WS drops whole.
 */
describe("file.part + file.result (send_file wire)", () => {
  const part = {
    kind: "file.part",
    uploadId: "up-1",
    conversationId: "cv-1",
    turnId: "t-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 3 * 144_000 + 7,
    sha256: "a".repeat(64),
    caption: "The quarterly report",
    part: 1,
    of: 4,
    dataBase64: "QUJD",
  };

  it("round-trips a part with and without a caption", () => {
    expect(supervisorMessageSchema.parse(part).kind).toBe("file.part");
    const bare: Record<string, unknown> = { ...part };
    delete bare.caption;
    expect(supervisorMessageSchema.parse(bare).kind).toBe("file.part");
  });

  it("requires the calling turn: a file belongs to the reply that made it", () => {
    const noTurn: Record<string, unknown> = { ...part };
    delete noTurn.turnId;
    expect(supervisorMessageSchema.safeParse(noTurn).success).toBe(false);
    const noConversation: Record<string, unknown> = { ...part };
    delete noConversation.conversationId;
    expect(supervisorMessageSchema.safeParse(noConversation).success).toBe(
      false,
    );
  });

  it("refuses the outbound size cap, an oversized chunk, and a bad sha", () => {
    expect(
      supervisorMessageSchema.safeParse({
        ...part,
        sizeBytes: MAX_OUTBOUND_ATTACHMENT_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({
        ...part,
        dataBase64: "A".repeat(ATTACHMENT_CHUNK_BASE64_CHARS + 4),
      }).success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({ ...part, sha256: "not-hex" }).success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({
        ...part,
        caption: "c".repeat(MAX_OUTBOUND_CAPTION_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({ ...part, part: 0 }).success,
    ).toBe(false);
  });

  it("a legal chunk frame stays under the runner WS's 256KB ceiling", () => {
    const maxFrame = {
      ...part,
      name: "n".repeat(100),
      caption: "c".repeat(MAX_OUTBOUND_CAPTION_CHARS),
      dataBase64: "A".repeat(ATTACHMENT_CHUNK_BASE64_CHARS),
    };
    expect(supervisorMessageSchema.safeParse(maxFrame).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(maxFrame))).toBeLessThan(
      256 * 1024,
    );
  });

  it("round-trips both file.result outcomes", () => {
    expect(
      workItemSchema.parse({
        kind: "file.result",
        uploadId: "up-1",
        ok: true,
        attachmentId: "att-1",
      }).kind,
    ).toBe("file.result");
    const refused = workItemSchema.parse({
      kind: "file.result",
      uploadId: "up-1",
      ok: false,
      retryable: true,
      error: "Too many uploads in flight — retry shortly.",
    });
    expect(refused.kind === "file.result" && refused.retryable).toBe(true);
  });
});
