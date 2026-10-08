import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  getRun,
  listRuns,
  RUNS_PAGE_MAX,
} from "../services/agent-runs-service";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * The agent's RUNS surface (audit): /v1/agents/:agentId/runs[/:turnId].
 * Composed onto /agents like memories and crons.
 */

const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_PAGE_MAX).optional(),
  // Cursor syntax (`<createdAt ISO>~<turn id>`) is validated in the service.
  before: z.string().min(1).max(200).optional(),
  source: z.string().min(1).max(40).optional(),
  userId: z.string().min(1).max(100).optional(),
  app: z.string().min(1).max(100).optional(),
  failed: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export const agentRunRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/:agentId/runs", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const q = runsQuerySchema.safeParse(c.req.query());
    if (!q.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        q.error.issues[0]?.message ?? "Invalid query",
      );
    }
    const { failed, ...rest } = q.data;
    const agentId = c.req.param("agentId");
    const { viewedOthersDirect, ...result } = await listRuns(
      workspaceId,
      a.organizationId,
      a.userId,
      agentId,
      {
        ...rest,
        failedOnly: failed,
      },
    );
    // A clipped question/answer is still a private-content read. Only IDs
    // belong in its audit record, never the preview or filter text.
    if (viewedOthersDirect.length) {
      // Unlike mutation audits, this is a condition of private read access.
      // If persistence fails, do not release the colleague's preview.
      await recordAuditEvent(
        {
          workspaceId,
          userId: a.userId,
          userEmail: a.userEmail,
          action: AUDIT_ACTIONS.VIEW,
          service: AUDIT_SERVICES.CONVERSATION,
          source: AUDIT_SOURCE.API,
          metadata: { agentId, surface: "runs.list", runs: viewedOthersDirect },
        },
        { failClosed: true },
      );
    }
    return c.json(result);
  });

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
    // Detail and list previews both audit reads of another owner's thread.
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
