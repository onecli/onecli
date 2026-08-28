import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@onecli/agent-protocol";

/**
 * The jcode adapter against a MOCKED SDK — the layer between the pure
 * matcher (jcode.steering.test.ts) and the env-gated live suites. What only
 * this level can pin:
 *
 * - THE CONNECTION MODEL (the stuck-sandbox incident's root): one
 *   `launchInstance` per container, one `JcodeClient.connect` per
 *   conversation, a DISTINCT session per connection — the mock mints
 *   sessions per connection precisely so a regression back to a shared
 *   client fails here instead of only in production.
 * - The launch env pins (`JCODE_DISABLED_TOOLS`, the swarm fence,
 *   `JCODE_NO_AUTO_UPDATE`, `inheritLogins: false`) at the `launchInstance`
 *   boundary — previously only the live conformance run could see them.
 * - The busy self-heal: a send refused with the daemon's busy wording
 *   cancels the orphan run and resends, bounded; exhaustion fails coded
 *   (`harness_busy`); a user abort mid-heal is never answered by a resend.
 * - `applyPreferences` honesty: a daemon-coded refusal earns a notice; an
 *   SDK `timeout` (a DEFERRED op, not an answer) must not.
 * - The steer plumbing: turn-start interrupt cancel, non-urgent
 *   `softInterrupt`, refusal between turns, and the terminal reconcile.
 */

interface FakeCall {
  method: string;
  args: unknown[];
}

/** The mock connection, as tests see it: frames can be pushed mid-stream,
 * the stream can be ended from outside (a daemon death), and named emitter
 * events (the SDK's per-kind channels) can be raised. */
interface PushableClient {
  sessionId: string;
  push(frame: unknown): void;
  end(): void;
  emitNamed(event: string, frame: unknown): void;
}

const state: {
  calls: FakeCall[];
  launches: { options: Record<string, unknown> }[];
  clients: PushableClient[];
  connects: { options: Record<string, unknown> }[];
  sessionCounter: number;
  /** Frames a successfully-accepted send delivers (the turn's script). */
  events: { ev: string; [key: string]: unknown }[];
  /** How many sends the "daemon" refuses busy before accepting. */
  busyRefusals: number;
  history: { role: string; content: string }[];
  historyError: Error | null;
  /** Rejections dealt to getHistory calls one at a time (barrier retries). */
  historyErrorQueue: Error[];
  /** When set, getHistory records the call, then holds until this resolves —
   * the deterministic way to keep the spawn barrier standing in a test. */
  historyGate: Promise<void> | null;
  softInterruptError: Error | null;
  setModelError: Error | null;
  setEffortError: Error | null;
} = {
  calls: [],
  launches: [],
  clients: [],
  connects: [],
  sessionCounter: 0,
  events: [{ ev: "turn_done" }],
  busyRefusals: 0,
  history: [],
  historyError: null,
  historyErrorQueue: [],
  historyGate: null,
  softInterruptError: null,
  setModelError: null,
  setEffortError: null,
};

vi.mock("@1jehuang/jcode-sdk", () => {
  const record = (method: string, ...args: unknown[]) => {
    state.calls.push({ method, args });
  };
  class MockClient {
    readonly sessionId: string;
    private readonly frames: unknown[] = [];
    private streamWaiter?: (result: IteratorResult<unknown>) => void;
    private streamDone = false;
    constructor(sessionId: string) {
      this.sessionId = sessionId;
    }
    push(frame: unknown) {
      const waiter = this.streamWaiter;
      if (waiter) {
        this.streamWaiter = undefined;
        waiter({ value: frame, done: false });
      } else {
        this.frames.push(frame);
      }
    }
    end() {
      this.streamDone = true;
      const waiter = this.streamWaiter;
      this.streamWaiter = undefined;
      waiter?.({ value: undefined, done: true });
    }
    private readonly namedHandlers = new Map<
      string,
      ((frame: unknown) => void)[]
    >();
    emitNamed(event: string, frame: unknown) {
      for (const handler of this.namedHandlers.get(event) ?? []) {
        handler(frame);
      }
    }
    static connect(options: Record<string, unknown>) {
      state.connects.push({ options });
      state.sessionCounter += 1;
      const client = new MockClient(`s-${state.sessionCounter}`);
      state.clients.push(client);
      return Promise.resolve(client);
    }
    on(event: string, handler: (frame: unknown) => void) {
      const list = this.namedHandlers.get(event) ?? [];
      list.push(handler);
      this.namedHandlers.set(event, list);
    }
    close() {
      record("close", this.sessionId);
      return Promise.resolve();
    }
    createSession(workingDir: string) {
      record("createSession", workingDir);
      // Session per CONNECTION — the daemon's real model. A shared-client
      // regression would hand every conversation the same id again.
      return Promise.resolve({ session_id: this.sessionId });
    }
    attachSession(id: string) {
      record("attachSession", id);
      return Promise.resolve({ session_id: id });
    }
    setModel(sessionId: string, model: string) {
      record("setModel", sessionId, model);
      return state.setModelError
        ? Promise.reject(state.setModelError)
        : Promise.resolve();
    }
    setReasoningEffort(sessionId: string, effort: string) {
      record("setReasoningEffort", sessionId, effort);
      return state.setEffortError
        ? Promise.reject(state.setEffortError)
        : Promise.resolve();
    }
    sendMessage(sessionId: string, content: string) {
      record("sendMessage", sessionId, content);
      // Delivery rides a macrotask, matching the wire: the real daemon
      // never streams a turn's frames inside the send call itself, and the
      // adapter's spawn barrier (an instant getHistory here) must win the
      // race exactly as it does live. FIFO within the one timeout.
      setTimeout(() => {
        if (state.busyRefusals > 0) {
          state.busyRefusals -= 1;
          // The daemon's refusal: a broadcast error frame, never a rejection
          // (the SDK's send is fire-and-forget) — exactly the live shape.
          this.push({ ev: "error", message: "Already processing a message" });
        } else {
          for (const frame of state.events) this.push(frame);
        }
      }, 0);
      return Promise.resolve();
    }
    softInterrupt(sessionId: string, content: string, urgent?: boolean) {
      record("softInterrupt", sessionId, content, urgent);
      return state.softInterruptError
        ? Promise.reject(state.softInterruptError)
        : Promise.resolve();
    }
    cancelSoftInterrupts(sessionId: string) {
      record("cancelSoftInterrupts", sessionId);
      return Promise.resolve();
    }
    getHistory(sessionId: string) {
      // Recorded synchronously — call-order assertions depend on it.
      record("getHistory", sessionId);
      const queued = state.historyErrorQueue.shift();
      if (queued) return Promise.reject(queued);
      if (state.historyError) return Promise.reject(state.historyError);
      const gate = state.historyGate;
      return gate
        ? gate.then(() => state.history)
        : Promise.resolve(state.history);
    }
    cancel(sessionId: string) {
      record("cancel", sessionId);
      return Promise.resolve();
    }
    respondToPermission(sessionId: string, requestId: string, verdict: string) {
      record("respondToPermission", sessionId, requestId, verdict);
      return Promise.resolve();
    }
    events(): AsyncIterableIterator<unknown> {
      // Hand-rolled like the SDK's real iterator (never an async generator):
      // `return()` must unblock a PENDING `next()` immediately — an async
      // generator parked mid-await queues the return call forever, which is
      // not how the real stream behaves.
      const finish = (): Promise<IteratorResult<unknown>> => {
        this.streamDone = true;
        const waiter = this.streamWaiter;
        this.streamWaiter = undefined;
        waiter?.({ value: undefined, done: true });
        return Promise.resolve({ value: undefined, done: true });
      };
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: (): Promise<IteratorResult<unknown>> => {
          if (this.frames.length > 0) {
            return Promise.resolve({ value: this.frames.shift(), done: false });
          }
          if (this.streamDone) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            this.streamWaiter = resolve;
          });
        },
        return: finish,
        throw: finish,
      };
    }
  }
  return {
    JcodeClient: MockClient,
    launchInstance: (options: Record<string, unknown>) => {
      state.launches.push({ options });
      return Promise.resolve({
        socketPath: "/tmp/fake-jcode-api.sock",
        jcodeHome: String(options.jcodeHome ?? ""),
        process: { once: () => undefined },
        shutdown: () => Promise.resolve(),
      });
    },
    // Something that exists on disk — resolveJcodeBinary demands a real path.
    bundledJcodeBinary: () => process.execPath,
  };
});

import { BUSY_RESEND_DELAYS_MS, createJcodeHarness } from "./jcode";

const ORIGINAL_DELAYS = [...BUSY_RESEND_DELAYS_MS];

const collect = async (
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
};

const startSession = async (options?: {
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  resumeSessionRef?: string;
  harness?: ReturnType<typeof createJcodeHarness>;
  context?: { conversationId: string };
}) => {
  const harness = options?.harness ?? createJcodeHarness();
  const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
  const session = await harness.startSession({
    homeDir,
    ...(options?.model && { model: options.model }),
    ...(options?.effort && { effort: options.effort }),
    ...(options?.resumeSessionRef && {
      resumeSessionRef: options.resumeSessionRef,
    }),
    ...(options?.context && { context: options.context }),
  });
  return { harness, session, homeDir };
};

const callsOf = (method: string) =>
  state.calls.filter((c) => c.method === method);

beforeEach(() => {
  state.calls = [];
  state.launches = [];
  state.clients = [];
  state.connects = [];
  state.sessionCounter = 0;
  state.events = [{ ev: "turn_done" }];
  state.busyRefusals = 0;
  state.history = [];
  state.historyError = null;
  state.historyErrorQueue = [];
  state.historyGate = null;
  state.softInterruptError = null;
  state.setModelError = null;
  state.setEffortError = null;
  delete process.env.ONECLI_JCODE_BINARY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  // Some suites shorten the heal backoff to keep tests fast; the exported
  // array is shared module state, so restore it.
  BUSY_RESEND_DELAYS_MS.splice(
    0,
    BUSY_RESEND_DELAYS_MS.length,
    ...ORIGINAL_DELAYS,
  );
});

describe("the connection model", () => {
  it("launches ONE instance and dials one connection per conversation, with DISTINCT sessions", async () => {
    // MUTATION-PROOF for the incident's root: a shared client would return
    // the same session for both conversations — the busy collision.
    const harness = createJcodeHarness();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const first = await harness.startSession({ homeDir });
    const second = await harness.startSession({ homeDir });

    expect(state.launches).toHaveLength(1);
    expect(state.connects).toHaveLength(2);
    expect(first.sessionRef).toBe("s-1");
    expect(second.sessionRef).toBe("s-2");
    expect(first.sessionRef).not.toBe(second.sessionRef);
  });

  it("pins the launch env at the launchInstance boundary", async () => {
    await startSession();
    const options = state.launches[0]?.options as {
      inheritLogins?: boolean;
      binary?: string;
      env?: Record<string, string>;
    };
    expect(options.inheritLogins).toBe(false);
    expect(options.binary).toBe(process.execPath);
    expect(options.env?.JCODE_NO_TELEMETRY).toBe("1");
    expect(options.env?.JCODE_NO_AUTO_UPDATE).toBe("1");
    expect(options.env?.JCODE_DISABLED_TOOLS).toContain("memory");
    expect(options.env?.JCODE_SWARM_MAX_CONCURRENT_AGENTS).toBe("8");
    expect(options.env?.JCODE_SWARM_SPAWN_MODE).toBe("headless");
    expect(options.env?.JCODE_DISABLE_CLAUDE_MCP).toBe("1");
    // External wake ownership: the daemon proposes, the platform disposes —
    // no invisible self-wake turns (v0.81+; inert on older daemons).
    expect(options.env?.JCODE_WAKE_MODE).toBe("external");
    // The platform-tool cliff fence: never let the auto mode swap mcp__*
    // definitions for a generic search/call pair.
    expect(options.env?.JCODE_MCP_TOOLS).toBe("eager");
  });

  it("a resume ref held by a LIVE conversation mints a FRESH session — never steals", async () => {
    // One ref, one conversation: a live in-process holder means the ref is
    // corrupted duplicate data (the pre-fix shared-session bug persisted
    // exactly this to real installs). Stealing would brick the holder's
    // conversation for the container's life; the resumer gets a fresh
    // session whose new ref heals the duplication forward.
    const harness = createJcodeHarness();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const first = await harness.startSession({ homeDir });
    const firstRef = first.sessionRef;
    if (!firstRef) throw new Error("expected a session ref");

    const resumed = await harness.startSession({
      homeDir,
      resumeSessionRef: firstRef,
    });

    // Fresh mint: no attach, no close of the live holder, a NEW session id.
    expect(callsOf("attachSession")).toHaveLength(0);
    expect(callsOf("close")).toHaveLength(0);
    expect(resumed.sessionRef).toBe("s-2");
    // The holder's session still serves — the brick this rule prevents.
    const events = await collect(first.runTurn({ message: "still alive?" }));
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("a resume ref with NO live holder attaches normally — the restart shape", async () => {
    const harness = createJcodeHarness();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));

    const resumed = await harness.startSession({
      homeDir,
      resumeSessionRef: "s-from-a-previous-container",
    });

    expect(callsOf("attachSession")).toEqual([
      { method: "attachSession", args: ["s-from-a-previous-container"] },
    ]);
    expect(resumed.sessionRef).toBe("s-from-a-previous-container");
  });

  it("a busy refusal arriving AFTER the settle window still earns the code", async () => {
    // A loaded daemon can answer late: the refusal then reaches the live
    // loop, which must still mint harness_busy (no retry at that point, but
    // never the silent uncoded shape again).
    state.events = []; // send accepted, nothing streams
    const { session } = await startSession();
    const collected = collect(session.runTurn({ message: "task" }));
    // Past the settle window, then the refusal lands.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    state.clients[0]?.push({
      ev: "error",
      message: "Already processing a message",
    });
    const events = await collected;

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "harness_busy",
    });
  });

  it("a failed session setup closes ITS connection and stays non-fatal", async () => {
    let failure: string | undefined;
    const harness = createJcodeHarness();
    harness.onFailure((reason) => {
      failure = reason;
    });
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    // A code-LESS error is a dead channel: applyPreferences rethrows it.
    state.setModelError = new Error("socket ripped");
    await expect(
      harness.startSession({ homeDir, model: "some-model" }),
    ).rejects.toThrow("socket ripped");

    expect(callsOf("close")).toHaveLength(1);
    // Session-level failure — the container is not declared dead.
    expect(failure).toBeUndefined();

    // And the harness still serves the next conversation.
    state.setModelError = null;
    const session = await harness.startSession({ homeDir });
    expect(session.sessionRef).toBe("s-2");
  });
});

describe("applyPreferences honesty", () => {
  const noticesOf = async (session: {
    runTurn: (input: { message: string }) => AsyncIterable<AgentEvent>;
  }) => {
    const events = await collect(session.runTurn({ message: "hello" }));
    return events.filter((e) => e.type === "notice");
  };

  it("a daemon-coded refusal earns the model notice", async () => {
    state.setModelError = Object.assign(new Error("invalid_request"), {
      code: "invalid_request",
    });
    const { session } = await startSession({ model: "nope-model" });
    const notices = await noticesOf(session);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "notice" });
    expect((notices[0] as { text: string }).text).toContain(
      "isn't available here",
    );
  });

  it("an SDK timeout is a DEFERRED op, not a refusal — no false notice", async () => {
    // The incident's 60s lie: a busy session defers control ops, the SDK
    // times out, and the user was told their model "isn't available".
    state.setModelError = Object.assign(
      new Error("timeout: no reply to set_model within 30000ms"),
      { code: "timeout" },
    );
    state.setEffortError = Object.assign(
      new Error("timeout: no reply to set_reasoning_effort within 30000ms"),
      { code: "timeout" },
    );
    const { session } = await startSession({
      model: "real-model",
      effort: "low",
    });
    const notices = await noticesOf(session);
    expect(notices).toHaveLength(0);
  });
});

describe("the busy self-heal", () => {
  beforeEach(() => {
    // Keep the heal cycle fast; afterEach restores the real backoff.
    BUSY_RESEND_DELAYS_MS.splice(0, BUSY_RESEND_DELAYS_MS.length, 10, 10, 10);
  });

  it("a busy refusal cancels the orphan run and resends — the turn completes", async () => {
    state.busyRefusals = 1;
    state.events = [
      { ev: "text_delta", text: "the real answer" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "task" }));

    const order = state.calls.map((c) => c.method);
    const firstSend = order.indexOf("sendMessage");
    const cancel = order.indexOf("cancel");
    const resend = order.lastIndexOf("sendMessage");
    expect(firstSend).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(firstSend);
    expect(resend).toBeGreaterThan(cancel);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text.includes("real answer"),
      ),
    ).toBe(true);
  });

  it("an actively-streaming orphan's output never leaks into this turn", async () => {
    state.busyRefusals = 1;
    state.events = [{ ev: "text_delta", text: "ours" }, { ev: "turn_done" }];
    const { session } = await startSession();

    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    // The orphan streams into the subscription before our send settles.
    state.clients[0]?.push({ ev: "text_delta", text: "ORPHAN-OUTPUT" });

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text.includes("ORPHAN-OUTPUT"),
      ),
    ).toBe(false);
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "ours"),
    ).toBe(true);
  });

  it("exhaustion fails CODED — harness_busy, visible, never a silent empty error", async () => {
    state.busyRefusals = 99;
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "task" }));

    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: "error",
      code: "harness_busy",
    });
    expect((terminal as { message: string }).message).toContain(
      "Already processing",
    );
    // Bounded: one send per configured backoff slot plus the first.
    expect(callsOf("sendMessage")).toHaveLength(
      BUSY_RESEND_DELAYS_MS.length + 1,
    );
  });

  it("a user abort mid-heal ends the turn — never answered by a resend", async () => {
    state.busyRefusals = 99;
    const { session } = await startSession();

    const collected = collect(session.runTurn({ message: "task" }));
    // Let the first refusal land, then stop.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sendsBeforeAbort = callsOf("sendMessage").length;
    await session.abort();
    const events = await collected;

    expect(events.at(-1)?.type).toBe("turn.done");
    // The heal loop noticed the abort: at most one more in-flight send could
    // have raced the flag, and nothing continued after it.
    expect(callsOf("sendMessage").length).toBeLessThanOrEqual(
      sendsBeforeAbort + 1,
    );
  });

  it("a stale request reply (reply_to) never terminates the live turn", async () => {
    // Observed live: a deferred set_reasoning_effort reply arriving minutes
    // late as an error frame, killing an unrelated stream.
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    state.clients[0]?.push({
      ev: "error",
      reply_to: 8,
      code: "invalid_request",
      message: "Reasoning effort is not supported",
    });

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("the jcode steer plumbing", () => {
  it("cancels leaked interrupts at TURN START, before the message is sent", async () => {
    // MUTATION-PROOF for the leak belt: remove the turn-start
    // cancelSoftInterrupts and an interrupt queued at the previous turn's
    // very end is injected into THIS unrelated run.
    const { session } = await startSession();
    await collect(session.runTurn({ message: "hello" }));

    const order = state.calls.map((c) => c.method);
    const firstCancel = order.indexOf("cancelSoftInterrupts");
    const send = order.indexOf("sendMessage");
    expect(firstCancel).toBeGreaterThan(-1);
    expect(firstCancel).toBeLessThan(send);
  });

  it("steer maps to a NON-URGENT softInterrupt while the turn runs", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started — the gate is open

    await session.steer?.({ id: "f1", message: "fold this in" });

    expect(callsOf("softInterrupt")).toEqual([
      { method: "softInterrupt", args: ["s-1", "fold this in", false] },
    ]);
    // Drain to completion so the shared fake stays clean.
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
  });

  it("REFUSES a steer between turns — never queued for a later run", async () => {
    const { session } = await startSession();
    await expect(
      session.steer?.({ id: "f1", message: "too early" }),
    ).rejects.toThrow("no turn in flight");
    expect(callsOf("softInterrupt")).toHaveLength(0);
  });

  it("propagates a coded harness refusal from softInterrupt", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.softInterruptError = Object.assign(new Error("unknown_session"), {
      code: "unknown_session",
    });
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();

    await expect(
      session.steer?.({ id: "f1", message: "wrong session" }),
    ).rejects.toThrow("unknown_session");

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }
    // Never tracked as delivered → never confirmed joined.
    expect(events.some((e) => e.type === "message.joined")).toBe(false);
  });

  it("reconciles at the terminal: cancel → history → message.joined BEFORE turn.done", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    // History GROWS like the real daemon's: the prompt alone at turn start
    // (when the baseline is captured), the injection appended later.
    state.history = [{ role: "user", content: "task" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "fold this in" });
    state.history = [
      { role: "user", content: "task" },
      { role: "assistant", content: "on it" },
      { role: "user", content: "fold this in" },
    ];

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("message.joined");
    expect(kinds.indexOf("message.joined")).toBeLessThan(
      kinds.indexOf("turn.done"),
    );
    // Cancel precedes the RECONCILE history read (the first read is the
    // turn-start baseline capture): after the cancel nothing more can
    // inject, so the read is stable.
    const order = state.calls.map((c) => c.method);
    expect(order.lastIndexOf("cancelSoftInterrupts")).toBeLessThan(
      order.lastIndexOf("getHistory"),
    );
  });

  it("a steer whose text EQUALS the prompt still reconciles joined — the index anchor", async () => {
    // The content-anchor trap: matching the prompt from the END would find
    // the INJECTED copy and read everything out of the window. The baseline
    // index makes the duplicate a normal candidate.
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.history = [{ role: "user", content: "again" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "again" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "again" });
    state.history = [
      { role: "user", content: "again" },
      { role: "assistant", content: "working on it" },
      { role: "user", content: "again" },
    ];

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(
      events.some((e) => e.type === "message.joined" && e.followUpId === "f1"),
    ).toBe(true);
  });

  it("a steer matching only the turn's OWN prompt reads as missed — never joined", async () => {
    // The false-positive the exact-window rule kills: "ok" appears inside
    // the prompt (memory context + message travel there verbatim), and a
    // matcher over the whole history would mark it joined — the message
    // silently swallowed.
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.history = [
      { role: "user", content: "please check everything is ok today" },
      { role: "assistant", content: "done" },
    ];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "please check everything is ok today" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "ok" });

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(events.some((e) => e.type === "message.joined")).toBe(false);
  });

  it("a history failure degrades every pending steer to missed", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    state.historyError = new Error("bridge went away");
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();
    await session.steer?.({ id: "f1", message: "fold this in" });

    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    // No joined events — and the terminal still arrived (the turn is not
    // held hostage by the reconcile).
    expect(events.some((e) => e.type === "message.joined")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("abort also drops the daemon's queued interrupts — Stop means silence", async () => {
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next();

    await session.abort();

    const order = state.calls.map((c) => c.method);
    // Both verbs fired, cancel-interrupts before the hard cancel.
    expect(
      order.filter((m) => m === "cancelSoftInterrupts").length,
    ).toBeGreaterThanOrEqual(2); // turn-start + abort
    expect(order).toContain("cancel");
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
  });
});

describe("the spawn barrier", () => {
  beforeEach(() => {
    // Keep the heal cycle fast; afterEach restores the real backoff.
    BUSY_RESEND_DELAYS_MS.splice(0, BUSY_RESEND_DELAYS_MS.length, 10, 10, 10);
  });

  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  const drain = async (
    iterator: AsyncIterator<AgentEvent>,
  ): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }
    return events;
  };

  it("a self-wake run's frames are quarantined — never yielded, never our terminal", async () => {
    // Our turn's frames are pushed manually AFTER the gate opens — the wire
    // truth (our turn cannot stream before it spawned), which the flat
    // macrotask delivery of state.events cannot express under a held gate.
    state.events = [];
    let openGate = () => {};
    state.historyGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started

    // The wake run streams while the barrier stands: text, a tool, usage,
    // a permission prompt, and a FAILURE terminal — every one another run's.
    const client = state.clients[0];
    client?.push({ ev: "text_delta", text: "WAKE-LEAK imagery" });
    client?.push({ ev: "tool_start", call_id: "w1", name: "bash" });
    client?.push({ ev: "token_usage", input: 999, output: 999 });
    client?.push({
      ev: "permission_request",
      request_id: "wp1",
      tool_name: "bash",
      description: "",
    });
    client?.push({ ev: "error", message: "the wake run failed" });
    await tick(5);

    // Our turn spawns: the barrier reply lands, then our frames.
    state.historyGate = null;
    openGate();
    await tick(5);
    client?.push({ ev: "text_delta", text: "ours" });
    client?.push({ ev: "turn_done" });

    const events = await drain(iterator);

    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text.includes("WAKE-LEAK"),
      ),
    ).toBe(false);
    expect(events.some((e) => e.type === "tool.started")).toBe(false);
    // The foreign failure was NOT adopted as our terminal.
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "ours"),
    ).toBe(true);
    // A foreign usage report is the wake run's spend, never ours.
    expect(
      (events.at(-1) as { usage?: unknown } | undefined)?.usage,
    ).toBeUndefined();
    // The foreign permission prompt was still answered — unanswered, it
    // would wedge the daemon (and the mutex our send waits on) forever.
    expect(callsOf("respondToPermission")).toHaveLength(1);
    // The exclusion is never silent: exactly one warn notice, pre-terminal.
    const notices = events.filter((e) => e.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "warn" });
    expect((notices[0] as { text: string }).text).toContain("overlapped");
  }, 15_000);

  it("a busy refusal stamped foreign still heals — the refusal outranks the quarantine", async () => {
    // The wire order is fixed: the refusal broadcasts while the daemon
    // processes our send, i.e. strictly before any barrier reply — so it
    // ALWAYS arrives under a pending barrier. Quarantining it would kill
    // the self-heal; this is the pin that it never happens.
    state.busyRefusals = 1;
    state.events = [
      { ev: "text_delta", text: "the real answer" },
      { ev: "turn_done" },
    ];
    let openGate = () => {};
    state.historyGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    // Orphan residue precedes the refusal — its discard is the heal's,
    // silent, and must never mint the exclusion notice.
    state.clients[0]?.push({ ev: "text_delta", text: "ORPHAN-RESIDUE" });
    await tick(5);
    state.historyGate = null;
    openGate();

    const events = await drain(iterator);

    const order = state.calls.map((c) => c.method);
    expect(order).toContain("cancel");
    expect(callsOf("sendMessage")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text.includes("real answer"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text.includes("ORPHAN-RESIDUE"),
      ),
    ).toBe(false);
    expect(events.some((e) => e.type === "notice")).toBe(false);
  }, 15_000);

  it("frames in the subscribe→send gap are quarantined — the former known residual", async () => {
    // An orphan finishing naturally in the gap used to land its terminal in
    // `held` and read as an instant empty end. Now it is foreign like any
    // pre-barrier frame, and the accepted send streams normally after it.
    state.events = [{ ev: "text_delta", text: "ours" }, { ev: "turn_done" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    // Pushed before the first pull: these sit in the stream buffer ahead of
    // everything, exactly like a dying orphan's last frames.
    state.clients[0]?.push({ ev: "text_delta", text: "GAP-ORPHAN tail" });
    state.clients[0]?.push({ ev: "turn_done" });

    const events = await drain(iterator);

    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text.includes("GAP-ORPHAN"),
      ),
    ).toBe(false);
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "ours"),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.done");
    // The dropped text is reported.
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  }, 15_000);

  it("the barrier retries through SDK timeouts and the turn completes", async () => {
    const timeoutError = () =>
      Object.assign(new Error("no reply to get_history within 30000ms"), {
        code: "timeout",
      });
    state.historyErrorQueue = [timeoutError(), timeoutError()];
    state.events = [{ ev: "text_delta", text: "ours" }, { ev: "turn_done" }];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "task" }));

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "ours"),
    ).toBe(true);
    // Two timed-out attempts, then the resolving one. No steers, so the
    // reconcile never reads history — the count is the barrier's alone.
    expect(callsOf("getHistory")).toHaveLength(3);
  }, 15_000);

  it("a non-timeout barrier failure opens the gate after ONE attempt", async () => {
    // `disconnected`, an unknown session, a closing channel — retrying
    // cannot help, and quarantining forever would silence a healthy turn.
    state.historyErrorQueue = [new Error("boom")];
    state.events = [{ ev: "text_delta", text: "ours" }, { ev: "turn_done" }];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "task" }));

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "ours"),
    ).toBe(true);
    expect(callsOf("getHistory")).toHaveLength(1);
  }, 15_000);

  it("a stale non-error reply (ev history, reply_to) is never a turn event", async () => {
    // A timed-out barrier attempt's late reply re-enters the stream as an
    // `ev:"history"` frame carrying reply_to — dropped, never content.
    state.events = [{ ev: "text_delta", text: "working" }, { ev: "turn_done" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    state.clients[0]?.push({ ev: "history", reply_to: 8, messages: [] });

    const events = await drain(iterator);

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "notice")).toBe(false);
  }, 15_000);

  it("an abort under a standing barrier ends the turn within the tick", async () => {
    // While the barrier stands the request loop is frozen daemon-side — the
    // abort cannot be confirmed by a cancel frame, so the live loop's tick
    // honors it directly instead of hanging for the foreign run's life.
    state.events = [];
    state.historyGate = new Promise<void>(() => {}); // never opens
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started

    const started = Date.now();
    const drained = drain(iterator);
    await tick(5);
    await session.abort();
    const events = await drained;

    expect(events.at(-1)?.type).toBe("turn.done");
    // Bounded by the settle window plus one live-loop tick, with margin.
    expect(Date.now() - started).toBeLessThan(5_000);
    // The heal never ran: one send, no resend answered the aborted turn.
    expect(callsOf("sendMessage")).toHaveLength(1);
  }, 15_000);

  it("stream death under a standing barrier fails visibly and still reports the drop", async () => {
    state.events = [];
    state.historyGate = new Promise<void>(() => {}); // never opens
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    const client = state.clients[0];
    client?.push({ ev: "text_delta", text: "WAKE-LEAK before death" });
    await tick(5);
    client?.end();

    const events = await drain(iterator);

    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    expect((terminal as { message?: string }).message).toContain(
      "ended unexpectedly",
    );
    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text.includes("WAKE-LEAK"),
      ),
    ).toBe(false);
    // No trusted frame ever arrived, so the end-of-turn flush owns the story.
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  }, 15_000);

  it("a clean turn quarantines nothing and mints no notice", async () => {
    state.events = [{ ev: "text_delta", text: "plain" }, { ev: "turn_done" }];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "task" }));

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "plain"),
    ).toBe(true);
    expect(events.some((e) => e.type === "notice")).toBe(false);
  });
});

describe("the external wake listener", () => {
  /** The harness's merged feed, polled the way the observer does. Bash and
   * swarm sources fail harmlessly in this rig (no registry, no socket) —
   * the merge isolates per source, so only wake entries come back. */
  const wakeTasks = async (harness: ReturnType<typeof createJcodeHarness>) => {
    const tasks = (await harness.backgroundTasks?.poll()) ?? [];
    return tasks.filter((t) => t.ref.startsWith("wake:"));
  };

  it("mirrors an owned session's wake request as a synthetic task bound to its conversation", async () => {
    const { harness } = await startSession({
      context: { conversationId: "cv-lead" },
    });

    state.clients[0]?.emitNamed("wake_requested", {
      ev: "wake_requested",
      session_id: state.clients[0].sessionId,
      reason: "swarm_await_completed",
      notification: "🐝 all members done",
    });

    const tasks = await wakeTasks(harness);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: "exited",
      wantsWake: true,
      context: { conversationId: "cv-lead" },
    });
    expect(tasks[0]?.outputDelta).toContain("all members done");
  });

  it("drops a wake for a session this connection does not own (helper/broadcast wakes)", async () => {
    const { harness } = await startSession({
      context: { conversationId: "cv-lead" },
    });

    state.clients[0]?.emitNamed("wake_requested", {
      ev: "wake_requested",
      session_id: "someone-elses-session",
      reason: "swarm_await_completed",
      notification: "not ours",
    });

    expect(await wakeTasks(harness)).toHaveLength(0);
  });

  it("drops a wake when the session has no conversation to anchor to", async () => {
    // No context passed at startSession — nothing to attribute the wake to.
    const { harness } = await startSession();

    state.clients[0]?.emitNamed("wake_requested", {
      ev: "wake_requested",
      session_id: state.clients[0].sessionId,
      reason: "swarm_await_completed",
      notification: "anchorless",
    });

    expect(await wakeTasks(harness)).toHaveLength(0);
  });

  it("drops background_task_completed — the registry mirror is that wake's single producer", async () => {
    const { harness } = await startSession({
      context: { conversationId: "cv-lead" },
    });

    state.clients[0]?.emitNamed("wake_requested", {
      ev: "wake_requested",
      session_id: state.clients[0].sessionId,
      reason: "background_task_completed",
      notification: "task done",
    });

    expect(await wakeTasks(harness)).toHaveLength(0);
  });
});
