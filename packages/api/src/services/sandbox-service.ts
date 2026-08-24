import { db } from "@onecli/db";
import type { RunnerEvent, SandboxStartPayload } from "@onecli/agent-protocol";
import { signalWork } from "./due-work";
import { failStrandedTurns, reviveColdTurns } from "./turn-service";
import { buildContainerConfig } from "./container-config-service";
import { resolveAgentModel } from "../llm/resolve";
import {
  AGENT_START_FAILED_MESSAGE,
  AT_CAPACITY_MESSAGE,
  IMAGE_UNAVAILABLE_MESSAGE,
} from "../validations/conversation";
import { logger } from "../lib/logger";

const log = logger.child({ component: "sandbox-service" });

/**
 * Sandbox state and the spawn payload the runner receives.
 *
 * Every write here is fenced by `runnerId`: a runner may only move sandboxes
 * it owns. Attribution comes from the authenticated token, never from the
 * request body — a runner reporting someone else's sandbox id changes
 * nothing.
 */

/** The lifecycle states a `Sandbox.status` may hold (schema is a string). */
export const SANDBOX_STATUSES = [
  "unprovisioned",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/**
 * Compose the spawn payload for a sandbox at DISPATCH time, from current
 * truth: the agent's present proxy token and its present grants (§5.1). A
 * re-dispatched start therefore always carries fresh credentials, which is
 * what makes token regeneration a plain "start it again".
 *
 * The two `ok: false` reasons are NOT interchangeable, and the caller must
 * treat them differently:
 *
 * - `unavailable` is transient (the sandbox vanished mid-dispatch, the CA is
 *   not loaded yet). Release the claim; the next poll retries immediately.
 * - `no_llm_credential` is not. It stays true until a human grants a key, so
 *   an immediate retry is an infinite loop at poll speed — `unprovisioned` has
 *   no backoff, only the `failed` arm does. PARK it instead.
 */
export type SandboxStartDecision =
  | { ok: true; agentId: string; payload: SandboxStartPayload }
  | { ok: false; reason: "unavailable" | "no_llm_credential" };

export const buildSandboxStartPayload = async (
  sandboxId: string,
  runnerId: string,
): Promise<SandboxStartDecision> => {
  const sandbox = await db.sandbox.findFirst({
    where: { id: sandboxId, runnerId },
    select: {
      agent: {
        select: {
          id: true,
          name: true,
          accessToken: true,
          harness: true,
          model: true,
          effort: true,
          modelProvider: true,
          instructions: true,
          workspaceId: true,
          workspace: { select: { organizationId: true } },
        },
      },
    },
  });

  const agent = sandbox?.agent;
  if (!agent) return { ok: false, reason: "unavailable" };

  const result = await buildContainerConfig({
    agent: { id: agent.id, accessToken: agent.accessToken },
    workspaceId: agent.workspaceId,
    organizationId: agent.workspace.organizationId,
  });

  if (!result.ok) {
    log.warn(
      { sandboxId, reason: result.reason },
      "cannot compose spawn payload",
    );
    return { ok: false, reason: "unavailable" };
  }

  // DOOR 2 of the §3.2 credential check: refuse to compose.
  //
  // Door 1 (`turn-service.createTurn`) already answered the user, so nothing
  // here is user-facing. This exists because door 1 does not see every way a
  // start happens: the runner's poll claims a parked sandbox because a
  // queued or dispatched turn EXISTS, and Slack (step 6), crons (step 9) and
  // the stale-claim rearm will all enqueue work of their own. Whoever adds
  // the next enqueuer should not have to remember this rule — this is the
  // funnel every start actually passes through.
  //
  // Do not delete it as redundant with door 1. Door 1 is the ANSWER; this is
  // the INVARIANT.
  if (!result.llmCredential) {
    log.warn(
      { sandboxId, agentId: agent.id },
      "refusing to start a sandbox with no injectable model key",
    );
    return { ok: false, reason: "no_llm_credential" };
  }

  const { config } = result;
  const resolved = resolveAgentModel(agent, result.llmCredential.provider);

  return {
    ok: true,
    agentId: agent.id,
    payload: {
      // The workspace fence for namespaced backends (sandbox-platform step 3):
      // the cloud manager creates every sandbox inside its workspace's
      // namespace. Composed at dispatch from the same row as everything else.
      workspaceId: agent.workspaceId,
      env: config.env,
      files: [
        {
          containerPath: config.caCertificateContainerPath,
          content: config.caCertificate,
        },
        ...(config.credentialStubs ?? []).map((stub) => ({
          containerPath: stub.containerPath,
          content: stub.content,
          mode: 0o600,
        })),
      ],
      // Resolved, never the raw column: `agent.model` is only an OVERRIDE, and
      // is null for every agent nobody has configured — which is most of them.
      model: resolved.model,
      ...(resolved.effort && { effort: resolved.effort }),
      ...(agent.harness && { harness: agent.harness }),
      ...(agent.instructions && { instructions: agent.instructions }),
      ...(agent.name && { agentName: agent.name }),
      warnings: config.warnings ?? [],
    },
  };
};

/**
 * The lifecycle half of the runner's event stream — sandbox state only. Turn
 * events are deliberately NOT handled here: they belong to the transcript and
 * the live bus, and this function's `updateMany`-by-sandbox shape does not fit
 * them. The route dispatches between the two.
 */
export type SandboxLifecycleEvent = Extract<
  RunnerEvent,
  { kind: "sandbox.status" | "supervisor.ready" | "home.synced" }
>;

/**
 * Apply one runner-reported lifecycle event. Fenced by `runnerId` via
 * `updateMany` — an event naming a sandbox this runner does not own matches
 * zero rows and is silently inert (never an error that would tell a caller
 * whether the id exists).
 */
export const applyRunnerEvent = async (
  runnerId: string,
  event: SandboxLifecycleEvent,
): Promise<void> => {
  if (event.kind === "home.synced") {
    // The sync ack (step 9): applied only where it can still be true — the
    // `lt` guard is max() by construction, so duplicates, stale acks, and
    // cross-runner forgeries all match zero rows and are inert. NO
    // signalWork: an ack makes nothing dispatchable. If `desired` advanced
    // past this generation, `applied < desired` persists and the next paced
    // claim converges.
    //
    // The lease is the THIRD fence, and it is what makes a restart safe: an
    // ack the OLD container sent can still be sitting in the runner's report
    // batch when the container dies and the start claim resets applied to 0
    // and NULLs the lease. Without this term that ack would land on the FRESH
    // container — marking a home synced that was never materialized, and
    // (if nothing bumps afterwards) leaving the agent silently without its
    // skills and memory files. Every real ack answers a claim that stamped
    // the lease, so the honest path always matches.
    await db.sandbox.updateMany({
      where: {
        id: event.sandboxId,
        runnerId,
        homeAppliedGeneration: { lt: event.generation },
        homeSyncClaimedAt: { not: null },
      },
      data: {
        homeAppliedGeneration: event.generation,
        homeSyncClaimedAt: null,
      },
    });
    return;
  }

  if (event.kind === "supervisor.ready") {
    const { count } = await db.sandbox.updateMany({
      where: { id: event.sandboxId, runnerId },
      data: { status: "running", lastActiveAt: new Date() },
    });
    // A turn queued while this sandbox was booting is dispatchable exactly
    // now — wake the held poll rather than making it wait out a re-check.
    if (count > 0) signalWork();
    return;
  }

  // The container/home ref is written UNCONDITIONALLY whenever the event
  // carries one, split out of the status transition below (step 10). The ref
  // is a fact only the owning runner knows, and its writes are serialized per
  // runner in tick order (and recreate-on-start always changes the ref), so
  // last-write is correct. The status guard below would otherwise DROP the
  // ref whenever the sandbox already read `running` (a `supervisor.ready`
  // that raced ahead of the `starting` report) — and step 10 makes
  // `container_ref` load-bearing (keep-awake + process liveness), so it must
  // land on its own fence (id + runnerId) rather than ride the guarded write.
  if (event.containerRef !== undefined || event.homeRef !== undefined) {
    await db.sandbox.updateMany({
      where: { id: event.sandboxId, runnerId },
      data: {
        ...(event.containerRef !== undefined && {
          containerRef: event.containerRef,
        }),
        ...(event.homeRef !== undefined && {
          homeRef: event.homeRef,
        }),
      },
    });
  }

  const { count } = await db.sandbox.updateMany({
    where: {
      id: event.sandboxId,
      runnerId,
      // A lifecycle report describes something the runner OBSERVED, and by
      // the time it lands the control plane may have moved on. Two of them
      // are therefore only applied where they can still be true:
      //
      // `stopped` — applying it over a fresh start silently undoes that
      // start, and since the runner re-observes the same dead container every
      // reconcile tick, the two then fight forever: start, knocked back,
      // start, knocked back. Live, that pinned a sandbox and its turn for six
      // minutes.
      //
      // `starting` — the claim itself is what set `starting`, so a sandbox
      // already reading `running` has been reported ready by its supervisor
      // and this report is from the older start batch. The two travel by
      // different paths (the poll's reply vs the supervisor's channel) and
      // are not ordered against each other, so the late one would drag a
      // live sandbox back and strand every turn until the 5-minute stale
      // claim expired.
      //
      // Everything else is a fact the runner alone knows and still wins.
      ...(event.status === "stopped" && {
        status: { in: ["running", "stopping"] },
      }),
      ...(event.status === "starting" && { status: { not: "running" } }),
      // `failed` — reports are fire-and-forget with retries, so a DELAYED
      // duplicate (the runner's reconcile re-observing a corpse) can land
      // after a successful re-start reached `running`. Unguarded it would
      // knock the live sandbox back to `failed`, strand its turns through
      // the arm below, and park the queue. Every legitimate failed reporter
      // (start catch, capacity refusal, stop failure, boot-crash
      // classification) reports while the row is starting/stopping — the
      // guard costs none of them. (step 4)
      ...(event.status === "failed" && { status: { not: "running" } }),
    },
    data: {
      status: event.status,
      // containerRef/homeRef are NOT written here — they land in the
      // unconditional write above, off the status guard (step 10), so a
      // ready that raced ahead of the `starting` report can never cost us
      // the ref.
      // A container that reached `running` on its own (a restart with no new
      // turn) still counts as active, so the idle clock starts from here.
      ...(event.status === "running" && { lastActiveAt: new Date() }),
    },
  });

  /**
   * A sandbox that went down takes its in-flight turns with it.
   *
   * Every start RECREATES the container (the bootstrap token is single-use),
   * so the harness session behind a `dispatched` or `running` turn is gone
   * the moment the sandbox stops — the turn can never be resumed, only
   * re-sent. Left alone it stays non-terminal, and the active-turn index then
   * blocks its conversation until the turn ceiling half an hour later.
   *
   * Two arms, one transaction. A dispatched turn the harness never STARTED
   * (zero observable work) is revived in place and re-sent by the platform
   * itself — see `reviveColdTurns` for the safety argument — so the terminal
   * arm only sees turns that must genuinely die: running ones, and ones
   * whose one revival was already spent.
   *
   * `queued` is deliberately excluded from the terminal arm: those were
   * never handed to anything, so they are still perfectly deliverable once
   * the sandbox comes back, and waking it for exactly them is what the start
   * arm's EXISTS is for.
   */
  if (count > 0 && (event.status === "stopped" || event.status === "failed")) {
    const strandFence = {
      conversation: { agent: { sandbox: { id: event.sandboxId, runnerId } } },
    } as const;
    const { revived, stranded } = await db.$transaction(async (tx) => {
      const revivedCount = await reviveColdTurns(tx, strandFence);
      const strandedCount = await failStrandedTurns(tx, strandFence);
      return { revived: revivedCount, stranded: strandedCount };
    });

    if (revived > 0) {
      // The revived turn needs a fresh boot NOW, not after the failed-start
      // pacing: flip the dead sandbox straight to `unprovisioned` (claimed
      // unconditionally by the start arm) and wake the held poll. Bounded —
      // a second death finds `retriedAt` set, revives nothing, and never
      // reaches this wake again.
      await db.sandbox.updateMany({
        where: {
          id: event.sandboxId,
          runnerId,
          status: { in: ["stopped", "failed"] },
        },
        data: { status: "unprovisioned" },
      });
      signalWork();
      log.info(
        { runnerId, sandboxId: event.sandboxId, count: revived },
        "revived cold-dead turns in place; waking a fresh boot",
      );
    }
    if (stranded > 0) {
      log.warn(
        { runnerId, sandboxId: event.sandboxId, count: stranded },
        "failed turns whose sandbox went down",
      );
    }
  }

  // Only what actually applied is worth reporting: an event for a sandbox
  // this runner does not own matched nothing, and logging it as a failure
  // would let one runner write alarming lines about another's sandbox.
  if (count > 0 && event.status === "failed") {
    log.warn(
      { runnerId, sandboxId: event.sandboxId, error: event.error },
      "sandbox reported failed",
    );
    await applyStartFailureReason(runnerId, event);
  }
};

/**
 * How long waiting turns ride out TRANSIENT start failures before the
 * platform stops pretending. ~5 paced attempts (`START_RETRY_SECONDS` = 30):
 * long enough that a capacity blip or a daemon restart heals invisibly,
 * short enough that nobody watches "Waking the agent…" for the whole
 * 30-minute ceiling. Measured on the same clock family as the ceiling
 * (retried → promoted → created), so a just-revived turn's patience restarts
 * with it.
 */
const START_FAILURE_PATIENCE_SECONDS = 150;

/**
 * Door 2 of the failure-UX work: a `failed` start report carrying a
 * runner-classified `reasonCode` decides what happens to the turns WAITING
 * on the start (queued + joining — never dispatched/running; the strand law
 * above owns those).
 *
 * - `image_unavailable` parks them NOW with the operator-facing copy:
 *   retrying cannot conjure software onto the host.
 * - everything else (`at_capacity`, `start_failed`, any future code) waits
 *   out the patience window first — the 30s-paced start retry keeps trying
 *   meanwhile, so a transient failure stays invisible — then parks with the
 *   honest reason instead of letting the ceiling bury the turn under a lie.
 * - no `reasonCode` (an old runner, or a stop-failure report) changes
 *   nothing: exactly today's behavior.
 *
 * Parking the turns is also what STOPS the start-retry loop: the start arm
 * claims a failed sandbox only while a queued/dispatched turn exists.
 * Event-driven on the rare failed path — the hot claim SQL never runs this.
 */
const applyStartFailureReason = async (
  runnerId: string,
  event: Extract<SandboxLifecycleEvent, { kind: "sandbox.status" }>,
): Promise<void> => {
  if (event.reasonCode === undefined) return;

  const agentFence = {
    conversation: { agent: { sandbox: { id: event.sandboxId, runnerId } } },
  } as const;

  const park = async (reason: { message: string; code: string }) => {
    const { count } = await db.turn.updateMany({
      where: {
        status: { in: ["queued", "joining"] },
        ...agentFence,
      },
      data: {
        status: "failed",
        error: reason.message,
        errorCode: reason.code,
        finishedAt: new Date(),
      },
    });
    if (count > 0) {
      log.warn(
        {
          runnerId,
          sandboxId: event.sandboxId,
          reasonCode: event.reasonCode,
          count,
        },
        "parked waiting turns after a classified start failure",
      );
    }
  };

  if (event.reasonCode === "image_unavailable") {
    await park({
      message: IMAGE_UNAVAILABLE_MESSAGE,
      code: "image_unavailable",
    });
    return;
  }

  // The patience probe: is any queued turn past the window? One indexed read
  // on the rare failed path. COALESCE(retried, promoted, created) spelled as
  // OR arms, newest clock first — the same deadline family as the ceiling.
  //
  // ONE waited-out turn condemns the whole queue, deliberately: a start
  // failure is an AGENT-level fact, and once it has demonstrably persisted a
  // full patience window, stringing the newer messages along for their own
  // 150s each would just re-teach the same lesson one sender at a time.
  // (Joining follow-ups are parked with the queue but never probed — they
  // cannot be the only waiters, because with no queued/dispatched turn the
  // start arm never claims and no failure report arrives at all; the wedge
  // sweep owns that shape.)
  const patienceBefore = new Date(
    Date.now() - START_FAILURE_PATIENCE_SECONDS * 1000,
  );
  const waitedOut = await db.turn.findFirst({
    where: {
      status: "queued",
      ...agentFence,
      OR: [
        { retriedAt: { lt: patienceBefore } },
        { retriedAt: null, promotedAt: { lt: patienceBefore } },
        {
          retriedAt: null,
          promotedAt: null,
          createdAt: { lt: patienceBefore },
        },
      ],
    },
    select: { id: true },
  });
  if (!waitedOut) return;

  await park(
    event.reasonCode === "at_capacity"
      ? { message: AT_CAPACITY_MESSAGE, code: "at_capacity" }
      : { message: AGENT_START_FAILED_MESSAGE, code: "agent_start_failed" },
  );
};

/**
 * The sandboxes this runner should be hosting — the reconcile truth — with
 * what the control plane currently believes about each. The ids are the reap
 * authority (anything labeled ours and absent is destroyed); the statuses
 * feed the vanished-pod arm (a sandbox believed `running` with no backend
 * snapshot died out-of-band and must be reported `stopped`).
 */
export const listRunnerSandboxes = async (
  runnerId: string,
): Promise<Array<{ id: string; status: string }>> => {
  return db.sandbox.findMany({
    where: { runnerId },
    select: { id: true, status: true },
  });
};

/**
 * The orphan sweep's authority (step 13): which of these ids exist NOWHERE —
 * deliberately unfenced by runner, because a stale-label orphan is by
 * definition labeled with some OTHER (usually dead) runner's id. Existence is
 * the safety property: a live sibling's Sandbox row is created before any of
 * its objects, so "missing here" genuinely means "nothing owns it".
 */
export const listMissingSandboxIds = async (
  sandboxIds: string[],
): Promise<string[]> => {
  if (sandboxIds.length === 0) return [];
  const rows = await db.sandbox.findMany({
    where: { id: { in: sandboxIds } },
    select: { id: true },
  });
  const present = new Set(rows.map((row) => row.id));
  return sandboxIds.filter((id) => !present.has(id));
};

/**
 * Mark a sandbox for (re)spawn. Used when its credentials change: the next
 * poll composes a fresh payload and the runner recreates the container —
 * declarative, so there is no bespoke "refresh env in place" path.
 *
 * Only a sandbox that is UP is respawned. A parked one (`stopped`/`failed`)
 * already picks up current truth on its next start, because the payload is
 * composed at dispatch — so marking it here would not fix anything, it would
 * merely start a container nobody asked for. Sleeping is the default (§3.9)
 * and editing a credential must not wake every agent that holds it.
 */
export const requestSandboxRespawn = async (
  agentId: string,
  workspaceId: string,
): Promise<void> => {
  // ONE transaction, because the two writes describe a single fact: this
  // container is about to be destroyed. Split, there is a window where the
  // sandbox already reads `unprovisioned` — so the runner may recreate it —
  // while a turn still reads `running` against a harness session that no
  // longer exists.
  //
  // Fenced at the QUERY, not by the caller: an id that arrived from somewhere
  // unfenced would reach across tenants, and "the callers all resolve the
  // agent first" is a property that only holds until the next caller. Both
  // existing ones already have the workspace in hand.
  const { revived, stranded } = await db.$transaction(async (tx) => {
    const { count } = await tx.sandbox.updateMany({
      where: {
        agentId,
        agent: { workspaceId },
        status: { in: ["starting", "running"] },
      },
      data: { status: "unprovisioned" },
    });
    if (count === 0) return { revived: 0, stranded: 0 };

    /**
     * The respawn destroys the container, and with it every harness session
     * behind an in-flight turn — the same fact `applyRunnerEvent` handles when
     * a sandbox goes down, reached by a different door. Same two arms as
     * there: a dispatched turn that never STARTED is revived in place (the
     * new container simply runs it — the respawn stays invisible to its
     * sender), the rest reach a terminal state so the active-turn index
     * frees their conversations.
     *
     * `queued` is excluded for the same reason as there: it was never handed
     * to anything and is perfectly deliverable once the new container is up.
     */
    const respawnFence = {
      conversation: { agent: { id: agentId, workspaceId } },
    } as const;
    const revivedCount = await reviveColdTurns(tx, respawnFence);
    const failed = await failStrandedTurns(tx, respawnFence);
    return { revived: revivedCount, stranded: failed };
  });

  if (revived > 0) {
    // The sandbox row already reads `unprovisioned` (the flip above), so the
    // revived turn only needs the held poll woken to start its fresh boot.
    signalWork();
    log.info(
      { agentId, count: revived },
      "revived cold-dead turns across a respawn",
    );
  }
  if (stranded > 0) {
    log.warn(
      { agentId, count: stranded },
      "failed turns whose sandbox is being respawned",
    );
  }
};
