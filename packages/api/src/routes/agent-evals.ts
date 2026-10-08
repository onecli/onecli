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
import { EVAL_QUESTIONS_MAX, evalQuestionSchema } from "../validations/evals";

/**
 * The agent's EVALS surface, composed onto /agents like memories and crons:
 *
 *   GET    /agents/:agentId/evals                       questions + run history
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
    const [questions, runs] = await Promise.all([
      listQuestions(workspaceId, agentId),
      listRuns(workspaceId, agentId),
    ]);
    return c.json({ questions, runs, maxQuestions: EVAL_QUESTIONS_MAX });
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
