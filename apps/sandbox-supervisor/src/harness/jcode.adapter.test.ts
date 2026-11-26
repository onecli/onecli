import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent, SteerInput } from "@onecli/agent-protocol";

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
 * - The steer plumbing: turn-start interrupt cancel, the one
 *   `soft_interrupt` request (tagged when the daemon echoes ids, its images
 *   riding with it), refusal between turns, and the terminal reconcile.
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
  /** The runtime died under this connection (stream ends, `close`). */
  die(): void;
}

const state: {
  calls: FakeCall[];
  launches: { options: Record<string, unknown> }[];
  clients: PushableClient[];
  connects: { options: Record<string, unknown> }[];
  /** The runtime keep-alive connections, one per launch, kept apart from
   * `clients` / `connects` (the conversations') so a test reads a
   * conversation's connection by its index alone. */
  keepAlives: (PushableClient & { closed: boolean })[];
  sessionCounter: number;
  /** Frames a successfully-accepted send delivers (the turn's script). */
  events: { ev: string; [key: string]: unknown }[];
  /** How many sends the "daemon" refuses busy before accepting. */
  busyRefusals: number;
  history: { role: string; content: string }[];
  historyError: Error | null;
  /** Rejections dealt to getHistory calls one at a time (baseline retries). */
  historyErrorQueue: Error[];
  /** When set, getHistory records the call, then holds until this resolves —
   * the deterministic way to keep the reconcile-baseline read pending. */
  historyGate: Promise<void> | null;
  /** When > 0, a send's `message_accepted` (and everything after it) is
   * held back this long — the fence stays up, as under a foreign run. */
  acceptDelayMs: number;
  /** When set, a send delivers nothing: the test pushes `message_accepted`
   * itself, in stream order, instead of betting on timer ordering. */
  manualAccept: boolean;
  softInterruptError: Error | null;
  setModelError: Error | null;
  /** Refuse `setModel` this many times before accepting it: the model list
   * race, where a fresh home refuses a valid model until its list loads. */
  setModelRefusals: number;
  /** What `listModels` answers: jcode's model list, which carries the model
   * once the account's list loads. A function, so a test can make the list
   * land later in the wait, or fail the read. */
  listModels: () => Promise<{ models: string[] }>;
  setEffortError: Error | null;
  /** How the "daemon" answers `set_session_env`: a refusal, or fine. */
  setSessionEnvError: Error | null;
  /** How the "daemon" answers `set_context_cap`: the effective budget, a
   * refusal, or never (a busy agent lock). */
  contextCap:
    | { kind: "ok" }
    | { kind: "error"; error: Error }
    | { kind: "hang" };
  /** The handshake capabilities the "daemon" advertises. Default: the
   * live pickup signal is there (jcode ≥ v0.94.0); a test drops it to
   * exercise the history reconcile an older daemon still needs. */
  capabilities: string[];
  /** What the daemon answers `background_tool` with (SEND NOW). */
  backgroundToolResult: {
    moved: boolean;
    toolCallId?: string;
    toolName?: string;
  };
  /** When set, the next `attachSession` rejects with it (once): the
   * daemon refusing a ref it has no record of. */
  attachError: Error | null;
  /** Every launched bridge process (a real emitter + stderr stream). */
  bridges: (EventEmitter & { stderr: PassThrough })[];
  /** How the "daemon" answers `fork_session`: a refusal, or a copy. */
  forkError: Error | null;
  /** When set, the next `launchInstance` rejects with it (once). */
  launchError: Error | null;
} = {
  calls: [],
  launches: [],
  clients: [],
  connects: [],
  keepAlives: [],
  sessionCounter: 0,
  events: [{ ev: "turn_done" }],
  busyRefusals: 0,
  history: [],
  historyError: null,
  historyErrorQueue: [],
  historyGate: null,
  acceptDelayMs: 0,
  manualAccept: false,
  softInterruptError: null,
  setModelError: null,
  setModelRefusals: 0,
  listModels: () => Promise.resolve({ models: [] }),
  setEffortError: null,
  setSessionEnvError: null,
  contextCap: { kind: "ok" },
  capabilities: [SOFT_INTERRUPT_IDS_CAPABILITY],
  backgroundToolResult: { moved: false },
  bridges: [],
  forkError: null,
  launchError: null,
  attachError: null,
};

vi.mock("@1jehuang/jcode-sdk", () => {
  const record = (method: string, ...args: unknown[]) => {
    state.calls.push({ method, args });
  };
  class MockClient {
    readonly sessionId: string;
    /** Set by `close()`, ours or the "daemon's" (`die`). */
    closed = false;
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
    /** The runtime died under this connection: its stream ends, and the
     * SDK raises `close` with no error (the live shape, measured). */
    die() {
      this.closed = true;
      this.end();
      this.emitNamed("close", undefined);
    }
    static connect(options: Record<string, unknown>) {
      if (String(options.clientName).endsWith("/keep-alive")) {
        const keepAlive = new MockClient("keep-alive");
        state.keepAlives.push(keepAlive);
        return Promise.resolve(keepAlive);
      }
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
      this.closed = true;
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
      const attachError = state.attachError;
      if (attachError) {
        state.attachError = null;
        return Promise.reject(attachError);
      }
      return Promise.resolve({ session_id: id });
    }
    forkSession(id: string) {
      record("forkSession", id);
      if (state.forkError) return Promise.reject(state.forkError);
      state.sessionCounter += 1;
      return Promise.resolve({ session_id: `fork-of-${id}` });
    }
    detachSession(id: string) {
      record("detachSession", id);
      return Promise.resolve();
    }
    setModel(sessionId: string, model: string) {
      record("setModel", sessionId, model);
      if (state.setModelRefusals > 0) {
        state.setModelRefusals -= 1;
        return Promise.reject(
          Object.assign(
            new Error(
              `invalid_request: Model ${model} not supported by Anthropic provider`,
            ),
            { code: "invalid_request" },
          ),
        );
      }
      return state.setModelError
        ? Promise.reject(state.setModelError)
        : Promise.resolve();
    }
    listModels(sessionId: string) {
      record("listModels", sessionId);
      return state.listModels();
    }
    setReasoningEffort(sessionId: string, effort: string) {
      record("setReasoningEffort", sessionId, effort);
      return state.setEffortError
        ? Promise.reject(state.setEffortError)
        : Promise.resolve();
    }
    setContextCap(sessionId: string, tokens: number | null) {
      record("setContextCap", sessionId, tokens);
      const cap = state.contextCap;
      if (cap.kind === "error") return Promise.reject(cap.error);
      if (cap.kind === "hang") return new Promise<number>(() => {});
      return Promise.resolve(tokens ?? 200_000);
    }
    setSessionEnv(sessionId: string, env: Record<string, string>) {
      record("setSessionEnv", sessionId, env);
      return state.setSessionEnvError
        ? Promise.reject(state.setSessionEnvError)
        : Promise.resolve();
    }
    sendMessage(sessionId: string, content: string) {
      record("sendMessage", sessionId, content);
      if (state.manualAccept) return Promise.resolve();
      // Delivery rides a macrotask, matching the wire: the real daemon
      // never streams a turn's frames inside the send call itself. FIFO
      // within the one timeout. The daemon ACKS the `message` request on
      // its request loop before dispatching it (the bridge mints
      // `message_accepted` from that ack), so an accepted send's frames
      // are always preceded by the ack — that ack IS the adapter's frame
      // fence. `acceptDelayMs` holds the ack back (our send queued behind
      // a foreign run holding the request loop); frames a test pushes by
      // hand in that window model the foreign run. A busy refusal is an
      // `error` for the same request id, following the ack like any other
      // outcome of dispatch.
      setTimeout(() => {
        const deliver = () => {
          this.push({ ev: "message_accepted", session_id: sessionId });
          if (state.busyRefusals > 0) {
            state.busyRefusals -= 1;
            // The daemon's refusal: a broadcast error frame, never a
            // rejection (the SDK's send is fire-and-forget) — the live shape.
            this.push({
              ev: "error",
              message: "Already processing a message",
            });
          } else {
            for (const frame of state.events) this.push(frame);
          }
        };
        if (state.acceptDelayMs > 0) setTimeout(deliver, state.acceptDelayMs);
        else deliver();
      }, 0);
      return Promise.resolve();
    }
    softInterruptWithId(
      sessionId: string,
      content: string,
      options?: { clientId?: string; images?: [string, string][] },
    ) {
      record("softInterruptWithId", sessionId, content, options);
      return state.softInterruptError
        ? Promise.reject(state.softInterruptError)
        : Promise.resolve();
    }
    supports(capability: string) {
      return state.capabilities.includes(capability);
    }
    backgroundToolResult(sessionId: string) {
      record("backgroundToolResult", sessionId);
      return Promise.resolve(state.backgroundToolResult);
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
      // not how the real stream behaves. Each call is a fresh subscription
      // (the SDK's is): one turn's closed stream never ends the next one's.
      // A dead connection (`die`) stays ended.
      if (!this.closed) this.streamDone = false;
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
      const launchError = state.launchError;
      if (launchError) {
        state.launchError = null;
        return Promise.reject(launchError);
      }
      // A real emitter with a stderr stream: the adapter subscribes to the
      // bridge's `exit` (a death signal) and forwards its stderr. `kill` is
      // how teardown stops it (bridge first, see stopInstance).
      const bridge = Object.assign(new EventEmitter(), {
        stderr: new PassThrough(),
        kill(signal: string) {
          record("bridge.kill", signal);
          return true;
        },
      });
      state.bridges.push(bridge);
      return Promise.resolve({
        socketPath: "/tmp/fake-jcode-api.sock",
        jcodeHome: String(options.jcodeHome ?? ""),
        process: bridge,
        shutdown: () => {
          record("shutdown");
          return Promise.resolve();
        },
      });
    },
    // Something that exists on disk — resolveJcodeBinary demands a real path.
    bundledJcodeBinary: () => process.execPath,
  };
});

import {
  ABORT_TERMINAL_GRACE_MS,
  BACKGROUND_TOOL_RESULT_CAPABILITY,
  BUSY_DETECT_WINDOW_MS,
  BUSY_RESEND_DELAYS_MS,
  CONTEXT_CAP_WAIT_MS,
  MODEL_LIST_POLL_MS,
  MODEL_LIST_WAIT_MS,
  ORPHAN_DRAIN_MIN_MS,
  POST_ACCEPT_IDLE_MS,
  RELAUNCH_WINDOW_MS,
  SOFT_INTERRUPT_IDS_CAPABILITY,
  TOOL_INPUT_MAX_CHARS,
  createJcodeHarness,
} from "./jcode";

const ORIGINAL_DELAYS = [...BUSY_RESEND_DELAYS_MS];
const ORIGINAL_MODEL_LIST_WAIT_MS = MODEL_LIST_WAIT_MS.value;
const ORIGINAL_MODEL_LIST_POLL_MS = MODEL_LIST_POLL_MS.value;
const ORIGINAL_POST_ACCEPT_IDLE_MS = POST_ACCEPT_IDLE_MS.value;
const ORIGINAL_ABORT_GRACE_MS = ABORT_TERMINAL_GRACE_MS.value;
const ORIGINAL_BUSY_DETECT_WINDOW_MS = BUSY_DETECT_WINDOW_MS.value;
const ORIGINAL_ORPHAN_DRAIN_MIN_MS = ORPHAN_DRAIN_MIN_MS.value;

const collect = async (
  iterable: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> => {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
};

const startSession = async (options?: {
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  resumeSessionRef?: string;
  harness?: ReturnType<typeof createJcodeHarness>;
  context?: { conversationId: string };
  env?: Record<string, string>;
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
    ...(options?.env && { env: options.env }),
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
  state.keepAlives = [];
  state.sessionCounter = 0;
  state.events = [{ ev: "turn_done" }];
  state.busyRefusals = 0;
  state.history = [];
  state.historyError = null;
  state.historyErrorQueue = [];
  state.historyGate = null;
  state.acceptDelayMs = 0;
  state.manualAccept = false;
  state.softInterruptError = null;
  state.setModelError = null;
  state.setModelRefusals = 0;
  state.listModels = () => Promise.resolve({ models: [] });
  state.setEffortError = null;
  state.setSessionEnvError = null;
  state.contextCap = { kind: "ok" };
  CONTEXT_CAP_WAIT_MS.value = 3_000;
  state.capabilities = [SOFT_INTERRUPT_IDS_CAPABILITY];
  state.backgroundToolResult = { moved: false };
  state.bridges = [];
  state.forkError = null;
  state.launchError = null;
  state.attachError = null;
  // A fast model-list wait; afterEach restores the real bounds.
  MODEL_LIST_WAIT_MS.value = 100;
  MODEL_LIST_POLL_MS.value = 5;
  BUSY_DETECT_WINDOW_MS.value = 100;
  ORPHAN_DRAIN_MIN_MS.value = 20;
  delete process.env.ONECLI_JCODE_BINARY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CODEX_HOME;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  // Some suites shorten the heal backoff to keep tests fast; the exported
  // array is shared module state, so restore it. Same for the live loop's
  // two deadlines.
  BUSY_RESEND_DELAYS_MS.splice(
    0,
    BUSY_RESEND_DELAYS_MS.length,
    ...ORIGINAL_DELAYS,
  );
  MODEL_LIST_WAIT_MS.value = ORIGINAL_MODEL_LIST_WAIT_MS;
  MODEL_LIST_POLL_MS.value = ORIGINAL_MODEL_LIST_POLL_MS;
  POST_ACCEPT_IDLE_MS.value = ORIGINAL_POST_ACCEPT_IDLE_MS;
  ABORT_TERMINAL_GRACE_MS.value = ORIGINAL_ABORT_GRACE_MS;
  BUSY_DETECT_WINDOW_MS.value = ORIGINAL_BUSY_DETECT_WINDOW_MS;
  ORPHAN_DRAIN_MIN_MS.value = ORIGINAL_ORPHAN_DRAIN_MIN_MS;
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

  it("prewarm launches the ONE instance ahead of any session, holds ONE keep-alive from launch, and the first session reuses both", async () => {
    const harness = createJcodeHarness();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    harness.prewarm?.(homeDir);
    harness.prewarm?.(homeDir);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(1));
    expect(state.launches).toHaveLength(1);
    // The launch's managed files are already on the home.
    expect(existsSync(join(homeDir, ".jcode", "system-prompt.md"))).toBe(true);
    // THE IDLE-EXIT FIX: the daemon has a client from launch, so its
    // 300 s no-client exit never arms. No conversation connection yet, and
    // the keep-alive never opens a session or sends anything.
    expect(state.connects).toHaveLength(0);
    expect(state.calls).toEqual([]);

    const session = await harness.startSession({ homeDir });
    expect(session.sessionRef).toBe("s-1");
    expect(state.launches).toHaveLength(1);
    expect(state.connects).toHaveLength(1);
    expect(state.keepAlives).toHaveLength(1);
    expect(state.keepAlives[0]?.closed).toBe(false);
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

  describe("the Anthropic credential route", () => {
    /**
     * Launch once with the given grant env against a home whose durable
     * `auth.json` still holds an OAuth stub from an EARLIER grant (the shape
     * a grant change leaves behind, since the respawned container keeps its
     * volume). Returns the env the adapter handed `launchInstance` and the
     * stub's path.
     */
    const launchWithStaleStub = async (grant: Record<string, string>) => {
      Object.assign(process.env, grant);
      const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
      const jcodeHome = join(homeDir, ".jcode-home");
      mkdirSync(jcodeHome, { recursive: true });
      const authFile = join(jcodeHome, "auth.json");
      writeFileSync(authFile, '{"anthropic_accounts":[{"label":"stale"}]}');
      await createJcodeHarness().startSession({ homeDir });
      const options = state.launches[0]?.options as {
        env?: Record<string, string>;
      };
      return { env: options.env ?? {}, authFile };
    };

    it("an API-key grant pins the key route and drops the stale OAuth stub", async () => {
      const { env, authFile } = await launchWithStaleStub({
        ANTHROPIC_API_KEY: "placeholder",
      });
      expect(env.JCODE_RUNTIME_PROVIDER).toBe("claude-api");
      expect(env.JCODE_PROVIDER).toBeUndefined();
      // Left in place, jcode's automatic mode would prefer this account
      // over the key and send `Authorization: Bearer` until some resumed
      // session happened to flip it.
      expect(existsSync(authFile)).toBe(false);
    });

    it("an OAuth grant pins the subscription route and rewrites the stub", async () => {
      const { env, authFile } = await launchWithStaleStub({
        CLAUDE_CODE_OAUTH_TOKEN: "placeholder",
      });
      expect(env.JCODE_RUNTIME_PROVIDER).toBe("claude");
      expect(env.JCODE_PROVIDER).toBe("claude");
      expect(readFileSync(authFile, "utf8")).toContain(
        '"access":"placeholder"',
      );
    });

    it("no Anthropic grant pins nothing and leaves no stub", async () => {
      const { env, authFile } = await launchWithStaleStub({});
      expect(env).not.toHaveProperty("JCODE_RUNTIME_PROVIDER");
      expect(env).not.toHaveProperty("JCODE_PROVIDER");
      expect(existsSync(authFile)).toBe(false);
    });

    // The home is agent-writable, so the stub path may hold anything the
    // agent planted there. The purge must remove the planted thing itself,
    // never what a link points at, and must never fail the launch.
    it("unlinks a planted symlink at the stub path, never its target", async () => {
      process.env.ANTHROPIC_API_KEY = "placeholder";
      const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
      const jcodeHome = join(homeDir, ".jcode-home");
      mkdirSync(jcodeHome, { recursive: true });
      const outside = join(mkdtempSync(join(tmpdir(), "jcode-out-")), "keep");
      writeFileSync(outside, "precious");
      symlinkSync(outside, join(jcodeHome, "auth.json"));

      await createJcodeHarness().startSession({ homeDir });

      expect(existsSync(join(jcodeHome, "auth.json"))).toBe(false);
      expect(readFileSync(outside, "utf8")).toBe("precious");
    });

    it("heals a directory planted at the stub path instead of failing the launch", async () => {
      process.env.ANTHROPIC_API_KEY = "placeholder";
      const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
      const planted = join(homeDir, ".jcode-home", "auth.json");
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, "x"), "y");

      await createJcodeHarness().startSession({ homeDir });

      expect(state.launches).toHaveLength(1);
      expect(existsSync(planted)).toBe(false);
    });
  });

  describe("the OpenAI ChatGPT (Codex) login", () => {
    /**
     * Launch once with the given grant env against a home whose durable
     * `openai-auth.json` still holds an account from an EARLIER grant.
     * Returns the env the adapter handed `launchInstance` and the store path.
     */
    const launchWithStaleStore = async (grant: Record<string, string>) => {
      Object.assign(process.env, grant);
      const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
      const jcodeHome = join(homeDir, ".jcode-home");
      mkdirSync(jcodeHome, { recursive: true });
      const store = join(jcodeHome, "openai-auth.json");
      writeFileSync(store, '{"openai_accounts":[{"label":"stale"}]}');
      await createJcodeHarness().startSession({ homeDir });
      const options = state.launches[0]?.options as {
        env?: Record<string, string>;
      };
      return { env: options.env ?? {}, store };
    };

    it("seeds jcode's own store with the placeholder, 0600, and pins OpenAI", async () => {
      const { env, store } = await launchWithStaleStore({
        CODEX_HOME: "/home/node/.codex",
      });
      // Without it the runtime reads no OpenAI login at all.
      expect(env.JCODE_PROVIDER).toBe("openai");
      expect(env).not.toHaveProperty("JCODE_RUNTIME_PROVIDER");
      expect(lstatSync(store).mode & 0o777).toBe(0o600);
      const file = JSON.parse(readFileSync(store, "utf8"));
      expect(file.active_openai_account).toBe("onecli");
      expect(file.openai_accounts[0].refresh_token).toBe("onecli-managed");
    });

    it("an API-key grant drops a store an earlier login left", async () => {
      const { env, store } = await launchWithStaleStore({
        OPENAI_API_KEY: "placeholder",
        CODEX_HOME: "/home/node/.codex",
      });
      // Left in place, the runtime would prefer the login over the key.
      expect(existsSync(store)).toBe(false);
      expect(env).not.toHaveProperty("JCODE_PROVIDER");
    });

    it("an Anthropic grant keeps its own pin, beside a ChatGPT login", async () => {
      // Both keys granted: Anthropic wins the session, the login is still
      // available for an OpenAI model the user picks.
      const { env, store } = await launchWithStaleStore({
        ANTHROPIC_API_KEY: "placeholder",
        CODEX_HOME: "/home/node/.codex",
      });
      expect(env.JCODE_RUNTIME_PROVIDER).toBe("claude-api");
      expect(env).not.toHaveProperty("JCODE_PROVIDER");
      expect(existsSync(store)).toBe(true);
    });

    it("unlinks a planted symlink at the store path, never its target", async () => {
      process.env.CODEX_HOME = "/home/node/.codex";
      const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
      const jcodeHome = join(homeDir, ".jcode-home");
      mkdirSync(jcodeHome, { recursive: true });
      const outside = join(mkdtempSync(join(tmpdir(), "jcode-out-")), "keep");
      writeFileSync(outside, "precious");
      symlinkSync(outside, join(jcodeHome, "openai-auth.json"));

      await createJcodeHarness().startSession({ homeDir });

      expect(lstatSync(join(jcodeHome, "openai-auth.json")).isFile()).toBe(
        true,
      );
      expect(readFileSync(outside, "utf8")).toBe("precious");
    });
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

  it("a fork ref opens the session as a COPY of the parent: attach parent, fork, detach, attach the child", async () => {
    // A DM thread's first session inherits the DM's transcript. jcode's
    // fork acts on the attached session and leaves the connection on the
    // parent, so the adapter walks it over to the child itself.
    const harness = createJcodeHarness();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));

    const forked = await harness.startSession({
      homeDir,
      forkSessionRef: "s-parent",
    });

    expect(
      state.calls
        .filter((c) =>
          [
            "attachSession",
            "forkSession",
            "detachSession",
            "createSession",
          ].includes(c.method),
        )
        .map((c) => [c.method, ...c.args]),
    ).toEqual([
      ["attachSession", "s-parent"],
      ["forkSession", "s-parent"],
      ["detachSession", "s-parent"],
      ["attachSession", "fork-of-s-parent"],
    ]);
    expect(forked.sessionRef).toBe("fork-of-s-parent");
    // The child is a session of its own: a turn runs on it like any other.
    const events = await collect(forked.runTurn({ message: "in the thread" }));
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("a fork that the daemon refuses degrades to a FRESH session: the context is lost, never the turn", async () => {
    state.forkError = new Error("Failed to save split session: not found");
    const harness = createJcodeHarness();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));

    const session = await harness.startSession({
      homeDir,
      forkSessionRef: "s-gone",
    });

    expect(callsOf("forkSession")).toEqual([
      { method: "forkSession", args: ["s-gone"] },
    ]);
    // Let go of the parent before minting, so the fresh session is the one
    // this connection serves.
    expect(callsOf("detachSession")).toEqual([
      { method: "detachSession", args: ["s-gone"] },
    ]);
    expect(callsOf("createSession")).toHaveLength(1);
    expect(session.sessionRef).toBe("s-1");
  });

  it("a resume ref wins over a fork ref: a session that exists is resumed, never re-forked", async () => {
    const harness = createJcodeHarness();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));

    const resumed = await harness.startSession({
      homeDir,
      resumeSessionRef: "s-child",
      forkSessionRef: "s-parent",
    });

    expect(callsOf("forkSession")).toHaveLength(0);
    expect(callsOf("attachSession")).toEqual([
      { method: "attachSession", args: ["s-child"] },
    ]);
    expect(resumed.sessionRef).toBe("s-child");
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
    await new Promise((resolve) =>
      setTimeout(resolve, BUSY_DETECT_WINDOW_MS.value + 200),
    );
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

/**
 * The runtime's life: the keep-alive that stops jcode's idle exit, and the
 * in-place relaunch when the daemon dies between turns anyway. The fatal
 * path (`onFailure`, the sandbox recycled) stays for what a relaunch cannot
 * honestly recover: a death under a turn or a session setup, a launch that
 * fails, a second death inside RELAUNCH_WINDOW_MS.
 */
describe("the runtime lifecycle (keep-alive + in-place relaunch)", () => {
  const ORIGINAL_RELAUNCH_WINDOW_MS = RELAUNCH_WINDOW_MS.value;
  afterEach(() => {
    RELAUNCH_WINDOW_MS.value = ORIGINAL_RELAUNCH_WINDOW_MS;
  });

  const watched = () => {
    const failures: string[] = [];
    const harness = createJcodeHarness();
    harness.onFailure((reason) => failures.push(reason));
    return { harness, failures };
  };

  /** The daemon dies: every connection it served closes, then the bridge
   * exits (both signals, the order measured live). */
  const killRuntime = (launch: number) => {
    state.keepAlives[launch]?.die();
    for (const client of state.clients) client.die();
    state.bridges[launch]?.emit("exit", null, "SIGKILL");
  };

  it("a startSession launch opens exactly one keep-alive beside its conversation connection", async () => {
    await startSession();
    expect(state.launches).toHaveLength(1);
    expect(state.keepAlives).toHaveLength(1);
    expect(state.connects).toHaveLength(1);
  });

  it("a death between turns relaunches in place, and the held session reattaches on its OWN ref with its preferences replayed", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({
      homeDir,
      model: "claude-opus-4-1",
      effort: "high",
      env: { DISPLAY: ":1" },
      context: { conversationId: "conv-a" },
    });
    await collect(session.runTurn({ message: "first", contextTokens: 9_000 }));
    const ref = session.sessionRef;

    killRuntime(0);
    // Torn down bridge first (the zombie-free order), then relaunched.
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    expect(failures).toEqual([]);
    expect(state.launches).toHaveLength(2);
    expect(callsOf("bridge.kill")).toEqual([
      { method: "bridge.kill", args: ["SIGTERM"] },
    ]);
    expect(callsOf("shutdown")).toHaveLength(1);

    state.calls = [];
    const events = await collect(
      session.runTurn({ message: "second", contextTokens: 9_000 }),
    );
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(failures).toEqual([]);
    // Reattached on a fresh connection to the SAME transcript...
    expect(state.connects).toHaveLength(2);
    expect(session.sessionRef).toBe(ref);
    expect(callsOf("attachSession")).toEqual([
      { method: "attachSession", args: [ref] },
    ]);
    // ...with everything the dead daemon held set again, BEFORE the send.
    const order = state.calls.map((call) => call.method);
    for (const method of [
      "setModel",
      "setReasoningEffort",
      "setSessionEnv",
      "setContextCap",
    ]) {
      expect(order.indexOf(method)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(method)).toBeLessThan(order.indexOf("sendMessage"));
    }
    expect(callsOf("setSessionEnv")[0]?.args).toEqual([ref, { DISPLAY: ":1" }]);
  });

  it("a wake request on the reattached session still finds its conversation", async () => {
    const { harness } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({
      homeDir,
      context: { conversationId: "conv-a" },
    });
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    await collect(session.runTurn({ message: "again" }));

    const reattached = state.clients[1];
    reattached?.emitNamed("wake_requested", {
      ev: "wake_requested",
      session_id: session.sessionRef,
      reason: "swarm_await_completed",
      notification: "members done",
    });
    const tasks = (await harness.backgroundTasks?.poll()) ?? [];
    expect(tasks.filter((task) => task.ref.startsWith("wake:"))).toContainEqual(
      expect.objectContaining({ context: { conversationId: "conv-a" } }),
    );
  });

  it("setEnv between turns is what a reattach replays, not the env the session opened with", async () => {
    const { harness } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({ homeDir });
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    // The desktop came up after the death: nothing to send it to yet.
    state.calls = [];
    await session.setEnv?.({ DISPLAY: ":7" });
    expect(callsOf("setSessionEnv")).toEqual([]);
    await collect(session.runTurn({ message: "after" }));
    expect(callsOf("setSessionEnv")[0]?.args).toEqual([
      session.sessionRef,
      { DISPLAY: ":7" },
    ]);
  });

  it("a session the dead daemon never persisted starts fresh on reattach, its new ref reported", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({ homeDir });
    const firstRef = session.sessionRef;
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));

    // Measured live: a session opened but never sent a message is not on
    // disk, and the relaunched daemon answers `unknown_session`.
    state.attachError = Object.assign(
      new Error(`unknown_session: Unknown session '${firstRef}'`),
      { code: "unknown_session" },
    );
    const events = await collect(session.runTurn({ message: "hello" }));

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(failures).toEqual([]);
    expect(session.sessionRef).toBe("s-2");
    expect(session.sessionRef).not.toBe(firstRef);
    expect(callsOf("createSession")).toHaveLength(2);
  });

  it("a stop that lands while the turn reattaches ends it before anything is sent", async () => {
    // The reattach is the turn's longest pre-send window (a relaunched
    // daemon answering attach + preferences). A stop in it must not be
    // erased by the turn's own setup and then run the message anyway.
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({ homeDir, model: "m" });
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));

    // Park the reattach in the model-list wait, then stop the turn there.
    let listed!: () => void;
    state.listModels = () =>
      new Promise((resolve) => {
        listed = () => resolve({ models: ["m"] });
      });
    state.setModelRefusals = 1;
    MODEL_LIST_WAIT_MS.value = 10_000;
    state.calls = [];
    const turn = collect(session.runTurn({ message: "never send me" }));
    await vi.waitFor(() => expect(callsOf("listModels")).toHaveLength(1));
    await session.abort();
    listed();
    const events = await turn;

    expect(events).toEqual([{ type: "turn.done" }]);
    expect(callsOf("sendMessage")).toEqual([]);
    // The dead connection had nothing to cancel; the live one ran nothing.
    expect(callsOf("cancel")).toEqual([]);
    expect(failures).toEqual([]);

    // The stop belonged to that turn only: the next one runs.
    const next = await collect(session.runTurn({ message: "now" }));
    expect(next.at(-1)).toEqual({ type: "turn.done" });
    expect(callsOf("sendMessage")).toHaveLength(1);
  });

  it("a forked thread the dead daemon never persisted forks its parent again on reattach", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({
      homeDir,
      forkSessionRef: "s-parent",
    });
    const forkedRef = session.sessionRef;
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));

    state.calls = [];
    state.attachError = Object.assign(
      new Error(`unknown_session: Unknown session '${forkedRef}'`),
      { code: "unknown_session" },
    );
    const events = await collect(session.runTurn({ message: "in the thread" }));

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(callsOf("forkSession")).toEqual([
      { method: "forkSession", args: ["s-parent"] },
    ]);
    expect(callsOf("createSession")).toHaveLength(0);
    expect(failures).toEqual([]);
  });

  it("a reattach that fails for another reason fails THAT turn only, and the next turn retries it", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({ homeDir, model: "m" });
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));

    state.setModelError = new Error("socket ripped");
    await expect(collect(session.runTurn({ message: "one" }))).rejects.toThrow(
      "socket ripped",
    );
    expect(failures).toEqual([]);

    state.setModelError = null;
    const events = await collect(session.runTurn({ message: "two" }));
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(failures).toEqual([]);
  });

  it("a NEW conversation after a relaunch opens on the new runtime", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    await harness.startSession({ homeDir });
    killRuntime(0);
    const fresh = await harness.startSession({ homeDir });
    const events = await collect(fresh.runTurn({ message: "hi" }));
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(failures).toEqual([]);
    expect(state.launches).toHaveLength(2);
  });

  it("two held sessions reattach CONCURRENTLY onto the one relaunched runtime, each on its own ref", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const a = await harness.startSession({ homeDir });
    const b = await harness.startSession({ homeDir });
    const [refA, refB] = [a.sessionRef, b.sessionRef];
    killRuntime(0);
    state.calls = [];
    const [ea, eb] = await Promise.all([
      collect(a.runTurn({ message: "a" })),
      collect(b.runTurn({ message: "b" })),
    ]);
    expect(ea.at(-1)?.type).toBe("turn.done");
    expect(eb.at(-1)?.type).toBe("turn.done");
    // One relaunch, never a second launch onto the same home.
    expect(state.launches).toHaveLength(2);
    expect(
      callsOf("attachSession")
        .map((call) => call.args[0])
        .sort(),
    ).toEqual([refA, refB].sort());
    expect([a.sessionRef, b.sessionRef]).toEqual([refA, refB]);
    expect(failures).toEqual([]);
  });

  it("a death while a relaunch is still coming up is not a second relaunch: the in-flight one stands", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({ homeDir });
    killRuntime(0);
    // The dead runtime's later signals (its other connections closing,
    // the bridge exit) land on a retired record.
    state.bridges[0]?.emit("exit", 1, null);
    state.keepAlives[0]?.die();
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    const events = await collect(session.runTurn({ message: "ok" }));
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(state.launches).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it("a release between the death and the next turn closes cleanly and opens nothing", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({ homeDir });
    const ref = session.sessionRef;
    if (!ref) throw new Error("expected a session ref");
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    await session.release?.();
    // The ref is free again: a resume attaches it, never mints fresh.
    state.calls = [];
    const resumed = await harness.startSession({
      homeDir,
      resumeSessionRef: ref,
    });
    expect(resumed.sessionRef).toBe(ref);
    expect(callsOf("attachSession")).toEqual([
      { method: "attachSession", args: [ref] },
    ]);
    expect(failures).toEqual([]);
  });

  it("an idle keep-alive close alone (no conversation yet) is a death too: relaunched", async () => {
    const { harness, failures } = watched();
    harness.prewarm?.(mkdtempSync(join(tmpdir(), "jcode-adapter-")));
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(1));
    state.keepAlives[0]?.die();
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    expect(failures).toEqual([]);
    // The bridge's own exit, landing after: the dead runtime's teardown.
    state.bridges[0]?.emit("exit", null, "SIGTERM");
    expect(state.launches).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it("a death under a turn fails the sandbox and is never relaunched under it", async () => {
    const { harness, failures } = watched();
    const { session } = await startSession({ harness });
    state.manualAccept = true;
    const turn = collect(session.runTurn({ message: "long" }));
    await vi.waitFor(() => expect(callsOf("sendMessage")).toHaveLength(1));

    killRuntime(0);
    expect(failures).toEqual(["jcode runtime closed its keep-alive"]);
    const events = await turn;
    expect(events.at(-1)?.type).toBe("error");
    expect(state.launches).toHaveLength(1);
  });

  it("a death under a session setup fails the sandbox", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    // The setup parks in the model-list wait (the launch-window race):
    // the runtime dies while this session is still being opened.
    let listed!: () => void;
    state.listModels = () =>
      new Promise((resolve) => {
        listed = () => resolve({ models: ["m"] });
      });
    state.setModelRefusals = 1;
    MODEL_LIST_WAIT_MS.value = 10_000;
    const opening = harness.startSession({ homeDir, model: "m" });
    await vi.waitFor(() => expect(callsOf("listModels")).toHaveLength(1));

    killRuntime(0);
    expect(failures).toEqual(["jcode runtime closed its keep-alive"]);
    listed();
    await opening;
    expect(state.launches).toHaveLength(1);
  });

  it("a second death inside RELAUNCH_WINDOW_MS fails the sandbox: a crash loop is not relaunched", async () => {
    const { harness, failures } = watched();
    await startSession({ harness });
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    expect(failures).toEqual([]);

    killRuntime(1);
    expect(failures).toEqual([
      "jcode runtime closed its keep-alive (again, within 60000 ms)",
    ]);
    expect(state.launches).toHaveLength(2);
  });

  it("a death AFTER the window is relaunched again", async () => {
    RELAUNCH_WINDOW_MS.value = 0;
    const { harness, failures } = watched();
    await startSession({ harness });
    killRuntime(0);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(2));
    killRuntime(1);
    await vi.waitFor(() => expect(state.keepAlives).toHaveLength(3));
    expect(failures).toEqual([]);
    expect(state.launches).toHaveLength(3);
  });

  it("a relaunch that cannot launch fails the sandbox, and stays failed", async () => {
    const { harness, failures } = watched();
    const homeDir = mkdtempSync(join(tmpdir(), "jcode-adapter-"));
    const session = await harness.startSession({ homeDir });
    state.launchError = new Error("spawn ENOENT");
    killRuntime(0);
    await vi.waitFor(() =>
      expect(failures).toEqual([
        "harness relaunch failed: Error: spawn ENOENT",
      ]),
    );
    // The rejected memo is kept: no retry of the destructive launch.
    await expect(collect(session.runTurn({ message: "x" }))).rejects.toThrow(
      "spawn ENOENT",
    );
    expect(state.launches).toHaveLength(2);
    expect(failures).toHaveLength(1);
  });

  it("a first launch that fails reports the launch, once", async () => {
    const { harness, failures } = watched();
    state.launchError = new Error("spawn ENOENT");
    await expect(
      harness.startSession({
        homeDir: mkdtempSync(join(tmpdir(), "jcode-adapter-")),
      }),
    ).rejects.toThrow("spawn ENOENT");
    expect(failures).toEqual(["harness launch failed: Error: spawn ENOENT"]);
  });

  it("releasing a session closes only its connection: the keep-alive stays, nothing is relaunched", async () => {
    const { harness, failures } = watched();
    const { session } = await startSession({ harness });
    await session.release?.();
    expect(state.keepAlives[0]?.closed).toBe(false);
    expect(state.launches).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it("dispose closes the keep-alive and stops the runtime bridge first, with no failure and no relaunch", async () => {
    const { harness, failures } = watched();
    await startSession({ harness });
    await harness.dispose();
    // The teardown's own signals, as the real SDK raises them.
    state.keepAlives[0]?.die();
    state.bridges[0]?.emit("exit", null, "SIGTERM");

    expect(state.keepAlives[0]?.closed).toBe(true);
    expect(callsOf("bridge.kill")).toEqual([
      { method: "bridge.kill", args: ["SIGTERM"] },
    ]);
    expect(callsOf("shutdown")).toHaveLength(1);
    expect(state.launches).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it("dispose during a relaunch waits for it and takes down what it launched", async () => {
    const { harness, failures } = watched();
    await startSession({ harness });
    killRuntime(0);
    await harness.dispose();
    expect(state.launches).toHaveLength(2);
    expect(state.keepAlives.every((keepAlive) => keepAlive.closed)).toBe(true);
    expect(callsOf("shutdown")).toHaveLength(2);
    expect(failures).toEqual([]);
  });
});

describe("the daemon's own diagnostics (jcode-log.ts wiring)", () => {
  let stderr: string[] = [];
  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.mocked(process.stderr.write).mockRestore();
  });
  const lines = () =>
    stderr.map(
      (line) =>
        JSON.parse(line) as {
          level: string;
          message: string;
          [k: string]: unknown;
        },
    );

  it("a bridge exit under a turn fails the harness with the exit code AND signal in the reason", async () => {
    let failure: string | undefined;
    const harness = createJcodeHarness();
    harness.onFailure((reason) => {
      failure = reason;
    });
    const { session } = await startSession({ harness });
    state.manualAccept = true;
    const turn = collect(session.runTurn({ message: "hi" }));
    await vi.waitFor(() => expect(callsOf("sendMessage")).toHaveLength(1));
    state.bridges[0]?.emit("exit", null, "SIGKILL");
    expect(failure).toBe("jcode instance exited (code null, signal SIGKILL)");
    state.clients[0]?.end();
    await turn;
  });

  it("forwards the bridge's stderr as jcode-stderr warnings, redacted", async () => {
    await startSession();
    state.bridges[0]?.stderr.write(
      `thread 'main' panicked: proxy aoc_${"ef".repeat(32)} refused\n`,
    );
    expect(lines()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        source: "jcode-stderr",
        message: "thread 'main' panicked: proxy aoc_[REDACTED] refused",
      }),
    );
  });

  it("follows <jcodeHome>/logs from launch and stops on dispose", async () => {
    const { harness, homeDir } = await startSession();
    const logsDir = join(homeDir, ".jcode-home", "logs");
    mkdirSync(logsDir, { recursive: true });
    const file = join(logsDir, "jcode-2026-10-01.log");
    writeFileSync(
      file,
      "[2026-10-01 13:54:16.105] [ERROR] Anthropic stream error: overloaded\n",
    );
    // Dispose drains one final poll: the daemon's last words are kept.
    await harness.dispose();
    expect(lines()).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "jcode",
        message: "Anthropic stream error: overloaded",
      }),
    );
    // And after dispose the follower is gone: nothing more is read.
    appendFileSync(file, "[2026-10-01 13:54:17.000] [ERROR] after dispose\n");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(lines().some((line) => line.message === "after dispose")).toBe(
      false,
    );
  });
});

describe("applyPreferences honesty", () => {
  const noticesOf = async (session: {
    runTurn: (input: { message: string }) => AsyncIterable<HarnessEvent>;
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
    // It waited out the window for the model list, which never carried
    // the model, then asked once more: jcode's last answer decides.
    expect(callsOf("setModel")).toHaveLength(2);
    expect(callsOf("listModels").length).toBeGreaterThan(1);
  });

  it("the model list race: a refusal that clears once the list loads earns NO notice", async () => {
    // A fresh home refuses a valid model the platform offers until jcode's
    // model list loads, which can take longer than a short backoff. The
    // model is asked again only once the list carries it.
    state.setModelRefusals = 1;
    let reads = 0;
    state.listModels = () => {
      reads += 1;
      return Promise.resolve({
        models: reads < 3 ? ["claude-opus-5-5"] : ["claude-sonnet-5-5"],
      });
    };
    const { session } = await startSession({ model: "claude-sonnet-5-5" });
    expect(await noticesOf(session)).toHaveLength(0);
    expect(callsOf("listModels")).toHaveLength(3);
    const tries = callsOf("setModel");
    expect(tries).toHaveLength(2);
    expect(tries.at(-1)?.args[1]).toBe("claude-sonnet-5-5");
  });

  it("a model accepted at once never reads the model list", async () => {
    const { session } = await startSession({ model: "claude-sonnet-5" });
    expect(await noticesOf(session)).toHaveLength(0);
    expect(callsOf("setModel")).toHaveLength(1);
    expect(callsOf("listModels")).toHaveLength(0);
  });

  it("after the launch window, a refusal is final at once", async () => {
    // The window is anchored to jcode's launch: a later session's list has
    // long loaded, so a model it lacks earns the notice without a wait.
    const harness = createJcodeHarness();
    await startSession({ harness });
    await new Promise((resolve) =>
      setTimeout(resolve, MODEL_LIST_WAIT_MS.value + 20),
    );
    state.setModelError = Object.assign(new Error("invalid_request"), {
      code: "invalid_request",
    });
    const { session } = await startSession({ harness, model: "nope-model" });
    expect(await noticesOf(session)).toHaveLength(1);
    expect(callsOf("setModel")).toHaveLength(1);
    expect(callsOf("listModels")).toHaveLength(0);
  });

  it("a failed model-list read ends the wait: the last ask decides", async () => {
    state.setModelRefusals = 1;
    state.listModels = () =>
      Promise.reject(
        Object.assign(new Error("no reply to list_models"), {
          code: "timeout",
        }),
      );
    const { session } = await startSession({ model: "claude-sonnet-5-5" });
    expect(await noticesOf(session)).toHaveLength(0);
    expect(callsOf("listModels")).toHaveLength(1);
    expect(callsOf("setModel")).toHaveLength(2);
  });

  it("the effort is set once, after the retried model lands", async () => {
    state.setModelRefusals = 1;
    state.listModels = () => Promise.resolve({ models: ["claude-sonnet-5-5"] });
    const { session } = await startSession({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
    expect(await noticesOf(session)).toHaveLength(0);
    const preferenceCalls = state.calls
      .filter(
        (c) => c.method === "setModel" || c.method === "setReasoningEffort",
      )
      .map((c) => c.method);
    expect(preferenceCalls).toEqual([
      "setModel",
      "setModel",
      "setReasoningEffort",
    ]);
  });

  it("a timeout after a refusal stops retrying without a notice", async () => {
    state.setModelRefusals = 1;
    state.listModels = () => Promise.resolve({ models: ["real-model"] });
    state.setModelError = Object.assign(new Error("no reply"), {
      code: "timeout",
    });
    const { session } = await startSession({ model: "real-model" });
    expect(await noticesOf(session)).toHaveLength(0);
    expect(state.calls.filter((c) => c.method === "setModel")).toHaveLength(2);
  });

  it("a daemon code other than invalid_request is never retried", async () => {
    // Only a refused switch can clear while the model list loads. An unknown
    // request or an internal fault is final: it earns its notice at once.
    state.setModelError = Object.assign(new Error("internal"), {
      code: "internal",
    });
    const { session } = await startSession({ model: "real-model" });
    expect(await noticesOf(session)).toHaveLength(1);
    expect(state.calls.filter((c) => c.method === "setModel")).toHaveLength(1);
    expect(callsOf("listModels")).toHaveLength(0);
  });

  it("an effort refusal earns its notice on the first attempt", async () => {
    // The effort is never retried: a refused level never becomes an
    // accepted one, so a retry would only delay the same notice.
    state.setEffortError = Object.assign(new Error("unsupported effort"), {
      code: "invalid_request",
    });
    const { session } = await startSession({ effort: "low" });
    const notices = await noticesOf(session);
    expect(notices).toHaveLength(1);
    expect(
      state.calls.filter((c) => c.method === "setReasoningEffort"),
    ).toHaveLength(1);
  });

  it("a dead channel during the retry still throws (never a quiet default)", async () => {
    state.setModelRefusals = 1;
    state.listModels = () => Promise.resolve({ models: ["m"] });
    state.setModelError = new Error("socket ripped");
    await expect(startSession({ model: "m" })).rejects.toThrow("socket ripped");
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
    expect(state.calls.filter((c) => c.method === "setModel")).toHaveLength(1);
    expect(
      state.calls.filter((c) => c.method === "setReasoningEffort"),
    ).toHaveLength(1);
  });
});

describe("the session environment (the desktop that comes up after the harness)", () => {
  it("a session started with `env` hands it to the daemon per session, after the preferences", async () => {
    const { session } = await startSession({
      model: "m",
      env: { DISPLAY: ":1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
    });
    expect(callsOf("setSessionEnv")).toEqual([
      {
        method: "setSessionEnv",
        args: [
          session.sessionRef,
          { DISPLAY: ":1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
        ],
      },
    ]);
    const order = state.calls.map((c) => c.method);
    expect(order.indexOf("setModel")).toBeLessThan(
      order.indexOf("setSessionEnv"),
    );
  });

  it("no `env` (or an empty one) sends nothing: the daemon's launch env is the whole story", async () => {
    await startSession();
    await startSession({ env: {} });
    expect(callsOf("setSessionEnv")).toEqual([]);
  });

  it("`setEnv` on a live session replaces the overlay for THAT session only", async () => {
    const harness = createJcodeHarness();
    const a = await startSession({ harness });
    const b = await startSession({ harness });
    await a.session.setEnv?.({ DISPLAY: ":1" });
    expect(callsOf("setSessionEnv")).toEqual([
      {
        method: "setSessionEnv",
        args: [a.session.sessionRef, { DISPLAY: ":1" }],
      },
    ]);
    expect(a.session.sessionRef).not.toBe(b.session.sessionRef);
  });

  it("a daemon refusal is a warning, never a failed session or turn", async () => {
    state.setSessionEnvError = Object.assign(new Error("invalid_request"), {
      code: "invalid_request",
    });
    const { session } = await startSession({ env: { DISPLAY: ":1" } });
    await expect(session.setEnv?.({ DISPLAY: ":2" })).resolves.toBeUndefined();
    const events = await collect(session.runTurn({ message: "hello" }));
    expect(events.filter((e) => e.type === "notice")).toEqual([]);
    expect(events.at(-1)?.type).toBe("turn.done");
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

    const events: HarnessEvent[] = [];
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

    const events: HarnessEvent[] = [];
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

  describe("without `soft_interrupt_ids` (an older daemon): the history reconcile", () => {
    beforeEach(() => {
      state.capabilities = [];
    });

    it("steer maps to an UNTAGGED soft interrupt while the turn runs (the reconcile matches it by text)", async () => {
      state.events = [
        { ev: "text_delta", text: "working" },
        { ev: "turn_done" },
      ];
      const { session } = await startSession();
      const iterator = session
        .runTurn({ message: "task" })
        [Symbol.asyncIterator]();
      await iterator.next(); // turn.started — the gate is open

      await session.steer?.({ id: "f1", message: "fold this in" });

      expect(callsOf("softInterruptWithId")).toEqual([
        { method: "softInterruptWithId", args: ["s-1", "fold this in", {}] },
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
      expect(callsOf("softInterruptWithId")).toHaveLength(0);
    });

    it("propagates a coded harness refusal from the soft interrupt", async () => {
      state.events = [
        { ev: "text_delta", text: "working" },
        { ev: "turn_done" },
      ];
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

      const events: HarnessEvent[] = [];
      let next = await iterator.next();
      while (!next.done) {
        events.push(next.value);
        next = await iterator.next();
      }
      // Never tracked as delivered → never confirmed joined.
      expect(events.some((e) => e.type === "message.joined")).toBe(false);
    });

    it("reconciles at the terminal: cancel → history → message.joined BEFORE turn.done", async () => {
      state.events = [
        { ev: "text_delta", text: "working" },
        { ev: "turn_done" },
      ];
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

      const events: HarnessEvent[] = [];
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
      // Nothing on this path knows where the injection landed while the
      // run streams, so no delta is ever tagged as a reply: the reply
      // reaches the transcript only as the handover's `text`.
      expect(
        events.every((e) => e.type !== "text.delta" || e.replyTo === undefined),
      ).toBe(true);
    });

    it("a steer whose text EQUALS the prompt still reconciles joined — the index anchor", async () => {
      // The content-anchor trap: matching the prompt from the END would find
      // the INJECTED copy and read everything out of the window. The baseline
      // index makes the duplicate a normal candidate.
      state.events = [
        { ev: "text_delta", text: "working" },
        { ev: "turn_done" },
      ];
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

      const events: HarnessEvent[] = [];
      let next = await iterator.next();
      while (!next.done) {
        events.push(next.value);
        next = await iterator.next();
      }

      expect(
        events.some(
          (e) => e.type === "message.joined" && e.followUpId === "f1",
        ),
      ).toBe(true);
    });

    it("a steer matching only the turn's OWN prompt reads as missed — never joined", async () => {
      // The false-positive the exact-window rule kills: "ok" appears inside
      // the prompt (memory context + message travel there verbatim), and a
      // matcher over the whole history would mark it joined — the message
      // silently swallowed.
      state.events = [
        { ev: "text_delta", text: "working" },
        { ev: "turn_done" },
      ];
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

      const events: HarnessEvent[] = [];
      let next = await iterator.next();
      while (!next.done) {
        events.push(next.value);
        next = await iterator.next();
      }

      expect(events.some((e) => e.type === "message.joined")).toBe(false);
    });

    it("a history failure degrades every pending steer to missed", async () => {
      state.events = [
        { ev: "text_delta", text: "working" },
        { ev: "turn_done" },
      ];
      state.historyError = new Error("bridge went away");
      const { session } = await startSession();
      const iterator = session
        .runTurn({ message: "task" })
        [Symbol.asyncIterator]();
      await iterator.next();
      await session.steer?.({ id: "f1", message: "fold this in" });

      const events: HarnessEvent[] = [];
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
  });

  describe("with `soft_interrupt_ids` (jcode ≥ v0.94.0): the live pickup signal", () => {
    /** Open a turn, steer once the gate is open, with `frames` as the run's
     * own stream (delivered behind the daemon's ack, like the real wire), and
     * return every event after the steer. The steer is an RPC the daemon
     * answers on its request loop, so it precedes the run's frames. */
    const steerThen = async (
      frames: { ev: string; [key: string]: unknown }[],
      steers: SteerInput[] = [{ id: "f1", message: "fold this in" }],
    ) => {
      state.events = frames;
      const { session } = await startSession();
      const iterator = session
        .runTurn({ message: "task" })
        [Symbol.asyncIterator]();
      await iterator.next(); // turn.started: the gate is open
      for (const steer of steers) await session.steer?.(steer);
      const events: HarnessEvent[] = [];
      let next = await iterator.next();
      while (!next.done) {
        events.push(next.value);
        next = await iterator.next();
      }
      return events;
    };
    /** The steer outcome the stream reported, per follow-up in join order:
     * the join, with the reply `message.replied` later attached to it. */
    const joins = (events: HarnessEvent[]) => {
      const out: { followUpId: string; reply?: string }[] = [];
      for (const e of events) {
        if (e.type === "message.joined") out.push({ followUpId: e.followUpId });
        if (e.type === "message.replied") {
          const entry = out.find((j) => j.followUpId === e.followUpId);
          if (entry) entry.reply = e.reply;
          else out.push({ followUpId: `UNJOINED:${e.followUpId}` });
        }
      }
      return out;
    };

    it("steer rides softInterruptWithId, tagged with the follow-up's own id", async () => {
      await steerThen([{ ev: "turn_done" }]);
      expect(callsOf("softInterruptWithId")).toEqual([
        {
          method: "softInterruptWithId",
          args: ["s-1", "fold this in", { clientId: "f1" }],
        },
      ]);
    });

    it("a steer's images ride the SAME request, in jcode's own [mediaType, base64] shape", async () => {
      // MUTATION-TESTED: drop the images from the request and the words
      // join while the picture is silently lost (the original jcode#623 bug,
      // reintroduced on our side of the wire).
      await steerThen(
        [{ ev: "turn_done" }],
        [
          {
            id: "f1",
            message: "what is this?",
            images: [{ mediaType: "image/png", dataBase64: "iVBORw0K" }],
          },
        ],
      );
      expect(callsOf("softInterruptWithId")).toEqual([
        {
          method: "softInterruptWithId",
          args: [
            "s-1",
            "what is this?",
            { clientId: "f1", images: [["image/png", "iVBORw0K"]] },
          ],
        },
      ]);
    });

    it("the injection confirms the join LIVE, then the next framed message is the reply, before the work goes on", async () => {
      // The point-D shape as the daemon streams it: the injection
      // lands behind a tool, the agent answers in its next message, then
      // calls the next tool. The join is yielded AT the injection, before
      // the reply's first delta; the reply is yielded the moment that
      // message closes, not at the terminal.
      const events = await steerThen([
        { ev: "text_delta", text: "Running the build.", message_id: "m1" },
        { ev: "text_done", message_id: "m1" },
        { ev: "tool_start", call_id: "c1", name: "bash" },
        { ev: "tool_done", call_id: "c1", name: "bash", output: "built" },
        { ev: "soft_interrupt_injected", client_ids: ["f1"], point: "D" },
        { ev: "text_delta", text: "Sure, I'll ", message_id: "m2" },
        { ev: "text_delta", text: "check the linter too.", message_id: "m2" },
        { ev: "text_done", message_id: "m2" },
        { ev: "tool_start", call_id: "c2", name: "bash" },
        { ev: "tool_done", call_id: "c2", name: "bash", output: "linted" },
        { ev: "text_delta", text: "Both passed.", message_id: "m3" },
        { ev: "turn_done" },
      ]);

      expect(joins(events)).toEqual([
        { followUpId: "f1", reply: "Sure, I'll check the linter too." },
      ]);
      const kinds = events.map((e) => e.type);
      const joinedAt = kinds.indexOf("message.joined");
      const repliedAt = kinds.indexOf("message.replied");
      const firstReplyDelta = events.findIndex(
        (e) => e.type === "text.delta" && e.text === "Sure, I'll ",
      );
      const lastReplyDelta = events.findIndex(
        (e) => e.type === "text.delta" && e.text === "check the linter too.",
      );
      // The join BEFORE the reply's first word (a reader sees the pickup,
      // then the reply grow); the reply after its last word, before the
      // second tool and long before the terminal.
      expect(joinedAt).toBeGreaterThan(kinds.indexOf("tool.finished"));
      expect(joinedAt).toBeLessThan(firstReplyDelta);
      expect(repliedAt).toBeGreaterThan(lastReplyDelta);
      expect(repliedAt).toBeLessThan(kinds.lastIndexOf("tool.started"));
      expect(repliedAt).toBeLessThan(kinds.indexOf("turn.done"));
      // No history read anywhere: the signal replaced it.
      expect(callsOf("getHistory")).toHaveLength(0);
      // THE REPLY STREAMS: every delta of the reply's message is
      // tagged with the follow-up it answers, and nothing else is (the
      // narration before the injection, the words after the second tool).
      const deltas = events.flatMap((e) =>
        e.type === "text.delta" ? [[e.text, e.replyTo] as const] : [],
      );
      expect(deltas).toEqual([
        ["Running the build.", undefined],
        ["Sure, I'll ", "f1"],
        ["check the linter too.", "f1"],
        ["Both passed.", undefined],
      ]);
    });

    it("a tool call right after the injection means no separate reply", async () => {
      const events = await steerThen([
        { ev: "soft_interrupt_injected", client_ids: ["f1"], point: "D" },
        { ev: "tool_start", call_id: "c1", name: "bash" },
        { ev: "tool_done", call_id: "c1", name: "bash", output: "ok" },
        { ev: "text_delta", text: "All done.", message_id: "m1" },
        { ev: "turn_done" },
      ]);
      expect(joins(events)).toEqual([{ followUpId: "f1" }]);
      expect(events.map((e) => e.type).indexOf("message.joined")).toBeLessThan(
        events.map((e) => e.type).indexOf("tool.started"),
      );
    });

    it("at point B the reply is the extension message and the terminal closes it", async () => {
      const events = await steerThen([
        {
          ev: "text_delta",
          text: "Done: the report is in report.md.",
          message_id: "m1",
        },
        { ev: "text_done", message_id: "m1" },
        { ev: "soft_interrupt_injected", client_ids: ["f1"], point: "B" },
        {
          ev: "text_delta",
          text: "Yes, I can also email it.",
          message_id: "m2",
        },
        { ev: "turn_done" },
      ]);
      expect(joins(events)).toEqual([
        { followUpId: "f1", reply: "Yes, I can also email it." },
      ]);
      expect(events.at(-1)?.type).toBe("turn.done");
    });

    it("steers injected together share one reply, on the LAST sent", async () => {
      const events = await steerThen(
        [
          {
            ev: "soft_interrupt_injected",
            client_ids: ["f1", "f2"],
            point: "D",
          },
          { ev: "text_delta", text: "Four and six.", message_id: "m1" },
          { ev: "text_done", message_id: "m1" },
          { ev: "turn_done" },
        ],
        [
          { id: "f1", message: "what is 2 plus 2?" },
          { id: "f2", message: "what is 3 plus 3?" },
        ],
      );
      expect(joins(events)).toEqual([
        { followUpId: "f1" },
        { followUpId: "f2", reply: "Four and six." },
      ]);
    });

    it("a steer the daemon never confirmed is missed: no join, no history read", async () => {
      const events = await steerThen([
        { ev: "text_delta", text: "working", message_id: "m1" },
        { ev: "turn_done", pending_soft_interrupts: 1 },
      ]);
      expect(joins(events)).toEqual([]);
      expect(events.at(-1)?.type).toBe("turn.done");
      expect(callsOf("getHistory")).toHaveLength(0);
    });

    it("an injection naming an id this turn never sent is ignored", async () => {
      const events = await steerThen([
        { ev: "soft_interrupt_injected", client_ids: ["stale-id"], point: "D" },
        { ev: "text_delta", text: "hm", message_id: "m1" },
        { ev: "turn_done" },
      ]);
      expect(joins(events)).toEqual([]);
    });

    it("a correction of the reply's own message replaces the reply", async () => {
      const events = await steerThen([
        { ev: "soft_interrupt_injected", client_ids: ["f1"], point: "D" },
        { ev: "text_delta", text: "Yes, I can also em", message_id: "m2" },
        {
          ev: "text_replace",
          text: "Yes, I can also email it.",
          message_id: "m2",
        },
        { ev: "text_done", message_id: "m2" },
        { ev: "turn_done" },
      ]);
      expect(joins(events)).toEqual([
        { followUpId: "f1", reply: "Yes, I can also email it." },
      ]);
    });

    it("the reasoning before the reply is not the reply", async () => {
      const events = await steerThen([
        { ev: "soft_interrupt_injected", client_ids: ["f1"], point: "D" },
        { ev: "reasoning_delta", text: "they want the linter too" },
        { ev: "text_delta", text: "On it.", message_id: "m2" },
        { ev: "text_done", message_id: "m2" },
        { ev: "turn_done" },
      ]);
      expect(joins(events)).toEqual([{ followUpId: "f1", reply: "On it." }]);
    });
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

describe("SEND NOW: moving the running tool to the background", () => {
  /** Open a turn and hold it mid-run (the gate open), ask to move. */
  const moveMidRun = async () => {
    state.events = [];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started: the gate is open
    const result = await session.backgroundRunningTool?.();
    return { session, result };
  };

  it("asks a daemon that reports the move, scoped to this session, and says what moved", async () => {
    state.capabilities = [
      SOFT_INTERRUPT_IDS_CAPABILITY,
      BACKGROUND_TOOL_RESULT_CAPABILITY,
    ];
    state.backgroundToolResult = {
      moved: true,
      toolCallId: "call-1",
      toolName: "bash",
    };
    const { result } = await moveMidRun();
    expect(callsOf("backgroundToolResult")).toEqual([
      { method: "backgroundToolResult", args: ["s-1"] },
    ]);
    // The daemon's call id stays inside the adapter.
    expect(result).toEqual({ moved: true, toolName: "bash" });
  });

  it("nothing running: moved false, never a name", async () => {
    state.capabilities = [BACKGROUND_TOOL_RESULT_CAPABILITY];
    state.backgroundToolResult = { moved: false, toolName: "stale" };
    const { result } = await moveMidRun();
    expect(result).toEqual({ moved: false });
  });

  it("an OLDER daemon (no background_tool_result) is never asked: it could move a tool and only say ok", async () => {
    // MUTATION-PROOF for the gate: asking anyway would cut the person's
    // tool short while reporting `moved: false`.
    state.capabilities = [SOFT_INTERRUPT_IDS_CAPABILITY];
    state.backgroundToolResult = { moved: true, toolName: "bash" };
    const { result } = await moveMidRun();
    expect(callsOf("backgroundToolResult")).toHaveLength(0);
    expect(result).toEqual({ moved: false });
  });

  it("between turns there is nothing to move, and the daemon is not asked", async () => {
    state.capabilities = [BACKGROUND_TOOL_RESULT_CAPABILITY];
    state.backgroundToolResult = { moved: true, toolName: "bash" };
    const { session } = await startSession();
    expect(await session.backgroundRunningTool?.()).toEqual({ moved: false });
    expect(callsOf("backgroundToolResult")).toHaveLength(0);
  });

  it("is declared, so the supervisor offers it", () => {
    expect(createJcodeHarness().capabilities.backgroundTool).toBe(true);
  });
});

describe("the frame fence", () => {
  beforeEach(() => {
    // Keep the heal cycle fast; afterEach restores the real backoff.
    BUSY_RESEND_DELAYS_MS.splice(0, BUSY_RESEND_DELAYS_MS.length, 10, 10, 10);
  });

  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  const drain = async (
    iterator: AsyncIterator<HarnessEvent>,
  ): Promise<HarnessEvent[]> => {
    const events: HarnessEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }
    return events;
  };

  it("a self-wake run's frames are quarantined — never yielded, never our terminal", async () => {
    // The wire truth: our send is queued behind a foreign run that holds
    // the daemon's request loop, so our ACK (the fence) arrives only when
    // the foreign run ends — and our own frames can only follow it. The
    // mock delays the ack; the foreign frames are pushed by hand under it.
    state.events = [];
    state.manualAccept = true;
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started

    // The wake run streams while the fence stands: text, a tool, usage,
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

    // Our turn spawns: the ack lands, then our frames (stream order).
    client?.push({ ev: "message_accepted", session_id: client.sessionId });
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
    // The daemon acks our send and then refuses it; the ack and the
    // refusal ride different daemon-side paths to one socket writer, so
    // the refusal can land BEFORE the ack and be stamped foreign.
    // Quarantining it would kill the self-heal; this is the pin that it
    // never happens. Modelled by pushing the refusal by hand under a held
    // ack; the resend then streams normally.
    state.acceptDelayMs = 30;
    state.events = [
      { ev: "text_delta", text: "the real answer" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    // Orphan residue precedes the refusal — its discard is the heal's,
    // silent, and must never mint the exclusion notice.
    state.clients[0]?.push({ ev: "text_delta", text: "ORPHAN-RESIDUE" });
    state.clients[0]?.push({
      ev: "error",
      message: "Already processing a message",
    });
    // The first send's (late) ack must not be mistaken for the resend's
    // fence, so drop the delay before the heal resends.
    await tick(5);
    state.acceptDelayMs = 0;

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
    // pre-fence frame, and the accepted send streams normally after it.
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

  it("the baseline read retries through SDK timeouts and the turn completes", async () => {
    // The baseline is the HISTORY reconcile's floor: only a daemon without
    // the live pickup signal needs it (the live path never reads history).
    state.capabilities = [];
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
    // reconcile never reads history — the count is the baseline read's alone.
    expect(callsOf("getHistory")).toHaveLength(3);
  }, 15_000);

  it("a non-timeout baseline failure stops after ONE attempt — the turn is unaffected", async () => {
    // `disconnected`, an unknown session, a closing channel — retrying
    // cannot help; the floor stays null and reconcile takes the content
    // anchor. The fence is untouched: it never depended on this read.
    state.capabilities = [];
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
    // A timed-out baseline attempt's late reply re-enters the stream as an
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

  it("an abort under a standing fence ends the turn within the tick", async () => {
    // The fence never drops (our send is queued behind a foreign run that
    // holds the daemon's request loop, so no ack and no cancel confirmation
    // can arrive) — the live loop's tick honors the abort directly instead
    // of hanging for the foreign run's life.
    state.events = [];
    state.acceptDelayMs = 60_000; // the ack never lands inside the test
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

  it("stream death under a standing fence fails visibly and still reports the drop", async () => {
    state.events = [];
    state.acceptDelayMs = 60_000; // the ack never lands inside the test
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

describe("issue #1124 — the fence outlives a slow get_history", () => {
  // The baseline get_history is the HISTORY reconcile's; the live pickup
  // path never issues it. These pin the fence against a daemon without the
  // live signal, where the read still happens.
  beforeEach(() => {
    state.capabilities = [];
  });
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const drain = async (
    iterator: AsyncIterator<HarnessEvent>,
  ): Promise<HarnessEvent[]> => {
    const events: HarnessEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }
    return events;
  };

  it("the prod race: the whole turn streams before get_history answers — nothing is lost", async () => {
    // The exact shape from the three live occurrences (jcode#1284): the
    // daemon acks our message, runs the turn to completion, and only THEN
    // answers the get_history we issued right after the send. Pre-fix the
    // reply was the fence, every frame of our own turn was quarantined,
    // the terminal included, and the loop waited out the 6 h ceiling.
    state.events = [
      { ev: "text_delta", text: "the whole answer" },
      { ev: "token_usage", input: 405, output: 557 },
      { ev: "turn_done" },
    ];
    let answerHistory = () => {};
    state.historyGate = new Promise<void>((resolve) => {
      answerHistory = resolve;
    });
    const { session } = await startSession();

    const started = Date.now();
    const events = await collect(session.runTurn({ message: "task" }));

    // Completed WITHOUT the history reply ever arriving.
    expect(events.at(-1)).toMatchObject({
      type: "turn.done",
      usage: expect.objectContaining({ outputTokens: 557 }),
    });
    expect(
      events.some(
        (e) => e.type === "text.delta" && e.text === "the whole answer",
      ),
    ).toBe(true);
    // Our own output was never mistaken for a background run's.
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The late reply is harmless: it lands after the turn, into nothing.
    answerHistory();
    await tick(5);
  }, 15_000);

  it("Stop on a turn whose terminal was lost ends within the abort grace", async () => {
    // The daemon's turn is over and its terminal never reached us (or was
    // consumed by something else); the daemon has nothing to cancel, so
    // `cancel()` answers with no terminal at all. Pre-fix: Stop was a
    // visible no-op, three times over. Now the grace ends the turn.
    ABORT_TERMINAL_GRACE_MS.value = 200;
    state.events = [{ ev: "text_delta", text: "partial" }]; // no terminal
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    const drained = drain(iterator);
    await tick(20); // the ack and the delta have landed; the fence is down

    const abortedAt = Date.now();
    await session.abort();
    const events = await drained;

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(callsOf("cancel")).toHaveLength(1);
    const elapsed = Date.now() - abortedAt;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
  }, 15_000);

  it("Stop on a healthy turn still ends on the daemon's terminal, not the grace", async () => {
    ABORT_TERMINAL_GRACE_MS.value = 5_000;
    state.events = [{ ev: "text_delta", text: "working" }]; // terminal by hand
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    const drained = drain(iterator);
    await tick(20);

    const abortedAt = Date.now();
    await session.abort();
    // The daemon honours the cancel and closes the turn.
    state.clients[0]?.push({ ev: "turn_done" });
    const events = await drained;

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
  }, 15_000);

  it("silence past the post-accept deadline fails coded harness_no_terminal", async () => {
    POST_ACCEPT_IDLE_MS.value = 200;
    state.events = [{ ev: "text_delta", text: "and then nothing" }];
    const { session } = await startSession();

    const started = Date.now();
    const events = await collect(session.runTurn({ message: "task" }));

    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: "error",
      code: "harness_no_terminal",
    });
    expect((terminal as { message: string }).message).toContain("no frame");
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 15_000);

  it("an open tool call suspends the post-accept deadline — a long wait is not a stall", async () => {
    POST_ACCEPT_IDLE_MS.value = 100;
    state.events = [
      { ev: "tool_start", call_id: "c1", name: "bash" }, // a `bg wait`
    ];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    const drained = drain(iterator);

    // Four deadlines' worth of silence with the tool open: still alive.
    await tick(400);
    state.clients[0]?.push({
      ev: "tool_done",
      call_id: "c1",
      name: "bash",
      output: "ok",
    });
    state.clients[0]?.push({ ev: "turn_done" });
    const events = await drained;

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(events.some((e) => e.type === "error")).toBe(false);
  }, 15_000);

  it("a foreign frame resets the deadline — an alive stream is never a stall", async () => {
    POST_ACCEPT_IDLE_MS.value = 150;
    state.events = [{ ev: "text_delta", text: "ours" }];
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    const drained = drain(iterator);
    await tick(20);

    // Keepalive-shaped frames the adapter ignores by content but which
    // prove the stream is alive (the daemon's 30 s Pong, a phase change).
    for (let i = 0; i < 4; i += 1) {
      await tick(100);
      state.clients[0]?.push({ ev: "connection_phase", phase: "streaming" });
    }
    state.clients[0]?.push({ ev: "turn_done" });
    const events = await drained;

    expect(events.at(-1)?.type).toBe("turn.done");
    expect(events.some((e) => e.type === "error")).toBe(false);
  }, 15_000);

  it("the fence is re-armed for a self-heal resend — the orphan's tail stays out", async () => {
    // After a busy refusal the resend gets its own ack; frames between the
    // refusal and that ack are the dying orphan's.
    BUSY_RESEND_DELAYS_MS.splice(0, BUSY_RESEND_DELAYS_MS.length, 10);
    state.busyRefusals = 1;
    state.events = [{ ev: "text_delta", text: "ours" }, { ev: "turn_done" }];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "task" }));

    expect(callsOf("sendMessage")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "ours"),
    ).toBe(true);
    expect(events.some((e) => e.type === "notice")).toBe(false);
  }, 15_000);
});

describe("the external wake listener", () => {
  // The bash source reads `$TMPDIR/jcode-bg-tasks`; point it at an empty dir
  // so a host running jcode cannot leak its own tasks into these tests.
  beforeEach(() => {
    vi.stubEnv("TMPDIR", mkdtempSync(join(tmpdir(), "wake-listener-")));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

describe("tool-call input capture", () => {
  const finishedOf = (events: HarnessEvent[]) =>
    events.filter(
      (e): e is Extract<HarnessEvent, { type: "tool.finished" }> =>
        e.type === "tool.finished",
    );

  it("assembles tool_input_delta chunks onto the call's tool.finished", async () => {
    state.events = [
      { ev: "tool_start", call_id: "c1", name: "warehouse_query" },
      { ev: "tool_input_delta", call_id: "c1", delta: '{"sql":"select ' },
      {
        ev: "tool_input_delta",
        call_id: "c1",
        delta: 'sum(amount) from revenue"}',
      },
      { ev: "tool_exec", call_id: "c1", name: "warehouse_query" },
      {
        ev: "tool_done",
        call_id: "c1",
        name: "warehouse_query",
        output: "[[3200000]]",
      },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const [finished] = finishedOf(
      await collect(session.runTurn({ message: "q1 revenue?" })),
    );

    expect(finished).toEqual({
      type: "tool.finished",
      callId: "c1",
      name: "warehouse_query",
      input: '{"sql":"select sum(amount) from revenue"}',
      output: "[[3200000]]",
    });
  });

  it("keeps concurrent calls' inputs apart by call id", async () => {
    state.events = [
      { ev: "tool_start", call_id: "a", name: "docs_search" },
      { ev: "tool_start", call_id: "b", name: "warehouse_query" },
      { ev: "tool_input_delta", call_id: "a", delta: '{"q":"Acme' },
      { ev: "tool_input_delta", call_id: "b", delta: '{"sql":"select 1"}' },
      { ev: "tool_input_delta", call_id: "a", delta: ' status"}' },
      { ev: "tool_done", call_id: "b", name: "warehouse_query", output: "1" },
      { ev: "tool_done", call_id: "a", name: "docs_search", output: "3 docs" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const finished = finishedOf(
      await collect(session.runTurn({ message: "acme" })),
    );

    expect(finished.map((e) => [e.callId, e.input])).toEqual([
      ["b", '{"sql":"select 1"}'],
      ["a", '{"q":"Acme status"}'],
    ]);
  });

  it("credits an UNKEYED delta (jcode < 0.88) to the call being streamed", async () => {
    // Observed live on jcode v0.81.1: `tool_input` carries no id, and the
    // bridge forwards it as call_id "". Without this, input never landed.
    state.events = [
      { ev: "tool_start", call_id: "c1", name: "bash" },
      { ev: "tool_input_delta", call_id: "", delta: '{"command":"echo ' },
      { ev: "tool_input_delta", call_id: "", delta: 'hello && ls /"}' },
      { ev: "tool_exec", call_id: "c1", name: "bash" },
      { ev: "tool_done", call_id: "c1", name: "bash", output: "hello" },
      { ev: "tool_start", call_id: "c2", name: "read" },
      {
        ev: "tool_input_delta",
        call_id: "",
        delta: '{"file_path":"/etc/hostname"}',
      },
      { ev: "tool_done", call_id: "c2", name: "read", output: "0a2d" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const finished = finishedOf(
      await collect(session.runTurn({ message: "x" })),
    );

    expect(finished.map((e) => [e.callId, e.input])).toEqual([
      ["c1", '{"command":"echo hello && ls /"}'],
      ["c2", '{"file_path":"/etc/hostname"}'],
    ]);
  });

  it("omits input when the harness streamed none — the pre-existing shape", async () => {
    state.events = [
      { ev: "tool_start", call_id: "c1", name: "bash" },
      {
        ev: "tool_done",
        call_id: "c1",
        name: "bash",
        output: "ok",
        error: "boom",
      },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const [finished] = finishedOf(
      await collect(session.runTurn({ message: "x" })),
    );

    expect(finished).toEqual({
      type: "tool.finished",
      callId: "c1",
      name: "bash",
      output: "ok",
      isError: true,
    });
    expect(finished && "input" in finished).toBe(false);
  });

  it("bounds a huge input and marks the cut visibly", async () => {
    const chunk = "x".repeat(10_000);
    state.events = [
      { ev: "tool_start", call_id: "c1", name: "write_file" },
      { ev: "tool_input_delta", call_id: "c1", delta: chunk },
      { ev: "tool_input_delta", call_id: "c1", delta: chunk },
      { ev: "tool_input_delta", call_id: "c1", delta: chunk },
      { ev: "tool_done", call_id: "c1", name: "write_file", output: "ok" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const [finished] = finishedOf(
      await collect(session.runTurn({ message: "x" })),
    );
    const input = finished?.input ?? "";

    expect(input.startsWith("x".repeat(TOOL_INPUT_MAX_CHARS))).toBe(true);
    expect(input).toContain(
      `[truncated ${30_000 - TOOL_INPUT_MAX_CHARS} characters]`,
    );
    // Stays under the runner's per-string bound, so it is never cut twice.
    expect(input.length).toBeLessThanOrEqual(16_000);
  });

  it("does not carry one call's input onto a later call that reuses nothing", async () => {
    state.events = [
      { ev: "tool_start", call_id: "c1", name: "bash" },
      { ev: "tool_input_delta", call_id: "c1", delta: '{"cmd":"ls"}' },
      { ev: "tool_done", call_id: "c1", name: "bash", output: "a" },
      { ev: "tool_start", call_id: "c2", name: "bash" },
      { ev: "tool_done", call_id: "c2", name: "bash", output: "b" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const finished = finishedOf(
      await collect(session.runTurn({ message: "x" })),
    );

    expect(finished.map((e) => e.input)).toEqual(['{"cmd":"ls"}', undefined]);
  });

  it("carries a command's exit status as exitCode, with the vendor trailer stripped", async () => {
    state.events = [
      { ev: "tool_start", call_id: "c1", name: "bash" },
      {
        ev: "tool_done",
        call_id: "c1",
        name: "bash",
        output: "grep: no match\n\nExit code: 1",
      },
      { ev: "tool_start", call_id: "c2", name: "bash" },
      { ev: "tool_done", call_id: "c2", name: "bash", output: "found it" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const finished = finishedOf(
      await collect(session.runTurn({ message: "x" })),
    );

    expect(finished).toEqual([
      {
        type: "tool.finished",
        callId: "c1",
        name: "bash",
        output: "grep: no match",
        exitCode: 1,
      },
      { type: "tool.finished", callId: "c2", name: "bash", output: "found it" },
    ]);
  });
});

/**
 * The bridge's MESSAGE FRAMING (the frame shapes verified live on the pinned
 * runtime: an id on every text delta, `text_replace` retracting a rolled-back
 * attempt). The adapter carries both into the harness vocabulary; what the
 * answer makes of them is answer.test.ts's.
 */
describe("message framing", () => {
  it("carries each delta's message id, and a retraction, into the harness vocabulary", async () => {
    // The live shape of a mid-stream retry: the partial attempt is retracted
    // by id, and the replay streams as a new message.
    state.events = [
      { ev: "text_delta", text: "PARTIAL ", message_id: "text-1" },
      { ev: "text_replace", text: "", message_id: "text-1" },
      { ev: "text_delta", text: "FINAL", message_id: "text-2" },
      { ev: "text_done", message_id: "text-2" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const events = await collect(session.runTurn({ message: "hi" }));

    expect(
      events.filter(
        (e) => e.type === "text.delta" || e.type === "text.replace",
      ),
    ).toEqual([
      { type: "text.delta", text: "PARTIAL ", messageId: "text-1" },
      { type: "text.replace", messageId: "text-1", text: "" },
      { type: "text.delta", text: "FINAL", messageId: "text-2" },
    ]);
    // `text_done` needs no event: a new id is the boundary.
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("an unframed bridge's deltas carry no id, and an id-less correction is dropped", async () => {
    // A runtime without framing: every delta reads as unframed text, and a
    // correction that cannot name its message has nothing it could replace.
    state.events = [
      { ev: "text_delta", text: "plain" },
      { ev: "text_replace", text: "orphan correction" },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    const events = await collect(session.runTurn({ message: "hi" }));

    expect(
      events.filter(
        (e) => e.type === "text.delta" || e.type === "text.replace",
      ),
    ).toEqual([{ type: "text.delta", text: "plain" }]);
  });

  it("a foreign run's correction is quarantined with its other text, never yielded", async () => {
    // Under a standing fence, another run's `text_replace` is that run's
    // business: it must not retract or rewrite anything in OUR answer.
    state.events = [];
    state.manualAccept = true;
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    const client = state.clients[0];
    client?.push({ ev: "text_delta", text: "WAKE", message_id: "text-9" });
    client?.push({ ev: "text_replace", text: "", message_id: "text-9" });
    client?.push({ ev: "message_accepted", session_id: client.sessionId });
    client?.push({ ev: "text_delta", text: "ours", message_id: "text-10" });
    client?.push({ ev: "turn_done" });

    const events: HarnessEvent[] = [];
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    ) {
      events.push(next.value);
    }

    expect(events.some((e) => e.type === "text.replace")).toBe(false);
    expect(
      events.filter((e) => e.type === "text.delta").map((e) => e.messageId),
    ).toEqual(["text-10"]);
    // Foreign text was excluded, so the reader is told.
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  }, 15_000);

  it("a foreign correction carrying text is excluded text too: the reader is told", async () => {
    // Its text would have rewritten what the reader saw, so dropping it is
    // an exclusion like any other foreign text, never a silent one.
    state.events = [];
    state.manualAccept = true;
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started
    state.clients[0]?.push({
      ev: "text_replace",
      text: "a wake run's corrected words",
      message_id: "text-9",
    });
    state.clients[0]?.push({ ev: "message_accepted", session_id: "s-1" });
    state.clients[0]?.push({ ev: "turn_done" });

    const events: HarnessEvent[] = [];
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    ) {
      events.push(next.value);
    }

    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  }, 15_000);
});

describe("turn usage", () => {
  /** One turn's usage, with the daemon reporting `provider` (model_info)
   * on the session's connection first, as it does at create. */
  const usageUnder = async (
    provider: string | undefined,
    frame: Record<string, unknown>,
  ) => {
    state.events = [{ ev: "token_usage", ...frame }, { ev: "turn_done" }];
    const { session } = await startSession();
    if (provider !== undefined) {
      state.clients.at(-1)?.emitNamed("model_info", {
        ev: "model_info",
        provider,
      });
    }
    const events = await collect(session.runTurn({ message: "hi" }));
    const done = events.at(-1);
    return done?.type === "turn.done" ? done.usage : undefined;
  };

  it("keeps every raw counter, and measures a Claude prompt as input plus both cache halves", async () => {
    // Anthropic reports cache reads and writes APART from the input: the
    // prompt is all three, and dropping the write half would read a full
    // context as a small one.
    expect(
      await usageUnder("Claude", {
        input: 12,
        output: 300,
        cache_read_input: 150_000,
        cache_creation_input: 30_000,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 300,
      cacheReadInputTokens: 150_000,
      cacheCreationInputTokens: 30_000,
      promptTokens: 180_012,
    });
  });

  it("measures an OpenAI prompt as the input alone: its cache counters are inside it", async () => {
    // Live shape at p136 (gpt-5.4): input 12464, of which 11904 cached.
    expect(
      await usageUnder("OpenAI", {
        input: 12_464,
        output: 16,
        cache_read_input: 11_904,
        cache_creation_input: 0,
      }),
    ).toMatchObject({ inputTokens: 12_464, promptTokens: 12_464 });
  });

  it("an unknown provider, or none reported, carries no measured prompt", async () => {
    for (const provider of [undefined, "Gemini"]) {
      const usage = await usageUnder(provider, {
        input: 40,
        output: 5,
        cache_read_input: 900,
      });
      expect(usage).toMatchObject({ inputTokens: 40, outputTokens: 5 });
      expect(usage).not.toHaveProperty("promptTokens");
    }
  });

  it("follows a model switch: the latest provider the daemon reported counts", async () => {
    state.events = [
      { ev: "token_usage", input: 1_000, output: 1, cache_read_input: 900 },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();
    state.clients[0]?.emitNamed("model_info", { provider: "Claude" });
    state.clients[0]?.emitNamed("model_info", { provider: "OpenAI" });
    const events = await collect(session.runTurn({ message: "hi" }));
    expect(events.at(-1)).toMatchObject({ usage: { promptTokens: 1_000 } });
  });
});

describe("a turn that ends unanswered (jcode's turn_stopped)", () => {
  /** The frames the pinned bridge sends for a refusal, in its order: the
   * call's usage, the stop with the provider's reason, then an ordinary
   * `turn_done` (translate.rs emits TurnStopped before TurnDone). */
  const refusalFrames = (stopReason = "refusal") => [
    { ev: "token_usage", input: 41, output: 0 },
    {
      ev: "turn_stopped",
      session_id: "s",
      reason: "provider_guardrail",
      message: `Provider guardrail stopped the response (stop_reason: ${stopReason}). The model declined to answer this request.`,
      provider_stop_reason: stopReason,
    },
    { ev: "turn_done" },
  ];

  it("yields turn.unanswered (model_refused) just before a clean turn.done that keeps its usage", async () => {
    state.events = refusalFrames();
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    const unanswered = events.filter((e) => e.type === "turn.unanswered");
    expect(unanswered).toEqual([
      {
        type: "turn.unanswered",
        code: "model_refused",
        message: expect.stringContaining("declined to answer"),
      },
    ]);
    // Immediately ahead of the terminal, which stays an ordinary clean end:
    // the supervisor decides what the turn's outcome is.
    expect(events.at(-2)?.type).toBe("turn.unanswered");
    expect(events.at(-1)).toMatchObject({
      type: "turn.done",
      usage: { inputTokens: 41, outputTokens: 0 },
    });
  });

  it("an empty response with no safety stop reads as model_empty_response", async () => {
    state.events = [
      {
        ev: "turn_stopped",
        session_id: "s",
        reason: "provider_guardrail",
        message:
          "The model ended its turn without any visible output (stop_reason: end_turn).",
        provider_stop_reason: "end_turn",
      },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    expect(events.find((e) => e.type === "turn.unanswered")).toMatchObject({
      code: "model_empty_response",
    });
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("other stop reasons yield nothing new: the turn ends exactly as before", async () => {
    state.events = [
      { ev: "text_delta", text: "partial answer" },
      {
        ev: "turn_stopped",
        session_id: "s",
        reason: "limit_reached",
        message: "The provider stopped with max_tokens.",
        provider_stop_reason: "max_tokens",
      },
      { ev: "turn_done" },
    ];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    expect(events.some((e) => e.type === "turn.unanswered")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("a safety stop AFTER visible words is not reported: the reply was cut short, not withheld", async () => {
    // jcode raises the stop on the stop reason alone, words or not. The
    // person got words, so the turn keeps them as its answer.
    state.events = [
      { ev: "text_delta", text: "Here is what I can share.", message_id: "m1" },
      ...refusalFrames(),
    ];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    expect(events.some((e) => e.type === "turn.unanswered")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.done");
  });

  it("words BEFORE a tool call do not count: the closing stretch was empty", async () => {
    // Narration, a tool, then a refusal with nothing after it: the
    // answer the person is owed (the words after the last tool) is empty.
    state.events = [
      { ev: "text_delta", text: "Let me look.", message_id: "m1" },
      { ev: "tool_start", call_id: "c1", name: "bash" },
      { ev: "tool_done", call_id: "c1", name: "bash", output: "ok" },
      ...refusalFrames(),
    ];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    expect(events.find((e) => e.type === "turn.unanswered")).toMatchObject({
      code: "model_refused",
    });
  });

  it("words a correction retracted do not count: nothing visible stands", async () => {
    state.events = [
      { ev: "text_delta", text: "partial attempt", message_id: "m1" },
      { ev: "text_replace", text: "", message_id: "m1" },
      ...refusalFrames(),
    ];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    expect(events.find((e) => e.type === "turn.unanswered")).toMatchObject({
      code: "model_refused",
    });
  });

  it("whitespace is not words", async () => {
    state.events = [
      { ev: "text_delta", text: "\n  \n", message_id: "m1" },
      ...refusalFrames(),
    ];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    expect(events.some((e) => e.type === "turn.unanswered")).toBe(true);
  });

  it("a second stop frame in the same turn is not reported twice", async () => {
    state.events = [...refusalFrames().slice(0, 2), ...refusalFrames()];
    const { session } = await startSession();

    const events = await collect(session.runTurn({ message: "hey" }));

    expect(events.filter((e) => e.type === "turn.unanswered")).toHaveLength(1);
  });

  it("a foreign run's refusal before our fence is quarantined, never this turn's outcome", async () => {
    // An orphan or self-wake run refused while our send waited behind it:
    // its stop frame is another run's, like its text and its terminal.
    state.events = [];
    state.manualAccept = true;
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started

    const client = state.clients[0];
    client?.push({
      ev: "turn_stopped",
      session_id: client.sessionId,
      reason: "provider_guardrail",
      message: "foreign refusal",
      provider_stop_reason: "refusal",
    });
    client?.push({ ev: "turn_done" });
    // Our turn spawns and answers.
    client?.push({ ev: "message_accepted", session_id: client.sessionId });
    client?.push({ ev: "text_delta", text: "ours" });
    client?.push({ ev: "turn_done" });

    const events: HarnessEvent[] = [];
    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(events.some((e) => e.type === "turn.unanswered")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(
      events.some((e) => e.type === "text.delta" && e.text === "ours"),
    ).toBe(true);
  }, 15_000);

  it("a refusal that lands after a Stop is not reported: the person ended this turn", async () => {
    // The Stop must land while the LIVE loop runs (past the settle phase),
    // or the settle phase's own abort check ends the turn before any frame
    // is read and this pin proves nothing.
    state.events = [];
    state.manualAccept = true;
    const { session } = await startSession();
    const iterator = session
      .runTurn({ message: "task" })
      [Symbol.asyncIterator]();
    await iterator.next(); // turn.started

    const client = state.clients[0];
    client?.push({ ev: "message_accepted", session_id: client.sessionId });
    client?.push({ ev: "text_delta", text: "working on it" });
    const events: HarnessEvent[] = [];
    // Read up to the delta: the settle window has closed and the live loop
    // owns the stream.
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("turn ended before the live loop");
      events.push(next.value);
      if (next.value.type === "text.delta") break;
    }

    await session.abort();
    for (const frame of refusalFrames()) client?.push(frame);

    let next = await iterator.next();
    while (!next.done) {
      events.push(next.value);
      next = await iterator.next();
    }

    expect(events.some((e) => e.type === "turn.unanswered")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.done");
  }, 15_000);
});

describe("the context size", () => {
  const capCalls = () =>
    callsOf("setContextCap").map(({ args }) => ({
      session: args[0],
      tokens: args[1],
    }));

  it("sets the platform's size on THIS session before the message, then skips an unchanged one", async () => {
    const { session } = await startSession();
    await collect(
      session.runTurn({ message: "first", contextTokens: 1_000_000 }),
    );

    // Always with the session id: the id-less form hangs on an open session.
    expect(capCalls()).toEqual([
      { session: session.sessionRef, tokens: 1_000_000 },
    ]);
    const order = state.calls.map((c) => c.method);
    expect(order.indexOf("setContextCap")).toBeLessThan(
      order.indexOf("sendMessage"),
    );

    await collect(
      session.runTurn({ message: "second", contextTokens: 1_000_000 }),
    );
    expect(capCalls()).toHaveLength(1);
  });

  it("a changed size is set again; no size at all sets nothing", async () => {
    const { session } = await startSession();
    await collect(session.runTurn({ message: "a", contextTokens: 200_000 }));
    await collect(session.runTurn({ message: "b", contextTokens: 100_000 }));
    await collect(session.runTurn({ message: "c" }));

    expect(capCalls().map((c) => c.tokens)).toEqual([200_000, 100_000]);
  });

  it("a refusal never costs the turn, and the next turn tries again", async () => {
    state.contextCap = {
      kind: "error",
      error: Object.assign(new Error("invalid_request"), {
        code: "invalid_request",
      }),
    };
    const { session } = await startSession();
    const events = await collect(
      session.runTurn({ message: "hi", contextTokens: 1_000_000 }),
    );
    expect(events.at(-1)?.type).toBe("turn.done");

    state.contextCap = { kind: "ok" };
    await collect(
      session.runTurn({ message: "again", contextTokens: 1_000_000 }),
    );
    expect(capCalls()).toHaveLength(2);
  });

  it("a daemon that never answers holds the turn only for the bound", async () => {
    state.contextCap = { kind: "hang" };
    CONTEXT_CAP_WAIT_MS.value = 50;
    const { session } = await startSession();

    const started = Date.now();
    const events = await collect(
      session.runTurn({ message: "hi", contextTokens: 1_000_000 }),
    );
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(callsOf("sendMessage")).toHaveLength(1);
  }, 10_000);
});
