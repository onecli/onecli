import { db } from "@onecli/db";
import { canAccessWorkspaceAsUser } from "./workspace-access-check";
import {
  advanceClaimedEvalSchedule,
  claimDueEvalSchedules,
  disableClaimedEvalSchedule,
  type DueEvalSchedule,
} from "./due-work";
import { nextFireOrNull } from "./agent-cron-service";
import { NoEvalQuestionsError, startRun } from "./agent-eval-service";
import { ServiceError } from "./errors";
import { logger } from "../lib/logger";
import type { EvalScheduleOutcome } from "../validations/evals";

const log = logger.child({ component: "eval-schedule-fire" });

/**
 * Firing eval schedules. Driven from the runner work poll (the control
 * plane's only tick) beside the agent crons. The claim lives in due-work;
 * this module owns what a fire is: an authorization check, then an ordinary
 * eval run through `startRun`, the same admission the Run tests button uses
 * (one run per agent, the stale-run recovery, the question snapshot).
 *
 * AUTHORIZATION: a run needs a person's authority (`createdBy`, and the
 * eval turns run as that user). The schedule runs on its creator's, checked
 * at every fire: an active membership of the agent's organization in every
 * edition, plus `canAccessWorkspaceAsUser` (the RBAC answer, the same check
 * the agent crons use). A creator who is gone, removed, suspended, or lost
 * workspace access disables the schedule with a reason the dashboard
 * shows, instead of running on nobody's authority.
 *
 * Every write that settles a claim (disable, advance) is fenced on the
 * claim's lease, so a change made while the fire is in flight (a save, a
 * delete, a run-now) always wins.
 */

const setOutcome = (scheduleId: string, lastOutcome: EvalScheduleOutcome) =>
  db.agentEvalSchedule.updateMany({
    where: { id: scheduleId },
    data: { lastOutcome },
  });

/** Whether the creator may still run tests on this agent: an ACTIVE
 * membership of the agent's organization (holds in every edition, so a
 * removed or suspended person never keeps running tests through a
 * schedule), then workspace access (the RBAC answer where RBAC is on). */
const creatorMayRun = async (
  creator: string,
  due: DueEvalSchedule,
): Promise<boolean> => {
  const member = await db.organizationMember.count({
    where: {
      organizationId: due.organizationId,
      userId: creator,
      status: "active",
    },
  });
  if (member === 0) return false;
  return canAccessWorkspaceAsUser(creator, {
    id: due.workspaceId,
    organizationId: due.organizationId,
  });
};

/** Fire one claimed schedule under `lease` (exported for the pg proofs,
 * which drive a claim and a mid-claim save in a fixed order). */
export const fireClaimedEvalSchedule = async (
  due: DueEvalSchedule,
  lease: Date,
): Promise<void> => {
  const creator = due.createdByUserId;
  if (!creator || !(await creatorMayRun(creator, due))) {
    if (await disableClaimedEvalSchedule(due.id, lease))
      log.warn(
        { scheduleId: due.id, agentId: due.agentId },
        "eval schedule disabled: its creator is gone or lost workspace access",
      );
    else log.info({ scheduleId: due.id }, "eval schedule changed mid-claim");
    return;
  }

  // Advance BEFORE starting, and only while the lease is ours: a save,
  // delete or run-now mid-claim wins and this occurrence is skipped. From
  // now, so downtime coalesces into one late run.
  const next = nextFireOrNull(due.schedule, due.timezone, new Date());
  if (!(await advanceClaimedEvalSchedule(due.id, lease, next))) {
    log.info(
      { scheduleId: due.id },
      "eval schedule changed mid-claim; skipped",
    );
    return;
  }

  try {
    await startRun(
      due.workspaceId,
      due.organizationId,
      creator,
      due.agentId,
      "scheduled",
    );
    await setOutcome(due.id, "started");
  } catch (err) {
    // Normal states, not a broken schedule, both decided inside the run
    // admission's lock: no questions yet (the schedule was set up first),
    // or a run already going (manual, or a previous fire still asking).
    // This occurrence is skipped; the next one tries again.
    if (err instanceof NoEvalQuestionsError) {
      await setOutcome(due.id, "skipped_no_questions");
      return;
    }
    if (err instanceof ServiceError && err.code === "CONFLICT") {
      await setOutcome(due.id, "skipped_busy");
      return;
    }
    await setOutcome(due.id, "failed");
    throw err;
  }
};

/** Fire every due eval schedule. Best-effort per schedule: one broken row
 * never blocks the others or the poll. */
export const fireDueEvalSchedules = async (): Promise<number> => {
  const { lease, schedules } = await claimDueEvalSchedules();
  for (const due of schedules) {
    try {
      await fireClaimedEvalSchedule(due, lease);
    } catch (err) {
      log.error({ err, scheduleId: due.id }, "eval schedule fire failed");
    }
  }
  return schedules.length;
};
