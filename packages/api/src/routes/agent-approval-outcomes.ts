import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import { listApprovalOutcomes } from "../services/approval-outcome-service";
import { MAX_OUTCOME_IDS } from "../validations/approval-outcomes";

/**
 * GET /v1/agents/:agentId/approval-outcomes?ids=a,b — how the agent's gateway
 * approvals ended (approved / denied / replaced, where, by whom, when). The
 * web chat asks about the cards it saw leave the pending set. A read: never
 * audited. Composed onto /agents like runs and memories.
 */

const query = z.object({
  ids: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(MAX_OUTCOME_IDS)),
});

export const agentApprovalOutcomeRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/:agentId/approval-outcomes", async (c) => {
    const a = c.get("auth");
    const parsed = query.safeParse(c.req.query());
    if (!parsed.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        parsed.error.issues[0]?.message ?? "Invalid query",
      );
    }
    const outcomes = await listApprovalOutcomes({
      workspaceId: requireWorkspaceId(a),
      organizationId: a.organizationId,
      agentId: c.req.param("agentId"),
      approvalIds: parsed.data.ids,
    });
    return c.json({ outcomes });
  });

  return app;
};
