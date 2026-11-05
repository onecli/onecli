import { db } from "@onecli/db";
import { getRun } from "./agent-eval-service";
import { reportOf } from "./eval-schedule-service";
import {
  evalReportSections,
  evalReportText,
  shouldSendEvalReport,
} from "./eval-report";
import { ensureDirectConversation } from "./conversation-service";
import { materializeBornDoneTurn } from "./turn-service";
import { postPlatformChannelMessage } from "./channels/send-message-service";
import { dashboardUrl } from "../lib/dashboard-url";
import { logger } from "../lib/logger";

const log = logger.child({ component: "eval-report-delivery" });

/** The header the delivered turn carries in the chat. */
export const EVAL_REPORT_HEADER = "Scheduled tests";

/**
 * Send a finished SCHEDULED eval run's results where its schedule says.
 * Called by the run worker once it settled the run itself (`done` or
 * `failed`); a run a person stopped is never sent. Manual runs are never
 * sent either: the person who pressed Run tests is watching.
 *
 * - `chat`: a finished turn in the schedule creator's direct thread with
 *   the agent (the automation delivery shape, so their linked Slack DM
 *   mirrors it too). No model turn.
 * - `channel`: a platform post into the channel (the bot must still be in
 *   it, and its Contacts setting must not be Never).
 *
 * Best-effort by contract: a report that cannot be sent is logged and
 * never touches the run, which is already recorded in Results.
 */
export const deliverEvalRunReport = async (
  workspaceId: string,
  agentId: string,
  runId: string,
): Promise<void> => {
  try {
    const schedule = await db.agentEvalSchedule.findFirst({
      where: { agentId, agent: { workspaceId } },
      select: {
        createdByUserId: true,
        reportTo: true,
        reportChannelRef: true,
        reportChannelLabel: true,
        reportWhen: true,
        agent: { select: { name: true } },
      },
    });
    const report = schedule && reportOf(schedule);
    if (!report) return;

    const run = await getRun(workspaceId, agentId, runId);
    const { status } = run;
    if (run.trigger !== "scheduled") return;
    if (status !== "done" && status !== "failed") return;
    const input = {
      agentName: schedule.agent.name,
      status,
      error: run.error,
      total: run.total,
      results: run.results,
      model: run.model,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      configChanged: run.previous
        ? run.previous.configVersion !== run.configVersion
        : null,
      runUrl: dashboardUrl(
        `/agents/${encodeURIComponent(agentId)}/evals?run=${encodeURIComponent(runId)}`,
        { workspaceId },
      ),
    };
    if (!shouldSendEvalReport(report.when, input)) return;
    if (report.to === "channel") {
      // A channel gets colored side bars: red for what needs a look,
      // green for what passed.
      const post = evalReportSections(input);
      await postPlatformChannelMessage(
        agentId,
        report.channelRef,
        post.text,
        post.sections,
      );
      return;
    }
    // The creator's own thread: the schedule runs on their authority.
    if (!schedule.createdByUserId) return;
    const thread = await ensureDirectConversation(
      workspaceId,
      agentId,
      schedule.createdByUserId,
    );
    await materializeBornDoneTurn(thread.id, {
      message: EVAL_REPORT_HEADER,
      source: "cron",
      events: [{ type: "text", text: evalReportText(input) }],
    });
  } catch (err) {
    log.warn(
      { err, agentId, runId },
      "could not send a scheduled run's results",
    );
  }
};
