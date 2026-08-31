import { canAccessWorkspaceAsUser } from "./workspace-access-check";
import {
  advanceClaimedCron,
  claimDueCrons,
  completeClaimedCron,
  type DueCron,
} from "./due-work";
import {
  CRON_FAILURE_DISABLE_THRESHOLD,
  disableCron,
  nextFireOrNull,
} from "./agent-cron-service";
import { ensureSourcedConversation } from "./conversation-service";
import { createTurn } from "./turn-service";
import { ServiceError } from "./errors";
import { db } from "@onecli/db";
import { logger } from "../lib/logger";

const log = logger.child({ component: "cron-fire" });

/**
 * Firing scheduled tasks (step 7). Driven from the runner work poll — the
 * control plane's only tick (§3.3) — right before claims, like the
 * stale-turn sweep. The CLAIM lives in due-work (the dispatch seam owns
 * dueness); this module owns what a fire *is*: an authorization pre-check,
 * then a normal turn in the cron's own conversation, created through the
 * same funnel as a human message so door-1, the sandbox wake, the work
 * signal, and the one-active-turn conflict all apply unchanged.
 *
 * Fires are sequential and capped per poll (CRON_FIRE_LIMIT in due-work):
 * a fire is two-three indexed writes, so the poll's latency budget holds,
 * and the lease means anything not reached is simply picked up again.
 */

/** The schedule's operator-named label, spliced into platform voice — so it
 * gets the standing treatment: control characters (line breaks included)
 * stripped, then clamped. */
const cleanName = (raw: string): string =>
  [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      if (code === 0x2028 || code === 0x2029) return false;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 100);

/**
 * The scheduled-run header. Platform voice around the operator's stored
 * prompt — the same shape as the channels speaker prefix: control-plane-
 * authored framing first, then the user-authored content.
 */
export const buildCronRunMessage = (name: string, prompt: string): string =>
  `[Scheduled run "${cleanName(name)}" — triggered automatically by a schedule, not by a person typing. Do the task below and finish with a SHORT report — outcome first, then only what changed or needs attention, a few lines at most; it will be delivered to the chat where this schedule was created.]\n\n${prompt}`;

const fireOne = async (cron: DueCron, lease: Date): Promise<void> => {
  // Fire-time authorization: the schedule runs under its creator's standing.
  // A creator who lost workspace access must not keep a foothold through a
  // schedule they set up while they had it — the cron disables itself with a
  // reason the dashboard shows, rather than firing broken forever.
  if (cron.createdByUserId) {
    const workspace = await db.workspace.findUnique({
      where: { id: cron.workspaceId },
      select: { id: true, organizationId: true },
    });
    const allowed = workspace
      ? await canAccessWorkspaceAsUser(cron.createdByUserId, workspace)
      : false;
    if (!allowed) {
      await disableCron(cron.id, "authorization");
      log.warn(
        { cronId: cron.id, agentId: cron.agentId },
        "cron auto-disabled: creator lost workspace access",
      );
      return;
    }
  }

  // Advance the schedule BEFORE creating the turn, and only if the lease is
  // still ours: a human edit mid-claim recomputed next_fire_at through the
  // service, and firing a prompt the user may have just replaced is worse
  // than skipping one occurrence. Computed from now, so downtime coalesces
  // into one late fire (misfire policy). NO next occurrence — a one-shot's
  // final (only) fire, or an expression that exhausted after creation —
  // retires the row on the same CAS instead: before this branch existed, the
  // throw here left the lease standing and the row was re-claimed every five
  // minutes forever, silently.
  const next = nextFireOrNull(cron.schedule, cron.timezone, new Date());
  const advanced = next
    ? await advanceClaimedCron(cron.id, lease, next)
    : await completeClaimedCron(cron.id, lease);
  if (!advanced) {
    log.info({ cronId: cron.id }, "cron edited mid-claim; skipping this fire");
    return;
  }

  // One persistent conversation per schedule (decided with the user):
  // externalRef = the cron id, so the existing unique makes this race-safe
  // and the agent resumes the same harness session run after run.
  const conversation = await ensureSourcedConversation(
    cron.workspaceId,
    cron.agentId,
    { source: "cron", externalRef: cron.id, title: cron.name },
  );

  try {
    const turn = await createTurn(
      cron.workspaceId,
      conversation.id,
      buildCronRunMessage(cron.name, cron.prompt),
      { source: "cron", userId: null },
    );
    // Door 1 can refuse at creation (no model key): the turn is born failed
    // and never reaches finishTurn, so the failure is booked HERE or nowhere.
    if (turn.status === "failed") {
      await bookCreateTimeFailure(cron.id);
    }
  } catch (error) {
    if (error instanceof ServiceError && error.code === "CONFLICT") {
      // The previous run is still going. Not a broken schedule — record the
      // skip and let the next occurrence try again.
      await db.agentCron.updateMany({
        where: { id: cron.id },
        data: { lastOutcome: "skipped_busy" },
      });
      return;
    }
    throw error;
  }
};

/** A run that failed before it ever dispatched still counts toward the
 * consecutive-failure disable — a keyless agent's schedule must not retry
 * silently forever. Same threshold the finish path applies. */
const bookCreateTimeFailure = async (cronId: string): Promise<void> => {
  const cron = await db.agentCron.findUnique({
    where: { id: cronId },
    select: { consecutiveFailures: true },
  });
  if (!cron) return;
  const failures = cron.consecutiveFailures + 1;
  await db.agentCron.update({
    where: { id: cronId },
    data: {
      lastOutcome: "failed",
      consecutiveFailures: failures,
      ...(failures >= CRON_FAILURE_DISABLE_THRESHOLD && {
        enabled: false,
        disabledReason: "failures",
      }),
    },
  });
};

/**
 * Fire everything due. Called from the runner work poll ahead of the claim
 * arms; best-effort per cron — one broken schedule must never block the
 * others or the poll itself.
 */
export const fireDueCrons = async (): Promise<number> => {
  const { lease, crons } = await claimDueCrons();
  for (const cron of crons) {
    try {
      await fireOne(cron, lease);
    } catch (err) {
      log.error({ err, cronId: cron.id }, "cron fire failed");
    }
  }
  return crons.length;
};
