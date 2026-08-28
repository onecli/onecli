import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  Harness,
  HarnessSession,
  StartSessionOptions,
  SteerInput,
  TurnInput,
} from "@onecli/agent-protocol";
import { ensureManagedDir, writeManagedFile } from "../home/fs";
import { platformToolsSocketPath } from "../platform-tools";
import { parseFakeDirective, runDirective } from "./fake-directives";

/**
 * The fake in-process adapter (§3.5 rule 4): passes the same conformance
 * suite as the real one with no Docker and no model key — the cheapest proof
 * that the interface is genuinely an interface and not a vendor-shaped hole.
 * Also what keeps the conversation plane testable from step 4 on. Step 13
 * adds two seams for black-box driving: the `@fake:v1` turn directive
 * (fake-directives.ts) and a home-volume-durable session store, which is what
 * makes the declared `resume: true` hold across container recreation — the
 * control plane persists `harnessSessionRef` and re-sends it after a wake,
 * and the runner recreates the container on every start.
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FakeScript = (input: TurnInput) => AgentEvent[];

const defaultScript: FakeScript = (input) => [
  { type: "tool.started", callId: "fake-1", name: "echo" },
  { type: "tool.finished", callId: "fake-1", name: "echo", output: "ok" },
  { type: "text.delta", text: `Fake answer to: ${input.message}` },
  { type: "turn.done", usage: { inputTokens: 1, outputTokens: 1 } },
];

interface FakeState {
  turnsRun: number;
}

/** Session state that survives "restarts" (new harness, same store). */
export type FakeSessionStore = Map<string, FakeState>;

export const createFakeSessionStore = (): FakeSessionStore => new Map();

/**
 * Durable-store file, on the home volume so it survives container
 * recreation — the fake's analogue of jcode's on-volume session state.
 * Written through the symlink-hardened home/fs primitives (the home is
 * agent-writable), read with an lstat gate so a planted symlink or FIFO can
 * feed us nothing and wedge nothing.
 */
const DURABLE_DIR = ".onecli";
const DURABLE_FILE = "fake-sessions.json";
const DURABLE_MAX_BYTES = 65_536;

const durablePath = (homeDir: string): string =>
  join(homeDir, DURABLE_DIR, DURABLE_FILE);

/** Merge file-backed sessions into the store; in-memory state is fresher. */
const mergeDurableSessions = (
  store: FakeSessionStore,
  homeDir: string,
): void => {
  const path = durablePath(homeDir);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > DURABLE_MAX_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // Corrupt file = start empty; never crash a boot over it.
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1
  )
    return;
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (typeof sessions !== "object" || sessions === null) return;
  for (const [ref, state] of Object.entries(sessions)) {
    const turnsRun = (state as { turnsRun?: unknown })?.turnsRun;
    if (!store.has(ref) && typeof turnsRun === "number") {
      store.set(ref, { turnsRun });
    }
  }
};

const saveDurableSessions = (
  store: FakeSessionStore,
  homeDir: string,
): void => {
  try {
    const dir = ensureManagedDir(homeDir, DURABLE_DIR);
    const sessions = Object.fromEntries(store);
    writeManagedFile(
      join(dir, DURABLE_FILE),
      JSON.stringify({ version: 1, sessions }),
      0o600,
    );
  } catch {
    // Best-effort: a failed persist degrades to the old in-memory-only
    // behavior (resume breaks across recreation), never a failed turn.
  }
};

/** Mutable across the harness and every session it started. */
interface Liveness {
  deadReason?: string;
}

/** Everything a session needs from the harness that created it. */
interface FakeSessionDeps {
  store: FakeSessionStore;
  script: FakeScript;
  liveness: Liveness;
  toolsSocketPath: () => string;
  armLaunchFailure: (reason?: string) => void;
  /** Present when a durable home backs the store (production sandboxes). */
  persist?: () => void;
}

class FakeSession implements HarnessSession {
  readonly sessionRef: string;
  private aborted = false;
  /** The in-flight gate, mirrored from the real adapter's contract. */
  private turnActive = false;
  /** Steers accepted for the LIVE turn, injected at the next event gap. */
  private pendingSteers: SteerInput[] = [];

  constructor(
    ref: string,
    private readonly deps: FakeSessionDeps,
  ) {
    this.sessionRef = ref;
    if (!deps.store.has(ref)) {
      deps.store.set(ref, { turnsRun: 0 });
      deps.persist?.();
    }
  }

  get state(): FakeState {
    const state = this.deps.store.get(this.sessionRef);
    if (!state) throw new Error("fake session state missing");
    return state;
  }

  /**
   * The turn's event source: a `@fake:v1` directive when the message carries
   * one, the legacy script otherwise (byte-identical path — what keeps the
   * conformance suite and every in-process consumer green).
   */
  private async *eventsFor(input: TurnInput): AsyncGenerator<AgentEvent> {
    const parsed = parseFakeDirective(input.message);
    if (parsed === null) {
      yield* this.deps.script(input);
      return;
    }
    if ("error" in parsed) {
      yield {
        type: "text.delta",
        text: `[fake: bad directive: ${parsed.error}]`,
      };
      yield { type: "turn.done" };
      return;
    }
    yield* runDirective(parsed.directive, {
      sessionRef: this.sessionRef,
      turnsRun: () => this.state.turnsRun,
      toolsSocketPath: this.deps.toolsSocketPath,
      armLaunchFailure: this.deps.armLaunchFailure,
    });
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.aborted = false;
    this.pendingSteers = [];
    this.turnActive = true;
    try {
      this.state.turnsRun += 1;
      this.deps.persist?.();
      yield { type: "turn.started" };
      /** Steers the run consumed — confirmed just before the terminal. */
      const joined: string[] = [];
      for await (const event of this.eventsFor(input)) {
        // A real harness is async between events; the gap is what makes the
        // conformance abort test meaningful.
        await delay(2);
        // A process that dies takes its live turns with it — the stream does
        // not end politely, it raises. Modelling that is what makes the
        // supervisor's mid-turn failure path testable.
        if (this.deps.liveness.deadReason)
          throw new Error(this.deps.liveness.deadReason);
        if (this.aborted) {
          yield { type: "turn.done" };
          return;
        }
        // The event gap IS the fake's safe injection point: a queued steer
        // surfaces as a text delta echoing it — deterministic, observable,
        // and shaped like the real thing (the message joins the same run).
        for (const steer of this.pendingSteers.splice(0)) {
          joined.push(steer.id);
          yield { type: "text.delta", text: `\n[steered: ${steer.message}]` };
        }
        if (event.type === "turn.done" || event.type === "error") {
          for (const followUpId of joined.splice(0)) {
            yield { type: "message.joined", followUpId };
          }
          yield event;
          return;
        }
        yield event;
      }
      for (const followUpId of joined.splice(0)) {
        yield { type: "message.joined", followUpId };
      }
      yield { type: "turn.done" };
    } finally {
      this.turnActive = false;
      // Undelivered steers die with the turn, like the real adapter's
      // cancelSoftInterrupts — never injected into a later run.
      this.pendingSteers = [];
    }
  }

  steer(input: SteerInput): Promise<void> {
    if (!this.turnActive) {
      return Promise.reject(new Error("no turn in flight"));
    }
    this.pendingSteers.push(input);
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }
}

/**
 * The fake plus the one thing a real adapter can only be made to do by killing
 * a process: die. Without it the supervisor's dead-harness path would be
 * reachable in a live container and nowhere else.
 */
export interface FakeHarness extends Harness {
  /** Simulate the backing process going away. Idempotent. */
  simulateFailure(reason?: string): void;
  /**
   * Arm a one-shot LAUNCH failure: the next `startSession` fires `onFailure`
   * and then rejects — the exact fail-then-throw order of the real adapter's
   * launch path (jcode marks the harness dead before rethrowing). Unlike
   * `simulateFailure` it does not pre-poison liveness, so the supervisor
   * still accepts the turn that triggers the launch.
   */
  failNextStartSession(reason?: string): void;
}

const DEFAULT_LAUNCH_FAILURE = "harness launch failed: spawn ENOENT";

export const createFakeHarness = (options?: {
  script?: FakeScript;
  store?: FakeSessionStore;
  /** Test seam; production resolves the process's own socket. */
  toolsSocketPath?: () => string;
}): FakeHarness => {
  const store = options?.store ?? createFakeSessionStore();
  const script = options?.script ?? defaultScript;
  const toolsSocketPath = options?.toolsSocketPath ?? platformToolsSocketPath;
  const nonce = randomBytes(4).toString("hex");
  let counter = 0;
  let onFailure: ((reason: string) => void) | undefined;
  let launchFailure: string | undefined;
  const liveness: Liveness = {};

  return {
    id: "fake",
    capabilities: {
      resume: true,
      thinking: false,
      toolEvents: true,
      steer: true,
      skillsDir: ".agents/skills",
      instructionFiles: ["CLAUDE.md", "AGENTS.md"],
    },
    onFailure(listener) {
      onFailure = listener;
    },
    simulateFailure(reason = "harness connection closed") {
      if (liveness.deadReason) return;
      liveness.deadReason = reason;
      onFailure?.(reason);
    },
    failNextStartSession(reason = DEFAULT_LAUNCH_FAILURE) {
      launchFailure = reason;
    },
    startSession(sessionOptions: StartSessionOptions) {
      if (launchFailure) {
        const reason = launchFailure;
        launchFailure = undefined;
        // Fail-then-throw, like the real launch path: the harness is dead
        // from here on (a real process that failed to exec serves nothing).
        liveness.deadReason = reason;
        onFailure?.(reason);
        return Promise.reject(new Error(reason));
      }
      // A dead harness starts nothing — including for a brand-new
      // conversation, which is what made the real failure permanent.
      if (liveness.deadReason)
        return Promise.reject(new Error(liveness.deadReason));
      // A durable home (real sandboxes always have one) backs the store, so
      // a resume ref minted before a container recreation still resolves.
      const homeDir = sessionOptions.homeDir;
      if (homeDir) mergeDurableSessions(store, homeDir);
      // The nonce keeps fresh refs unique ACROSS container recreations: with
      // a durable store, a restarted process's counter would otherwise re-mint
      // an old ref and silently inherit its state.
      const ref =
        sessionOptions.resumeSessionRef ??
        `fake-session-${nonce}-${(counter += 1)}`;
      if (
        sessionOptions.resumeSessionRef &&
        !store.has(sessionOptions.resumeSessionRef)
      ) {
        return Promise.reject(
          new Error(`unknown session: ${sessionOptions.resumeSessionRef}`),
        );
      }
      return Promise.resolve(
        new FakeSession(ref, {
          store,
          script,
          liveness,
          toolsSocketPath,
          armLaunchFailure: (reason = DEFAULT_LAUNCH_FAILURE) => {
            launchFailure = reason;
          },
          ...(homeDir && {
            persist: () => saveDurableSessions(store, homeDir),
          }),
        }),
      );
    },
    dispose() {
      return Promise.resolve();
    },
  };
};
