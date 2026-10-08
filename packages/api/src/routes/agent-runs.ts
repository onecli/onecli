import { Hono, type Context } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import { getRun, listRuns } from "../services/agent-runs-service";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";
import { runsQuerySchema } from "../validations/runs";

/**
 * The RUNS surface (audit): the whole workspace's at /v1/runs (Activity), one
 * agent's at /v1/agents/:agentId/runs[/:turnId] (composed onto /agents like
 * memories and crons).
 *
 * Lists never carry a colleague's private content, so listing (and polling a
 * list) is never an audited read. Opening a colleague's private run is: the
 * detail route records it before releasing anything.
 */

const listPage = async (c: Context<ApiEnv>, agentId: string | null) => {
  const a = c.get("auth");
  const workspaceId = requireWorkspaceId(a);
  const query = runsQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      query.error.issues[0]?.message ?? "Invalid query",
    );
  }
  return c.json(
    await listRuns(
      workspaceId,
      a.organizationId,
      a.userId,
      agentId,
      query.data,
    ),
  );
};

/** The workspace's runs across agents, for Activity: GET /v1/runs. */
export const workspaceRunRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);
  app.get("/", (c) => listPage(c, null));
  return app;
};

export const agentRunRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/:agentId/runs", (c) => listPage(c, c.req.param("agentId")));

  app.get("/:agentId/runs/:turnId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const turnId = c.req.param("turnId");
    const { run, viewedOthersDirect } = await getRun(
      workspaceId,
      a.organizationId,
      a.userId,
      agentId,
      turnId,
    );
    // Opening a colleague's private run is the one audited read. It is a
    // condition of access: if the record cannot be written, nothing is
    // released. IDs only, never the question.
    if (viewedOthersDirect) {
      await recordAuditEvent(
        {
          workspaceId,
          userId: a.userId,
          userEmail: a.userEmail,
          action: AUDIT_ACTIONS.VIEW,
          service: AUDIT_SERVICES.CONVERSATION,
          source: AUDIT_SOURCE.API,
          metadata: {
            agentId,
            surface: "runs.detail",
            turnId,
            conversationId: run.conversationId,
          },
        },
        { failClosed: true },
      );
    }
    return c.json({ run });
  });

  return app;
};
