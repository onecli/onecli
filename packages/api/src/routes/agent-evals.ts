import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  archiveQuestion,
  getRun,
  listQuestions,
  listRuns,
  saveQuestion,
  startRun,
} from "../services/agent-eval-service";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";
import {
  EVAL_QUESTIONS_MAX,
  evalQuestionSchema,
  evalScheduleSchema,
} from "../validations/evals";
import {
  deleteEvalSchedule,
  getEvalSchedule,
  runEvalScheduleNow,
  saveEvalSchedule,
} from "../services/eval-schedule-service";

/**
 * The agent's EVALS surface, composed onto /agents like memories and crons:
 *
 *   GET    /agents/:agentId/evals                       questions + run history + schedule
 *   PUT    /agents/:agentId/evals/schedule              create or replace the schedule
 *   DELETE /agents/:agentId/evals/schedule              remove the schedule
 *   POST   /agents/:agentId/evals/schedule/run          fire the schedule now (202)
 *   POST   /agents/:agentId/evals/questions             add a question
 *   PUT    /agents/:agentId/evals/questions/:questionId edit an active question
 *   DELETE /agents/:agentId/evals/questions/:questionId archive a question
 *   POST   /agents/:agentId/evals/runs                  start a run (202)
 *   GET    /agents/:agentId/evals/runs/:runId           one run in full
 *
 * `recordAuditEvent`, never `withAudit`: the gateway reads no eval table, so
 * a cache flush would be noise (the cron-surface rule).
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

const parseQuestion = async (raw: Request) => {
  const body = evalQuestionSchema.safeParse(await parseBody(raw));
  if (!body.success)
    throw new ServiceError(
      "UNPROCESSABLE",
      body.error.issues[0]?.message ?? "Invalid test question",
    );
  return body.data;
};

export const agentEvalRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/:agentId/evals", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const agentId = c.req.param("agentId");
    const [questions, runs, schedule] = await Promise.all([
      listQuestions(workspaceId, agentId),
      listRuns(workspaceId, agentId),
      getEvalSchedule(workspaceId, agentId),
    ]);
    return c.json({
      questions,
      runs,
      schedule,
      maxQuestions: EVAL_QUESTIONS_MAX,
    });
  });

  // The eval schedule: one per agent, so a singular sub-resource.
  app.put("/:agentId/evals/schedule", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const body = evalScheduleSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success)
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid eval schedule",
      );
    const schedule = await saveEvalSchedule(
      workspaceId,
      agentId,
      a.userId,
      body.data,
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.EVAL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId,
        schedule: body.data.schedule,
        timezone: body.data.timezone,
        enabled: body.data.enabled,
      },
    });
    return c.json(schedule);
  });

  app.delete("/:agentId/evals/schedule", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    await deleteEvalSchedule(workspaceId, agentId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.EVAL,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, schedule: null },
    });
    return c.body(null, 204);
  });

  // Fire on the next poll, through the same path a timed fire takes.
  app.post("/:agentId/evals/schedule/run", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const schedule = await runEvalScheduleNow(workspaceId, agentId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.RUN,
      service: AUDIT_SERVICES.EVAL,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, via: "schedule" },
    });
    return c.json(schedule, 202);
  });

  app.post("/:agentId/evals/questions", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const question = await saveQuestion(
      workspaceId,
      agentId,
      null,
      await parseQuestion(c.req.raw),
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.EVAL,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, questionId: question.id },
    });
    return c.json(question, 201);
  });

  app.put("/:agentId/evals/questions/:questionId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const questionId = c.req.param("questionId");
    const question = await saveQuestion(
      workspaceId,
      agentId,
      questionId,
      await parseQuestion(c.req.raw),
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.EVAL,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, questionId },
    });
    return c.json(question);
  });

  app.delete("/:agentId/evals/questions/:questionId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const questionId = c.req.param("questionId");
    await archiveQuestion(workspaceId, agentId, questionId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.EVAL,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, questionId },
    });
    return c.body(null, 204);
  });

  app.post("/:agentId/evals/runs", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const run = await startRun(
      workspaceId,
      a.organizationId,
      a.userId,
      agentId,
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.RUN,
      service: AUDIT_SERVICES.EVAL,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, runId: run.id, questions: run.total },
    });
    return c.json(run, 202);
  });

  app.get("/:agentId/evals/runs/:runId", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    return c.json(
      await getRun(workspaceId, c.req.param("agentId"), c.req.param("runId")),
    );
  });

  return app;
};
