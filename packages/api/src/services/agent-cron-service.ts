import { Cron } from "croner";
import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import type { CronDisabledReason } from "../validations/crons";

/**
 * Scheduled tasks on hosted agents (plans/hosted-agents-v2.md step 7).
 *
 * The schedule lives in the control plane, never in the sandbox: this service
 * owns the rows, the two doors write through it — the dashboard routes
 * (user authority, workspace-fenced) and the schedule_task/list_tasks/
 * cancel_task platform tools (agent authority, agent-fenced by the runner's
 * two-fact identity). FIRING is not here: dueness is computed at runner-poll
 * time inside due-work.ts (the dispatch seam — §3.3, invariant 15).
 *
 * Validation is BY CONSTRUCTION: the same croner object that will later
 * compute occurrences is what accepts or rejects the expression, so a row
 * that exists is always advanceable — there is no "parses here, fails there"
 * gap for a schedule to hide in. Timezones are validated through Intl
 * upfront because croner only surfaces a bad zone lazily, at nextRun time.
 */

const cronSelect = {
  id: true,
  agentId: true,
  name: true,
  prompt: true,
  schedule: true,
  timezone: true,
  enabled: true,
  disabledReason: true,
  nextFireAt: true,
  lastFiredAt: true,
  lastOutcome: true,
  consecutiveFailures: true,
  createdAt: true,
} as const;

export type AgentCronView = {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  disabledReason: string | null;
  nextFireAt: Date;
  lastFiredAt: Date | null;
  lastOutcome: string | null;
  consecutiveFailures: number;
  createdAt: Date;
};

export interface CronInput {
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
}

/** Consecutive failed runs before a schedule turns itself off. */
export const CRON_FAILURE_DISABLE_THRESHOLD = 5;

/**
 * Schedules one agent may hold. An availability bound, not a product limit:
 * `schedule_task` is agent-callable, and the per-poll fire budget is global —
 * without a cap, one runaway agent accumulating schedules could crowd
 * co-tenants out of the fire window (security review, step 7).
 */
export const MAX_CRONS_PER_AGENT = 20;

const assertValidTimezone = (timezone: string): void => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Unknown timezone "${timezone}". Use an IANA zone name like "America/Los_Angeles"`,
    );
  }
};

const cronOf = (schedule: string, timezone: string): Cron => {
  try {
    return new Cron(schedule, { timezone });
  } catch (error) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Invalid schedule expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Ceiling on the per-occurrence wake-storm jitter. Late-only 0..300s is the
 * deliberate reading of the plan's "±5 min" (plans/sandbox-platform.md step
 * 4): a schedule may fire late, never early — "daily at 9:00" firing at 8:57
 * would surprise the person who wrote it.
 */
export const CRON_JITTER_MAX_SECONDS = 300;

/**
 * The next occurrence strictly after `from`, in the schedule's own zone.
 * Computed from NOW at fire time, deliberately — downtime coalesces into one
 * late fire instead of a backlog (misfire policy, decided in the plan).
 *
 * A late-only JITTER rides every computed occurrence (step 4's wake-storm
 * spreading): identical schedules across the fleet — the "daily 9:00 report"
 * cohort — must not wake their sandboxes in one thundering herd. The offset
 * is capped at half the gap to the FOLLOWING occurrence, never a flat 300s:
 * an every-minute schedule jittered past its next slot would silently skip
 * occurrences on the healthy path, which only downtime is allowed to do.
 * Everything downstream (`advanceClaimedCron`'s CAS, the dashboard's
 * nextFireAt, `list_tasks`) sees the jittered time — displayed fire times
 * are the real fire times.
 */
export const computeNextFire = (
  schedule: string,
  timezone: string,
  from: Date,
  random: () => number = Math.random,
): Date => {
  assertValidTimezone(timezone);
  const cron = cronOf(schedule, timezone);
  const next = cron.nextRun(from);
  if (!next) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This schedule never fires. Check the expression",
    );
  }
  // The following occurrence bounds the jitter; a schedule with no further
  // occurrence (a one-shot) takes the full ceiling.
  const following = cron.nextRun(next);
  const gapMs = following ? following.getTime() - next.getTime() : Infinity;
  const ceilingMs = Math.min(
    CRON_JITTER_MAX_SECONDS * 1000,
    Math.floor(gapMs / 2),
  );
  const jitterMs = ceilingMs > 0 ? Math.floor(random() * ceilingMs) : 0;
  return new Date(next.getTime() + jitterMs);
};

/** The agent fence both doors share — workspace-scoped, hosted-only. */
const requireHostedAgent = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, kind: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Only hosted agents can hold schedules",
    );
  }
  return agent;
};

export interface CronOrigin {
  /** The conversation reports are delivered to (where the schedule was born). */
  originConversationId: string | null;
  /** Fire-time authorization anchor — the human whose access the schedule
   * runs under; null when the creator could not be resolved. */
  createdByUserId: string | null;
}

export const createCron = async (
  workspaceId: string,
  agentId: string,
  input: CronInput,
  origin: CronOrigin,
): Promise<AgentCronView> => {
  await requireHostedAgent(workspaceId, agentId);
  const held = await db.agentCron.count({ where: { agentId } });
  if (held >= MAX_CRONS_PER_AGENT) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `This agent already has ${MAX_CRONS_PER_AGENT} schedules. Cancel one first`,
    );
  }
  const nextFireAt = computeNextFire(
    input.schedule,
    input.timezone,
    new Date(),
  );
  return db.agentCron.create({
    data: {
      agentId,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      timezone: input.timezone,
      nextFireAt,
      originConversationId: origin.originConversationId,
      createdByUserId: origin.createdByUserId,
    },
    select: cronSelect,
  });
};

export const listCrons = async (
  workspaceId: string,
  agentId: string,
): Promise<AgentCronView[]> => {
  await requireHostedAgent(workspaceId, agentId);
  return db.agentCron.findMany({
    where: { agentId },
    orderBy: { createdAt: "asc" },
    select: cronSelect,
  });
};

export interface CronUpdate {
  name?: string;
  prompt?: string;
  schedule?: string;
  timezone?: string;
  enabled?: boolean;
}

export const updateCron = async (
  workspaceId: string,
  agentId: string,
  cronId: string,
  update: CronUpdate,
): Promise<AgentCronView> => {
  await requireHostedAgent(workspaceId, agentId);
  // Fenced read first: existence is decided by the (agentId) pair so a
  // foreign cron id reads as NOT_FOUND, never as a hint.
  const existing = await db.agentCron.findFirst({
    where: { id: cronId, agentId },
    select: { schedule: true, timezone: true, enabled: true },
  });
  if (!existing) throw new ServiceError("NOT_FOUND", "Schedule not found");

  const schedule = update.schedule ?? existing.schedule;
  const timezone = update.timezone ?? existing.timezone;
  const scheduleChanged =
    schedule !== existing.schedule || timezone !== existing.timezone;
  // Re-enabling is a human decision that supersedes an auto-disable: the
  // reason clears and the failure counter restarts, otherwise one stale
  // failure from last week would re-disable a just-fixed schedule.
  const reEnabled = update.enabled === true && !existing.enabled;

  return db.agentCron.update({
    where: { id: cronId },
    data: {
      ...(update.name !== undefined && { name: update.name }),
      ...(update.prompt !== undefined && { prompt: update.prompt }),
      ...(update.schedule !== undefined && { schedule: update.schedule }),
      ...(update.timezone !== undefined && { timezone: update.timezone }),
      ...(update.enabled !== undefined && { enabled: update.enabled }),
      ...((scheduleChanged || reEnabled) && {
        nextFireAt: computeNextFire(schedule, timezone, new Date()),
      }),
      ...(reEnabled && { disabledReason: null, consecutiveFailures: 0 }),
    },
    select: cronSelect,
  });
};

export const deleteCron = async (
  workspaceId: string,
  agentId: string,
  cronId: string,
): Promise<void> => {
  await requireHostedAgent(workspaceId, agentId);
  const { count } = await db.agentCron.deleteMany({
    where: { id: cronId, agentId },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Schedule not found");
};

/**
 * "Run now" — the dashboard's force-fire and the live-verify lever. Pulling
 * `nextFireAt` to now lets the normal poll claim it within a second; there is
 * deliberately NO direct fire path, so a forced run exercises exactly the
 * machinery a scheduled one does.
 */
export const runCronNow = async (
  workspaceId: string,
  agentId: string,
  cronId: string,
): Promise<AgentCronView> => {
  await requireHostedAgent(workspaceId, agentId);
  const { count } = await db.agentCron.updateMany({
    where: { id: cronId, agentId, enabled: true },
    data: { nextFireAt: new Date() },
  });
  if (count === 0) {
    // Fenced read to say WHICH refusal honestly (absent vs paused).
    const exists = await db.agentCron.findFirst({
      where: { id: cronId, agentId },
      select: { id: true },
    });
    if (!exists) throw new ServiceError("NOT_FOUND", "Schedule not found");
    throw new ServiceError("UNPROCESSABLE", "This schedule is paused");
  }
  const cron = await db.agentCron.findFirstOrThrow({
    where: { id: cronId, agentId },
    select: cronSelect,
  });
  return cron;
};

/** Auto-disable — the fire path's arm (due-work), never a user surface. */
export const disableCron = async (
  cronId: string,
  reason: CronDisabledReason,
): Promise<void> => {
  await db.agentCron.update({
    where: { id: cronId },
    data: { enabled: false, disabledReason: reason },
  });
};
