import type { RunnerSandboxChannel } from "@onecli/agent-protocol";
import type { SandboxSnapshot } from "./backend/types";

/**
 * THE RECONCILER'S VERDICT on one container, from the control plane's
 * facts. With several runner copies a sandbox's socket lives in whichever
 * copy its supervisor reached, so "does this sandbox have a channel" is a
 * control-plane fact (`channels` in the sandboxes listing), never one
 * process's memory. Pure, so every state and grace is pinned by a table.
 *
 * - `leave`: nothing to do (healthy, booting, reconnecting inside its grace,
 *   mid-start, or facts about a newer container).
 * - `boot-crash`: a spawn died before its supervisor ever connected, and its
 *   dial-in grace is over.
 * - `channelless`: running, no channel, and not coming back.
 * - `stray`: channelless, and the control plane already parked the row: the
 *   container must be stopped, a report would change nothing.
 * - `dead`: the container is dead and nothing holds or awaits its channel.
 */
export type ReconcileVerdict =
  | "leave"
  | "boot-crash"
  | "channelless"
  | "stray"
  | "dead";

export interface ReconcileGraces {
  /** How long after its spawn is recorded a never-connected dead container
   * waits before it is a boot crash (a slow image pull is not a crash). */
  bootDialInMs: number;
  /** How long a drop a live copy SAW stays "reconnecting": the supervisor's
   * whole retry budget. */
  droppedMs: number;
  /** How long a sandbox whose holder died or retired (or whose channel
   * predates records) stays "reconnecting": its supervisor redials the
   * moment any copy is reachable, so this is much shorter. */
  inheritedMs: number;
}

export interface ClassifyInput {
  snapshot: Pick<
    SandboxSnapshot,
    "containerRef" | "running" | "phase" | "resumable"
  >;
  /** The control plane's status for the sandbox this pass, if it sent one. */
  believed: string | undefined;
  /** The control plane's channel facts for the sandbox, if it sent any. */
  channel: RunnerSandboxChannel | undefined;
  now: number;
  /** When this copy became the reconciler: the earliest moment it could
   * have started watching inherited sandboxes reconnect. */
  reconcilerSince: number;
  /** Whether this runner hands out resumable sessions at all. */
  sessions: boolean;
  graces: ReconcileGraces;
}

/** A phase that will never become running (or no phase concept at all). */
const terminal = (phase: string | null | undefined): boolean =>
  phase == null || phase === "Failed" || phase === "Succeeded";

/**
 * Is a running container's supervisor still inside its reconnect grace?
 * The state is an open string on the wire: anything that is not `dropped`
 * or `lost` (`none`, or a state a newer control plane added) gets the
 * inherited grace from the takeover, the cautious reading.
 */
const reconnecting = (
  state: string,
  since: number | null,
  { now, reconcilerSince, sessions, snapshot, graces }: ClassifyInput,
): boolean => {
  // Only a supervisor holding a session can come back at all: one spawned
  // without (or by a runner without) a keyring has a spent token and
  // nothing else, so its drop is a death.
  if (!sessions || !snapshot.resumable) return false;
  if (state === "dropped") {
    return since !== null && now - since < graces.droppedMs;
  }
  // `lost` (holder died or retired) and `none` (unrecorded): the clock
  // starts at the later of the last thing known and the moment this copy
  // took over.
  const anchor = Math.max(state === "lost" ? (since ?? 0) : 0, reconcilerSince);
  return now - anchor < graces.inheritedMs;
};

export const classifySandbox = (input: ClassifyInput): ReconcileVerdict => {
  const { snapshot, channel, believed, now, graces } = input;

  // Facts about a NEWER container (a start recreated it, or is recording
  // it right now) say nothing about this one; the start that superseded it
  // already removed it or is about to.
  if (
    channel?.containerRef != null &&
    channel.containerRef !== snapshot.containerRef
  ) {
    return "leave";
  }

  const state = channel?.channel ?? "none";
  const since = channel?.since ?? null;

  if (!snapshot.running) {
    if (state === "awaiting") {
      // Never connected. A crash only once the phase is final and the
      // dial-in grace since the spawn has passed.
      return since !== null &&
        terminal(snapshot.phase) &&
        now - since > graces.bootDialInMs
        ? "boot-crash"
        : "leave";
    }
    // Held (its holder will see the close) or mid-start: someone owns it.
    if (state === "held" || state === "starting") return "leave";
    // A dead container has no supervisor to reconnect: no grace.
    return "dead";
  }

  if (state === "held" || state === "awaiting" || state === "starting") {
    return "leave";
  }
  if (reconnecting(state, since, input)) return "leave";
  return believed === "stopped" || believed === "failed"
    ? "stray"
    : "channelless";
};

/**
 * THE VANISHED-POD ARM: sandboxes the control plane believes `running` with
 * no container at all, reported only on the SECOND consecutive pass that
 * sees them missing (one stale read must never report a healthy agent
 * stopped). `present` holds every sandbox with a container, plus any the
 * caller has lifecycle work in flight for (its create may be mid-call).
 * Returns what to report now and the memory for the next pass.
 */
export const vanishedSandboxes = (
  statuses: Record<string, string> | undefined,
  present: ReadonlySet<string>,
  previous: ReadonlySet<string>,
): { report: string[]; missing: Set<string> } => {
  const report: string[] = [];
  const missing = new Set<string>();
  for (const [sandboxId, status] of Object.entries(statuses ?? {})) {
    if (status !== "running" || present.has(sandboxId)) continue;
    if (previous.has(sandboxId)) report.push(sandboxId);
    else missing.add(sandboxId);
  }
  return { report, missing };
};
