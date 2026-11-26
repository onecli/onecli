import { db, type Prisma } from "@onecli/db";
import { Cron } from "croner";
import { z } from "zod";
import { ServiceError } from "./errors";
import { computeNextFire } from "./agent-cron-service";
import { requireHostedAgent } from "./agent-eval-service";
import { listMemberChannels } from "./channels/recipient-search-service";
import {
  EVAL_REPORT_WHEN,
  EVAL_SCHEDULE_DISABLED_REASONS,
  EVAL_SCHEDULE_OUTCOMES,
  type EvalReport,
  type EvalReportBody,
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
 * poll (`due-work.ts`) and fired, like Run now, by
 * `eval-schedule-fire-service.ts`.
 *
 * Reads and deletes are fenced on the agent's workspace in the query. The
 * save upserts on the agent's unique id after the same fence
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
  createdByUserId: true,
  reportTo: true,
  reportChannelRef: true,
  reportChannelLabel: true,
  reportWhen: true,
} satisfies Prisma.AgentEvalScheduleSelect;
type ScheduleRow = Prisma.AgentEvalScheduleGetPayload<{
  select: typeof scheduleSelect;
}>;

/** The stored report columns read back; an unknown or half-written row
 * reads as "not sent" rather than failing. */
export const reportOf = (
  row: Pick<
    ScheduleRow,
    "reportTo" | "reportChannelRef" | "reportChannelLabel" | "reportWhen"
  >,
): EvalReport | null => {
  const when = z.enum(EVAL_REPORT_WHEN).catch("always").parse(row.reportWhen);
  if (row.reportTo === "chat") return { to: "chat", when };
  if (row.reportTo === "channel" && row.reportChannelRef)
    return {
      to: "channel",
      channelRef: row.reportChannelRef,
      channelLabel: row.reportChannelLabel ?? row.reportChannelRef,
      when,
    };
  return null;
};

/** Unknown stored values read as null rather than failing the screen. The
 * creator's id stays server-side: the viewer learns only whether results
 * reach THEIR chat (`createdByViewer`). */
const toView = (
  {
    createdByUserId,
    reportTo,
    reportChannelRef,
    reportChannelLabel,
    reportWhen,
    ...row
  }: ScheduleRow,
  viewerUserId: string,
) => ({
  ...row,
  createdByViewer: createdByUserId === viewerUserId,
  report: reportOf({
    reportTo,
    reportChannelRef,
    reportChannelLabel,
    reportWhen,
  }),
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

/** The stored columns for a report setting. A channel must be one the
 * agent's bot is in right now: its name is recorded for display, and a
 * channel the bot cannot post in is refused here, not at the first run. */
const reportColumns = async (
  agentId: string,
  report: EvalReportBody | null,
) => {
  if (!report)
    return {
      reportTo: null,
      reportChannelRef: null,
      reportChannelLabel: null,
      reportWhen: "always",
    };
  if (report.to === "chat")
    return {
      reportTo: "chat",
      reportChannelRef: null,
      reportChannelLabel: null,
      reportWhen: report.when,
    };
  const channel = (await listMemberChannels(agentId)).find(
    (c) => c.ref === report.channelRef,
  );
  if (!channel)
    throw new ServiceError(
      "UNPROCESSABLE",
      "The agent isn't in that channel. Add it to the channel first.",
    );
  return {
    reportTo: "channel",
    reportChannelRef: channel.ref,
    reportChannelLabel: channel.name,
    reportWhen: report.when,
  };
};

/** Channels a scheduled run's results can be sent to (the bot is in them). */
export const listEvalReportChannels = async (
  workspaceId: string,
  agentId: string,
) => {
  await requireHostedAgent(workspaceId, agentId);
  return listMemberChannels(agentId);
};

export const getEvalSchedule = async (
  workspaceId: string,
  agentId: string,
  viewerUserId: string,
): Promise<EvalScheduleView | null> => {
  await requireHostedAgent(workspaceId, agentId);
  const row = await db.agentEvalSchedule.findFirst({
    where: fenced(workspaceId, agentId),
    select: scheduleSelect,
  });
  return row ? toView(row, viewerUserId) : null;
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
    // Absent keeps the stored setting (the pause switch); null clears it.
    ...(input.report !== undefined &&
      (await reportColumns(agentId, input.report))),
  };
  const row = await db.agentEvalSchedule.upsert({
    where: { agentId },
    create: { agentId, ...data },
    update: data,
    select: scheduleSelect,
  });
  return toView(row, userId);
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
