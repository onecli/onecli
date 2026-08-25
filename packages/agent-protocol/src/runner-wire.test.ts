import { describe, expect, it } from "vitest";
import {
  runnerEventSchema,
  runnerEventsRequestSchema,
  runnerHeartbeatRequestSchema,
  runnerRegisterRequestSchema,
  runnerWorkItemSchema,
  runnerWorkRequestSchema,
  runnerWorkResponseSchema,
  sandboxStartPayloadSchema,
} from "./runner-wire";
import { MAX_SYNC_PARTS } from "./transport";

const capabilities = {
  maxSandboxes: 4,
  backend: "docker",
  homeDurability: "resident" as const,
};

const payload = {
  env: {
    HTTPS_PROXY: "http://x:aoc_tok@gateway:10255",
    ANTHROPIC_API_KEY: "placeholder",
  },
  files: [{ containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM" }],
  model: "claude-opus-5",
  harness: "jcode",
  instructions: "You are the test agent.",
  warnings: [],
};

describe("register", () => {
  it("round-trips a registration", () => {
    const parsed = runnerRegisterRequestSchema.parse({
      name: "laptop",
      capabilities,
    });
    expect(parsed.capabilities.homeDurability).toBe("resident");
  });

  it("rejects an unknown durability class", () => {
    const result = runnerRegisterRequestSchema.safeParse({
      name: "laptop",
      capabilities: { ...capabilities, homeDurability: "ephemeral" },
    });
    expect(result.success).toBe(false);
  });
});

describe("work items", () => {
  it("round-trips sandbox.start with its payload", () => {
    const item = runnerWorkItemSchema.parse({
      kind: "sandbox.start",
      sandboxId: "sb-1",
      agentId: "ag-1",
      payload,
    });
    if (item.kind !== "sandbox.start") throw new Error("wrong kind");
    expect(item.payload.files).toHaveLength(1);
  });

  it("round-trips sandbox.stop without a containerRef", () => {
    const item = runnerWorkItemSchema.parse({
      kind: "sandbox.stop",
      sandboxId: "sb-1",
    });
    expect(item.kind).toBe("sandbox.stop");
  });

  it("round-trips turn.deliver with its conversation and resume ref", () => {
    const item = runnerWorkItemSchema.parse({
      kind: "turn.deliver",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
      message: "hello",
      resumeSessionRef: "sess-abc",
    });
    if (item.kind !== "turn.deliver") throw new Error("wrong kind");
    expect(item.resumeSessionRef).toBe("sess-abc");
  });

  it("round-trips turn.abort", () => {
    const item = runnerWorkItemSchema.parse({
      kind: "turn.abort",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
    });
    expect(item.kind).toBe("turn.abort");
  });

  it("rejects unknown kinds (forward-compat items are dropped, not crashed on)", () => {
    // `skills.changed` became real in step 9 — a truly unknown kind still
    // drops, and the OLD bare probe shape still fails (missing fields).
    expect(
      runnerWorkItemSchema.safeParse({ kind: "home.defrag" }).success,
    ).toBe(false);
    expect(
      runnerWorkItemSchema.safeParse({
        kind: "skills.changed",
        sandboxId: "sb-1",
      }).success,
    ).toBe(false);
  });

  it("rejects a start payload with a non-string env value", () => {
    const result = sandboxStartPayloadSchema.safeParse({
      ...payload,
      env: { PORT: 8080 },
    });
    expect(result.success).toBe(false);
  });

  it("validates the response envelope", () => {
    const parsed = runnerWorkResponseSchema.parse({ items: [] });
    expect(parsed.items).toEqual([]);
  });
});

describe("work request bounds", () => {
  it("caps wait at 25s (the ALB/keep-alive ceiling)", () => {
    expect(runnerWorkRequestSchema.safeParse({ wait: 26 }).success).toBe(false);
    expect(runnerWorkRequestSchema.safeParse({ wait: 25 }).success).toBe(true);
    expect(runnerWorkRequestSchema.safeParse({}).success).toBe(true);
  });

  it("caps limit at 10", () => {
    expect(runnerWorkRequestSchema.safeParse({ limit: 11 }).success).toBe(
      false,
    );
    expect(runnerWorkRequestSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe("events", () => {
  it("round-trips a status event carrying refs", () => {
    const event = runnerEventSchema.parse({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "starting",
      containerRef: "cont-abc",
      homeRef: "onecli-home-sb-1",
    });
    expect(event.kind).toBe("sandbox.status");
  });

  it("rejects statuses outside the runtime set", () => {
    const result = runnerEventSchema.safeParse({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "unprovisioned",
    });
    expect(result.success).toBe(false);
  });

  it("carries an optional start-failure reasonCode, absent by default", () => {
    const coded = runnerEventSchema.parse({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "failed",
      error: "docker POST /containers/create failed: 404",
      reasonCode: "image_unavailable",
    });
    if (coded.kind !== "sandbox.status") throw new Error("wrong kind");
    expect(coded.reasonCode).toBe("image_unavailable");

    const bare = runnerEventSchema.parse({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "failed",
    });
    if (bare.kind !== "sandbox.status") throw new Error("wrong kind");
    expect(bare.reasonCode).toBeUndefined();
  });

  it("bounds the batch: 1..100 events", () => {
    expect(runnerEventsRequestSchema.safeParse({ events: [] }).success).toBe(
      false,
    );
    const many = Array.from({ length: 101 }, () => ({
      kind: "supervisor.ready" as const,
      sandboxId: "sb-1",
    }));
    expect(runnerEventsRequestSchema.safeParse({ events: many }).success).toBe(
      false,
    );
    expect(
      runnerEventsRequestSchema.safeParse({ events: many.slice(0, 100) })
        .success,
    ).toBe(true);
  });
});

describe("heartbeat", () => {
  it("accepts an empty heartbeat and a capability refresh", () => {
    expect(runnerHeartbeatRequestSchema.safeParse({}).success).toBe(true);
    expect(
      runnerHeartbeatRequestSchema.safeParse({ capabilities }).success,
    ).toBe(true);
  });
});

describe("turn events on the wire", () => {
  const agentEvent = { type: "text.delta" as const, text: "hi" };

  it("round-trips a coalesced batch", () => {
    const event = runnerEventSchema.parse({
      kind: "turn.events",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
      events: [agentEvent, { type: "turn.done" }],
    });
    if (event.kind !== "turn.events") throw new Error("wrong kind");
    expect(event.events).toHaveLength(2);
  });

  it("bounds a batch at 100 — the runner must chunk, not overflow", () => {
    const many = Array.from({ length: 101 }, () => agentEvent);
    expect(
      runnerEventSchema.safeParse({
        kind: "turn.events",
        sandboxId: "sb-1",
        conversationId: "cv-1",
        turnId: "t-1",
        events: many,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty batch", () => {
    expect(
      runnerEventSchema.safeParse({
        kind: "turn.events",
        sandboxId: "sb-1",
        conversationId: "cv-1",
        turnId: "t-1",
        events: [],
      }).success,
    ).toBe(false);
  });

  it("round-trips turn.progress — identity only, and every id required", () => {
    const beat = {
      kind: "turn.progress",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
    };
    expect(runnerEventSchema.parse(beat)).toEqual(beat);
    expect(
      runnerEventSchema.safeParse({
        kind: "turn.progress",
        conversationId: "cv-1",
        turnId: "t-1",
      }).success,
    ).toBe(false);
  });

  it("round-trips turn.finished carrying usage and the session ref", () => {
    const event = runnerEventSchema.parse({
      kind: "turn.finished",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
      status: "done",
      usage: { inputTokens: 10, outputTokens: 20 },
      sessionRef: "sess-abc",
    });
    if (event.kind !== "turn.finished") throw new Error("wrong kind");
    expect(event.sessionRef).toBe("sess-abc");
  });

  it("carries an optional errorCode on turn.finished, absent by default", () => {
    const coded = runnerEventSchema.parse({
      kind: "turn.finished",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
      status: "failed",
      error: "harness launch failed: Error: spawn ENOENT",
      errorCode: "agent_start_failed",
    });
    if (coded.kind !== "turn.finished") throw new Error("wrong kind");
    expect(coded.errorCode).toBe("agent_start_failed");

    const bare = runnerEventSchema.parse({
      kind: "turn.finished",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
      status: "failed",
    });
    if (bare.kind !== "turn.finished") throw new Error("wrong kind");
    expect(bare.errorCode).toBeUndefined();
  });

  it("rejects a terminal status outside the set", () => {
    expect(
      runnerEventSchema.safeParse({
        kind: "turn.finished",
        sandboxId: "sb-1",
        conversationId: "cv-1",
        turnId: "t-1",
        status: "running",
      }).success,
    ).toBe(false);
  });
});

/** The runner hop of the step-8 context field — forwarded verbatim, bounded
 * the same, dropped the same by a stale peer. */
describe("turn.deliver context (runner wire)", () => {
  const base = {
    kind: "turn.deliver",
    sandboxId: "sb-1",
    conversationId: "conv-1",
    turnId: "t-1",
    message: "hello",
  };

  it("parses with and without context", () => {
    expect(runnerWorkItemSchema.parse(base)).not.toHaveProperty("context");
    const parsed = runnerWorkItemSchema.parse({ ...base, context: "[mem]" });
    expect(parsed.kind === "turn.deliver" && parsed.context).toBe("[mem]");
  });

  it("rejects a context past its cap", () => {
    expect(
      runnerWorkItemSchema.safeParse({ ...base, context: "x".repeat(16_001) })
        .success,
    ).toBe(false);
  });

  it("drops an unknown extra field silently", () => {
    expect(
      runnerWorkItemSchema.parse({ ...base, someFutureField: "x" }),
    ).not.toHaveProperty("someFutureField");
  });
});

/**
 * The home-sync pair (step 9). The byte law matters most: a part is
 * budgeted in UTF-8 BYTES of its projected supervisor frame — a chars budget
 * would let multi-byte content blow the runner WS's silent 256KB drop.
 */
describe("skills.changed + home.synced (runner wire)", () => {
  const syncItem = {
    kind: "skills.changed",
    sandboxId: "sb-1",
    generation: 3,
    parts: [
      { files: [{ path: ".agents/skills/deploy/SKILL.md", content: "# d" }] },
      {
        files: [{ path: "memory/index.md", content: "# Memory index" }],
        prune: [".agents/skills/deploy/SKILL.md", "memory/index.md"],
        instructions: "You are careful.",
        agentName: "andy",
      },
    ],
  };

  it("round-trips a two-part sync item", () => {
    const parsed = runnerWorkItemSchema.parse(syncItem);
    expect(parsed.kind === "skills.changed" && parsed.parts).toHaveLength(2);
  });

  it("rejects generation zero, empty parts, and too many parts", () => {
    expect(
      runnerWorkItemSchema.safeParse({ ...syncItem, generation: 0 }).success,
    ).toBe(false);
    expect(
      runnerWorkItemSchema.safeParse({ ...syncItem, parts: [] }).success,
    ).toBe(false);
    expect(
      runnerWorkItemSchema.safeParse({
        ...syncItem,
        parts: Array.from({ length: MAX_SYNC_PARTS + 1 }, () => ({
          files: [],
        })),
      }).success,
    ).toBe(false);
  });

  it("traversal is unrepresentable on the sync wire", () => {
    for (const path of ["../evil", "/abs", "a\\b", "a//b", "a/./b", "\0x"]) {
      expect(
        runnerWorkItemSchema.safeParse({
          ...syncItem,
          parts: [{ files: [{ path, content: "x" }] }],
        }).success,
        path,
      ).toBe(false);
    }
  });

  it("bounds a part by BYTES, not chars — multi-byte content must not slip through", () => {
    // 90k chars of a 3-byte CJK glyph ≈ 270KB serialized: passes any chars
    // budget under 100k, fails the byte budget. The mutation that swaps
    // bytes for chars dies here.
    const cjk = "世".repeat(90_000);
    expect(cjk.length).toBeLessThan(100_000);
    expect(
      runnerWorkItemSchema.safeParse({
        ...syncItem,
        parts: [{ files: [{ path: "memory/big.md", content: cjk }] }],
      }).success,
    ).toBe(false);
  });

  it("round-trips the home.synced runner event and rejects a missing generation", () => {
    expect(
      runnerEventSchema.parse({
        kind: "home.synced",
        sandboxId: "sb-1",
        generation: 7,
      }).kind,
    ).toBe("home.synced");
    expect(
      runnerEventSchema.safeParse({
        kind: "home.synced",
        sandboxId: "sb-1",
      }).success,
    ).toBe(false);
  });
});

describe("process.state (runner wire, step 10)", () => {
  it("round-trips with the runner's two stamped facts", () => {
    const event = {
      kind: "process.state",
      sandboxId: "sb-1",
      containerRef: "cont-abc",
      process: {
        ref: "p-1",
        command: "sleep 5",
        status: "running",
        startedAt: "2026-08-08T00:00:00.000Z",
        watches: [],
      },
    };
    expect(runnerEventSchema.parse(event)).toEqual(event);
  });

  it("refuses a frame with no containerRef — an unstamped fact never lands", () => {
    expect(
      runnerEventSchema.safeParse({
        kind: "process.state",
        sandboxId: "sb-1",
        process: {
          ref: "p-1",
          command: "sleep 5",
          status: "running",
          startedAt: "2026-08-08T00:00:00.000Z",
          watches: [],
        },
      }).success,
    ).toBe(false);
  });
});
