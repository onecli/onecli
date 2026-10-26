import type { AgentEvent } from "./events";

/**
 * A text delta as a harness reports it: the canonical `text.delta`, plus the
 * MESSAGE it belongs to when the harness frames its output, and the
 * FOLLOW-UP it answers when the harness can tell.
 *
 * `messageId` is the harness's own id for one assistant message. Deltas that
 * share it are one message; a new id starts the next one. A harness that does
 * not frame its output omits it, and its whole stream then reads as one
 * message per tool-free stretch (the supervisor's unframed rule). Opaque:
 * only equality means anything.
 *
 * `replyTo` names the steered follow-up this delta is the agent's reply to:
 * the first message after that follow-up was injected, as it streams. The
 * supervisor forwards such a delta under the follow-up's own id, so the
 * reply is read live under the message it answers, and the durable `text`
 * the handover stores there replaces it (the delta law). Absent on every
 * delta that is the turn's own narration, and on a harness that cannot see
 * where an injection landed.
 */
interface HarnessTextDelta {
  type: "text.delta";
  text: string;
  messageId?: string;
  replyTo?: string;
}

/**
 * The harness CORRECTED a message it already streamed: replace that
 * message's text with this. Empty text retracts it. Harnesses emit it when a
 * provider attempt is rolled back mid-stream and replayed, or when output is
 * repaired after the fact, so text the model never really said must not stay
 * in the answer.
 */
interface HarnessTextReplace {
  type: "text.replace";
  messageId: string;
  text: string;
}

/**
 * A steered follow-up the run CONSUMED (the canonical `message.joined`):
 * the harness confirmed the model has the message. Emitted the moment the
 * harness can tell (at the injection, on a runtime with the live pickup
 * signal), so the join precedes every delta of the reply, or just before
 * the terminal event on a runtime that can only tell at the end.
 */
interface HarnessMessageJoined {
  type: "message.joined";
  followUpId: string;
}

/**
 * What the agent said back to a steered follow-up, once the reply is
 * complete: its first message after the follow-up was injected, written
 * before it did anything else, as the harness recorded it. Never emitted
 * when the agent went straight to a tool, when the harness cannot see where
 * the injection landed, or when it cannot say. Always after that
 * follow-up's `message.joined`. The supervisor stores it as the follow-up's
 * own answer, so a mid-turn question is answered under itself rather than
 * lost to the turn's closing words. Harness-to-supervisor only: no wire
 * form (the reply reaches the transcript as a durable `text` event).
 */
interface HarnessMessageReplied {
  type: "message.replied";
  followUpId: string;
  reply: string;
}

/**
 * What `HarnessSession.runTurn` yields: the canonical vocabulary, with message
 * framing and follow-up replies on top. Both are harness-to-supervisor
 * concerns only. The supervisor reads them to build the turn's answers, then
 * forwards each event in the wire vocabulary (`AgentEvent`), which carries
 * neither: a reply travels as its own durable `text` event instead.
 */
export type HarnessEvent =
  | Exclude<AgentEvent, { type: "text.delta" | "message.joined" }>
  | HarnessTextDelta
  | HarnessTextReplace
  | HarnessMessageJoined
  | HarnessMessageReplied;

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
   * Can move the tool an in-flight turn is waiting on to the background
   * (`HarnessSession.backgroundRunningTool`), so queued steers are read now
   * instead of after the tool (SEND NOW). Absent it, a
   * steered follow-up is read at the run's next safe point as before, and
   * SEND NOW answers `moved: false`.
   */
  backgroundTool: boolean;
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
  /**
   * Connects to the supervisor's platform-tools bridge (MCP) at session
   * start, and therefore ASKS it for the tool list. Declared, never probed:
   * the supervisor holds a starting session's first turn until that listing
   * arrives, because the harness serves its own on-disk tool cache until
   * discovery lands — and a harness that never asks must not be waited for.
   */
  platformTools: boolean;
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

/** What `HarnessSession.backgroundRunningTool` did. */
export interface BackgroundedTool {
  /** A running tool was moved to the background. */
  moved: boolean;
  /** The moved tool's name, when the harness reports it. */
  toolName?: string;
}

export interface SteerInput {
  /**
   * Opaque correlation token (control-plane side: the follow-up row's id).
   * The adapter echoes it in the `message.joined` event when it confirms
   * the live turn consumed this message.
   */
  id: string;
  /**
   * The model-facing text, injected verbatim as a user message: the person's
   * words as the supervisor composed them at its boundary (a delivery-only
   * frame in front, when the control plane sent one). The adapter never
   * rewrites it, and confirms the join by finding it in the run.
   */
  message: string;
  /**
   * Inline-vision images sent with the follow-up, budget-packed by the
   * supervisor exactly like a turn's (`TurnInput.images`), injected with the
   * words as one user message. Optional and additive, like the turn's: an
   * adapter that cannot carry them ignores it, and the files are on disk
   * regardless.
   */
  images?: TurnImage[];
}

export interface HarnessSession {
  /**
   * Opaque ref that can resume this session later (null when the adapter
   * does not support resume). Its meaning belongs to the adapter alone.
   */
  readonly sessionRef: string | null;
  /**
   * Run one turn. The iterable yields harness events in order and always
   * terminates with exactly one terminal event (`turn.done` or `error`) —
   * including after `abort()`.
   */
  runTurn(input: TurnInput): AsyncIterable<HarnessEvent>;
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
  /**
   * Move the tool the in-flight turn is waiting on to the BACKGROUND, so the
   * run reaches its next safe point now and injects whatever steers are
   * queued (SEND NOW). The tool keeps running; the model is
   * told where to collect it. Resolves with what actually happened, and
   * only says `moved` when the harness confirmed a tool was moved: a
   * harness that cannot tell resolves `{ moved: false }` rather than guess,
   * because the answer is shown to the person who asked. Present only when
   * `capabilities.backgroundTool`.
   */
  backgroundRunningTool?(): Promise<BackgroundedTool>;
  /** Stop the in-flight turn; the runTurn iterable still ends cleanly. */
  abort(): Promise<void>;
  /**
   * Let go of this session WITHOUT ending it, so a later `startSession`
   * with its `sessionRef` resumes the same transcript in THIS process. The
   * supervisor calls it between turns when the agent's surface changed
   * under a live session (a chat presence attached mid-run): the harness
   * captures the instruction doc and its tool list at session start, so
   * only a fresh session sees the change — and resume is what keeps the
   * conversation's memory across that restart. Optional: an adapter whose
   * refs are never held by a live client (the fake) needs nothing here.
   * Never called with a turn in flight.
   */
  release?(): Promise<void>;
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
