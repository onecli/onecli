import type { AgentEvent } from "./events";

/**
 * The vendor-neutral harness interface (plans/hosted-agents-v2.md §3.5).
 * Defined entirely in OUR vocabulary; an adapter translates a vendor's
 * surface onto it and nothing above the adapter may know which vendor ran
 * (invariants 8–9). Every adapter — the fake included — passes the same
 * conformance suite, and a capability the profile does not declare is never
 * exercised.
 */

/**
 * Every adapter id the platform can boot today. The harness column/env stays
 * a deliberately free string — that looseness is the seam that keeps adapter
 * #2 cheap (see the `harness` comment in schema.prisma) — so this list is not
 * a wire type. It exists so composition roots and validations fail FAST on a
 * typo instead of silently booting the default adapter. Adapter #2 = one
 * entry here + one registry line at the composition root.
 */
export const KNOWN_AGENT_HARNESSES = ["jcode", "fake"] as const;
export type KnownAgentHarness = (typeof KNOWN_AGENT_HARNESSES)[number];

/** What an adapter can do, declared up front — never probed at runtime. */
export interface HarnessCapabilities {
  /** Can reopen a prior session from state on the home volume (§3.6). */
  resume: boolean;
  /** Emits `thinking.delta` events. */
  thinking: boolean;
  /** Emits `tool.started` / `tool.finished` events. */
  toolEvents: boolean;
  /**
   * Can inject a user message into an IN-FLIGHT turn at the harness's next
   * safe point (`HarnessSession.steer`). Absent steering, a mid-run
   * follow-up simply runs as the next turn — the queue-only degrade the
   * control plane owns.
   */
  steer: boolean;
  /**
   * Home-relative directory the harness natively scans for skills
   * (e.g. ".agents/skills"), or null when it loads none. The materializer
   * (step 9) writes wherever the active adapter declares.
   */
  skillsDir: string | null;
  /**
   * Instruction files the harness reads at session start, home-relative.
   * The renderer writes every file named here (§3.11 — write both spellings
   * when adapters differ).
   */
  instructionFiles: string[];
}

/**
 * How hard the model should think — OUR ordinal scale, not any vendor's.
 *
 * Every harness spells this differently (one bakes the level into the model id,
 * another takes a string, a third has no such concept), and every provider
 * accepts a different subset. Above the adapter there is exactly this scale;
 * the adapter maps it onto whatever its vendor wants, and drops it when the
 * vendor has nowhere to put it.
 */
export const AGENT_EFFORTS = ["low", "medium", "high", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface StartSessionOptions {
  /** Absolute path of the agent's home (the durable volume). */
  homeDir: string;
  /**
   * The PROVIDER's model id (`claude-sonnet-4-6`), never a harness alias.
   * Translating it into the harness's own vocabulary is the adapter's job.
   * Omitted = the harness's configured default.
   */
  model?: string;
  /** Omitted = send nothing and let the provider's own default stand. */
  effort?: AgentEffort;
  /**
   * Opaque ref from a prior session's `sessionRef`. Only meaningful when
   * `capabilities.resume`; passing one to a non-resuming adapter is a bug.
   */
  resumeSessionRef?: string;
  /**
   * The conversation this session serves. Anchoring, not authority (the
   * control plane re-verifies every context claim): it lets the adapter
   * attribute session-scoped harness events — a wake request arriving
   * between turns — to the right conversation. Optional so adapters and
   * fixtures that never emit such events need not thread it.
   */
  context?: { conversationId: string };
}

/**
 * An image handed to the harness INLINE with the turn's message, so the model
 * sees it without choosing to read a file. OUR vocabulary (invariant 9) —
 * whatever tuple/block shape a vendor wants is the adapter's translation.
 * The bytes come off the home disk at turn start (they were materialized as
 * `attachment.part` frames first), so this never rides the runner wire.
 */
export interface TurnImage {
  /** IANA media type, e.g. "image/png". */
  mediaType: string;
  dataBase64: string;
}

export interface TurnInput {
  message: string;
  /**
   * Inline-vision images, already budget-packed by the supervisor (per-image
   * and total caps in ./attachments). Optional and additive: an adapter that
   * cannot carry images ignores it — the files are on disk regardless.
   */
  images?: TurnImage[];
}

export interface SteerInput {
  /**
   * Opaque correlation token (control-plane side: the follow-up row's id).
   * The adapter echoes it in the `message.joined` event when it confirms
   * the live turn consumed this message.
   */
  id: string;
  /** The user's words, verbatim — injected as a user message. */
  message: string;
}

export interface HarnessSession {
  /**
   * Opaque ref that can resume this session later (null when the adapter
   * does not support resume). Its meaning belongs to the adapter alone.
   */
  readonly sessionRef: string | null;
  /**
   * Run one turn. The iterable yields canonical events in order and always
   * terminates with exactly one terminal event (`turn.done` or `error`) —
   * including after `abort()`.
   */
  runTurn(input: TurnInput): AsyncIterable<AgentEvent>;
  /**
   * Queue a user message into the IN-FLIGHT turn, to be injected at the
   * harness's next safe point. Present only when `capabilities.steer`.
   *
   * Contract: between turns it must REFUSE (throw) — never queue for a
   * future turn, which would deliver the message out of order and outside
   * the platform's records. A resolved call means "the harness accepted it
   * for this run", not "the model saw it": consumption is confirmed by a
   * `message.joined` event before the turn's terminal event, and a steer
   * that resolves but never joins is reported `missed` so the control plane
   * re-runs the message as its own turn.
   */
  steer?(input: SteerInput): Promise<void>;
  /** Stop the in-flight turn; the runTurn iterable still ends cleanly. */
  abort(): Promise<void>;
}

/**
 * One background task the HARNESS itself is running (step 10 addendum) — work
 * the agent started through the harness's own tooling rather than the
 * platform's `process_start`. The supervisor observes these and mirrors them
 * through the same process-state machinery, because the platform must know
 * about ALL background work to keep the machine awake while it runs and to
 * wake the agent when it ends; a task the platform cannot see dies silently
 * at idle-stop (proven live against the real harness).
 */
export interface HarnessBackgroundTask {
  /** Harness-assigned stable id; the control plane keys rows (sandboxId, ref). */
  ref: string;
  /** Best available label for what runs (some harnesses record only a
   * display summary, not the full command line). */
  command: string;
  name?: string;
  status: "running" | "exited" | "stopped";
  exitCode?: number;
  /** Terminal failure text, when the harness recorded one. */
  error?: string;
  /** ISO timestamps on the harness's clock. */
  startedAt: string;
  endedAt?: string;
  /** NEW output since the previous poll (adapter-tracked offsets, capped). */
  outputDelta?: string;
  /** The agent asked its harness to WAKE it when this task completes. The
   * observer converts that intent into a platform exit-watch, so the wake
   * arrives as a real turn instead of a harness-internal one. */
  wantsWake: boolean;
  /**
   * The conversation this task belongs to, when the ADAPTER knows it better
   * than the observer's active-turn heuristic — a harness-emitted wake
   * request is anchored to its own session's conversation even when no turn
   * (or a SIBLING conversation's turn) is running. Snapshot context wins
   * over the active turn at the observer. Optional and adapter-internal:
   * the wire's process.state already carries an optional context.
   */
  context?: { conversationId: string; turnId?: string };
  /**
   * The wake prompt the fired watch should carry, when the generic
   * "a background task finished" wording would lie (a communication
   * delivery, a resolved fan-out await). Used only when the observer arms
   * the implicit wake watch for this task.
   */
  wakePrompt?: string;
}

export interface HarnessBackgroundTasks {
  /** Snapshot every known task. Called on a ~1s clock; must be cheap and
   * must never throw for one unreadable task (skip it, converge next poll). */
  poll(): Promise<HarnessBackgroundTask[]>;
}

export interface Harness {
  /** Stable adapter id — a display label, never a branch key. */
  readonly id: string;
  readonly capabilities: HarnessCapabilities;
  /**
   * Present when the harness runs background tasks of its own that the
   * platform should observe (see HarnessBackgroundTask). Adapters whose
   * harness has no such machinery omit it.
   */
  readonly backgroundTasks?: HarnessBackgroundTasks;
  startSession(options: StartSessionOptions): Promise<HarnessSession>;
  /**
   * Register the listener for TERMINAL failure of whatever backs this adapter
   * — the process died, the socket closed, the runtime never came up.
   *
   * It exists because a dead harness is otherwise indistinguishable from a
   * healthy one from the outside: the container keeps running, its control
   * channel stays connected, and every turn — including the first turn of a
   * brand-new conversation — fails with the same error, forever. Only the
   * adapter can tell "my backing process is gone" from "that session could
   * not be opened", so only the adapter can raise this.
   *
   * Contract: called at most once, never during `dispose()` (a deliberate
   * teardown is not a failure), and never for a failure confined to one
   * session. `reason` is for logs, never for branching.
   */
  onFailure(listener: (reason: string) => void): void;
  /** Tear down everything the adapter started (processes, sockets). */
  dispose(): Promise<void>;
}
