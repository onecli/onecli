import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_CONNECTION_API_HOST_CHARS,
  MAX_AGENT_CONNECTION_API_HOSTS,
  MAX_AGENT_CONNECTION_DOCS_URL_CHARS,
  MAX_AGENT_CONNECTION_ENDPOINT_CHARS,
  MAX_AGENT_CONNECTION_ENDPOINTS,
  MAX_AGENT_CONNECTION_LABEL_CHARS,
  MAX_AGENT_CONNECTION_NAME_CHARS,
  MAX_AGENT_CONNECTIONS,
  MAX_SYNC_PART_BYTES,
  SESSION_RESUME_BUDGET,
  SESSION_RESUME_GRACE_MS,
  agentConnectionSchema,
  sequencedFrameSchema,
  supervisorMessageSchema,
  syncFrameByteLength,
  workItemSchema,
} from "./transport";
import { MAX_SYNC_PARTS } from "./sync-budget";
import { MAX_HOSTNAME_CHARS } from "./text";
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
 * SEND NOW on the supervisor wire: the follow-up and the run
 * it waits on, nothing else.
 */
describe("turn.send_now", () => {
  it("parses the ids, and refuses one without its target", () => {
    const item = {
      kind: "turn.send_now",
      turnId: "f-1",
      targetTurnId: "t-1",
      conversationId: "conv-1",
    };
    expect(workItemSchema.parse(item)).toEqual(item);
    expect(
      workItemSchema.safeParse({ ...item, targetTurnId: undefined }).success,
    ).toBe(false);
  });
});

/**
 * The steer's context: the "a new message arrived while you were working"
 * frame a person's follow-up carries, under the same law as the turn's.
 */
describe("turn.message context", () => {
  const base = {
    kind: "turn.message",
    turnId: "f-1",
    targetTurnId: "t-1",
    conversationId: "conv-1",
    message: "also check the linter",
  };

  it("parses without context (an old control plane, an automation's follow-up)", () => {
    expect(workItemSchema.parse(base)).not.toHaveProperty("context");
  });

  it("round-trips with context", () => {
    const parsed = workItemSchema.parse({
      ...base,
      context: "[A new message arrived while you were working.]",
    });
    expect(parsed.kind === "turn.message" && parsed.context).toContain(
      "new message",
    );
  });

  it("carries the follow-up's attachment manifest", () => {
    const attachments = [
      {
        id: "a1",
        path: "attachments/f-1/photo.png",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 10,
        sha256: "a".repeat(64),
      },
    ];
    const parsed = workItemSchema.parse({ ...base, attachments });
    expect(parsed.kind === "turn.message" && parsed.attachments).toEqual(
      attachments,
    );
  });

  it("rejects a context past its cap", () => {
    expect(
      workItemSchema.safeParse({ ...base, context: "x".repeat(16_001) })
        .success,
    ).toBe(false);
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

/**
 * The connections list rides the home-sync FINAL part beside the brief and
 * the prune manifest. Its catalog fields (apiHosts, endpoints, docsUrl,
 * specUrl) are capped so the WORST case at MAX_AGENT_CONNECTIONS still fits
 * the frame: raising a cap without re-checking the budget fails here, not as
 * a silently dropped frame in production.
 */
describe("the connections list on the sync frame", () => {
  // Hosts must be bare hostnames (main hardened `host`; `apiHosts` follows),
  // so the worst case is the longest VALID hostname, not 253 bare letters.
  const longHost = (chars: number): string => {
    const labels: string[] = [];
    let left = chars;
    while (left > 0) {
      const take = Math.min(63, left - (labels.length ? 1 : 0));
      labels.push("h".repeat(Math.max(1, take)));
      left -= take + (labels.length > 1 ? 1 : 0);
    }
    return labels.join(".");
  };
  const worst = {
    provider: "p".repeat(64),
    name: "n".repeat(MAX_AGENT_CONNECTION_NAME_CHARS),
    label: "l".repeat(MAX_AGENT_CONNECTION_LABEL_CHARS),
    host: longHost(MAX_HOSTNAME_CHARS),
    apiHosts: Array.from({ length: MAX_AGENT_CONNECTION_API_HOSTS }, () =>
      longHost(MAX_AGENT_CONNECTION_API_HOST_CHARS),
    ),
    endpoints: Array.from({ length: MAX_AGENT_CONNECTION_ENDPOINTS }, () =>
      "e".repeat(MAX_AGENT_CONNECTION_ENDPOINT_CHARS),
    ),
    docsUrl: `https://${"d".repeat(MAX_AGENT_CONNECTION_DOCS_URL_CHARS - "https://".length)}`,
    specUrl: `https://${"s".repeat(MAX_AGENT_CONNECTION_DOCS_URL_CHARS - "https://".length)}`,
  };

  it("the worst-case entry is valid, and one field past a cap is not", () => {
    expect(agentConnectionSchema.safeParse(worst).success).toBe(true);
    expect(
      agentConnectionSchema.safeParse({
        ...worst,
        apiHosts: [...worst.apiHosts, "x"],
      }).success,
    ).toBe(false);
  });

  it("the full worst-case list fits the part budget beside a maximal brief", () => {
    const bytes = syncFrameByteLength({
      kind: "skills.changed",
      generation: Number.MAX_SAFE_INTEGER,
      part: MAX_SYNC_PARTS,
      of: MAX_SYNC_PARTS,
      files: [],
      instructions: "i".repeat(20_000),
      agentName: "x".repeat(255),
      connections: Array(MAX_AGENT_CONNECTIONS).fill(worst),
    });
    expect(bytes).toBeLessThan(MAX_SYNC_PART_BYTES * 0.8);
  });

  it("an older frame without the catalog fields still parses", () => {
    const legacy = {
      provider: worst.provider,
      name: worst.name,
      label: worst.label,
      host: worst.host,
    };
    expect(agentConnectionSchema.safeParse(legacy).success).toBe(true);
  });
});

/**
 * The resumable channel (runner restart survival). Three wire additions, each
 * shaped so a STALE peer degrades to today's behaviour: an old supervisor
 * never receives `session` (it drops the unknown kind), an old runner never
 * receives an envelope (a supervisor only wraps frames once it HOLDS a
 * session, which only a new runner hands out).
 */
describe("resumable channel wire", () => {
  it("round-trips the session hand-off and the standalone ack", () => {
    const session = workItemSchema.parse({
      kind: "session",
      credential: "v1.k1.deadbeef",
      ack: 0,
    });
    expect(session).toEqual({
      kind: "session",
      credential: "v1.k1.deadbeef",
      ack: 0,
    });
    expect(workItemSchema.parse({ kind: "ack", seq: 42 })).toEqual({
      kind: "ack",
      seq: 42,
    });
  });

  it("refuses an empty credential and a negative or fractional ack", () => {
    expect(
      workItemSchema.safeParse({ kind: "session", credential: "", ack: 0 })
        .success,
    ).toBe(false);
    expect(
      workItemSchema.safeParse({ kind: "session", credential: "x", ack: -1 })
        .success,
    ).toBe(false);
    expect(workItemSchema.safeParse({ kind: "ack", seq: 1.5 }).success).toBe(
      false,
    );
  });

  it("wraps a supervisor message in a sequenced envelope, and unwraps it", () => {
    const inner = { kind: "ready", harness: "claude" } as const;
    const envelope = sequencedFrameSchema.parse({ seq: 7, message: inner });
    expect(envelope).toEqual({ seq: 7, message: inner });
  });

  it("an envelope is NOT a supervisor message: an old runner drops it whole rather than half-reading it", () => {
    expect(
      supervisorMessageSchema.safeParse({
        seq: 7,
        message: { kind: "ready", harness: "claude" },
      }).success,
    ).toBe(false);
  });

  it("refuses an envelope whose seq is not a positive integer or whose message is not a frame", () => {
    expect(
      sequencedFrameSchema.safeParse({
        seq: 0,
        message: { kind: "ready", harness: "x" },
      }).success,
    ).toBe(false);
    expect(
      sequencedFrameSchema.safeParse({ seq: 1, message: { kind: "nope" } })
        .success,
    ).toBe(false);
  });

  it("derives the reconcile grace from the supervisor's own retry budget, so the two ends cannot drift", () => {
    // 60 attempts, backoff doubling from 500 ms and capped at 15 s: the
    // budget is dominated by the cap, so it is ~60 × 15 s. The grace must
    // cover the WHOLE budget (a reconnect still inside it is not a death) and
    // no more than one extra minute (past it, the supervisor has given up and
    // the sandbox really is channelless).
    const budgetMs =
      SESSION_RESUME_BUDGET.maxAttempts * SESSION_RESUME_BUDGET.maxBackoffMs;
    expect(SESSION_RESUME_GRACE_MS).toBeGreaterThanOrEqual(budgetMs);
    expect(SESSION_RESUME_GRACE_MS).toBeLessThanOrEqual(budgetMs + 60_000);
  });
});
