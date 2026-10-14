import { db, type Prisma } from "@onecli/db";
import { Cron } from "croner";
import { z } from "zod";
import { ServiceError } from "./errors";
import { computeNextFire } from "./agent-cron-service";
import { requireHostedAgent } from "./agent-eval-service";
import {
  EVAL_SCHEDULE_DISABLED_REASONS,
  EVAL_SCHEDULE_OUTCOMES,
  type EvalScheduleBody,
} from "../validations/evals";

/**
 * The agent's EVAL SCHEDULE: run its test questions on a cron, so a change
 * in the agent's model, data or configuration shows up as a regression in
 * the run history without anyone pressing Run tests.
 *
 * At most one per agent (an `agent_id` unique). Expressions and timezones
 * are validated by the same croner path the agent crons use
 * (`computeNextFire`, jitter included), so a stored row is always
 * advanceable. FIRING is not here: due schedules are claimed on the runner
 * poll (`due-work.ts`) and fired by `eval-schedule-fire-service.ts`.
 *
 * Reads, deletes and run-now are fenced on the agent's workspace in the
 * query. The save upserts on the agent's unique id after the same fence
 * (`requireHostedAgent`): an agent never changes workspace, so the checked
 * agent is the written one.
 */

const scheduleSelect = {
  schedule: true,
  timezone: true,
  enabled: true,
  disabledReason: true,
  nextFireAt: true,
  lastFiredAt: true,
  lastOutcome: true,
} satisfies Prisma.AgentEvalScheduleSelect;
type ScheduleRow = Prisma.AgentEvalScheduleGetPayload<{
  select: typeof scheduleSelect;
}>;

/** Unknown stored values read as null rather than failing the screen. */
const toView = (row: ScheduleRow) => ({
  ...row,
  disabledReason: z
    .enum(EVAL_SCHEDULE_DISABLED_REASONS)
    .nullable()
    .catch(null)
    .parse(row.disabledReason),
  lastOutcome: z
    .enum(EVAL_SCHEDULE_OUTCOMES)
    .nullable()
    .catch(null)
    .parse(row.lastOutcome),
});
type EvalScheduleView = ReturnType<typeof toView>;

const fenced = (workspaceId: string, agentId: string) => ({
  agentId,
  agent: { workspaceId },
});

/**
 * The shortest gap between two scheduled runs. One run asks EVERY test
 * question (up to the cap, each a full agent turn, plus the AI judge for
 * custom checks), all on the agent's own model key: an every-minute
 * expression would re-run the whole suite back to back forever, since run
 * admission only stops overlap. Evals catch drift over hours and days.
 */
const MIN_INTERVAL_MS = 60 * 60_000;

/** Refuse an expression whose next few runs come closer than the floor.
 * Expression and zone are already validated by `computeNextFire`. */
const assertMinInterval = (schedule: string, timezone: string) => {
  const runs = new Cron(schedule, { timezone }).nextRuns(6);
  for (let i = 1; i < runs.length; i++) {
    const previous = runs[i - 1];
    const current = runs[i];
    if (
      previous &&
      current &&
      current.getTime() - previous.getTime() < MIN_INTERVAL_MS
    )
      throw new ServiceError(
        "UNPROCESSABLE",
        "Scheduled tests can run at most once an hour",
      );
  }
};

export const getEvalSchedule = async (
  workspaceId: string,
  agentId: string,
): Promise<EvalScheduleView | null> => {
  await requireHostedAgent(workspaceId, agentId);
  const row = await db.agentEvalSchedule.findFirst({
    where: fenced(workspaceId, agentId),
    select: scheduleSelect,
  });
  return row ? toView(row) : null;
};

/**
 * Create or replace the schedule. The saver becomes its creator: every
 * later run runs on their authority, re-checked at each fire. Saving
 * (re-)enables a schedule the platform turned off, and clears the reason.
 */
export const saveEvalSchedule = async (
  workspaceId: string,
  agentId: string,
  userId: string,
  input: EvalScheduleBody,
): Promise<EvalScheduleView> => {
  await requireHostedAgent(workspaceId, agentId);
  const nextFireAt = computeNextFire(
    input.schedule,
    input.timezone,
    new Date(),
  );
  assertMinInterval(input.schedule, input.timezone);
  const data = {
    schedule: input.schedule,
    timezone: input.timezone,
    enabled: input.enabled,
    disabledReason: null,
    createdByUserId: userId,
    nextFireAt,
  };
  const row = await db.agentEvalSchedule.upsert({
    where: { agentId },
    create: { agentId, ...data },
    update: data,
    select: scheduleSelect,
  });
  return toView(row);
};

export const deleteEvalSchedule = async (
  workspaceId: string,
  agentId: string,
): Promise<void> => {
  await requireHostedAgent(workspaceId, agentId);
  const { count } = await db.agentEvalSchedule.deleteMany({
    where: fenced(workspaceId, agentId),
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "No eval schedule");
};

/**
 * Fire the schedule on the next poll, through exactly the machinery a timed
 * fire uses (the agent crons' "run now" rule: no direct fire path).
 */
export const runEvalScheduleNow = async (
  workspaceId: string,
  agentId: string,
): Promise<EvalScheduleView> => {
  await requireHostedAgent(workspaceId, agentId);
  const { count } = await db.agentEvalSchedule.updateMany({
    where: { ...fenced(workspaceId, agentId), enabled: true },
    data: { nextFireAt: new Date() },
  });
  if (count === 0) {
    const exists = await db.agentEvalSchedule.findFirst({
      where: fenced(workspaceId, agentId),
      select: { id: true },
    });
    throw exists
      ? new ServiceError("UNPROCESSABLE", "The eval schedule is paused")
      : new ServiceError("NOT_FOUND", "No eval schedule");
  }
  return toView(
    await db.agentEvalSchedule.findFirstOrThrow({
      where: fenced(workspaceId, agentId),
      select: scheduleSelect,
    }),
  );
};
