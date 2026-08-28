import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  createCron,
  deleteCron,
  listCrons,
  runCronNow,
  updateCron,
} from "../services/agent-cron-service";
import { ensureDirectConversation } from "../services/conversation-service";
import { createCronSchema, updateCronSchema } from "../validations/crons";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * The agent's schedule surface: /v1/agents/:agentId/crons[...] — composed
 * onto the /agents base path like the channels router (mounted before the
 * 410 shims; every path here is two-plus segments, so the agents router's
 * `/:agentId` single-segment routes never shadow it).
 *
 * A dashboard-created schedule anchors its delivery to the CREATOR's direct
 * thread (decided with the user, 2026-08-07: reports go where the schedule
 * was born) — so create resolves that thread first, the same get-or-create
 * the chat door uses.
 *
 * `recordAuditEvent`, never `withAudit`: the gateway reads no cron table, so
 * a cache flush would be pure noise. Same reason there is no
 * invalidateGatewayCache anywhere on this surface.
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

export const agentCronRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents/:agentId/crons — the whole section's payload.
  app.get("/:agentId/crons", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    return c.json({
      crons: await listCrons(workspaceId, c.req.param("agentId")),
    });
  });

  // POST /agents/:agentId/crons — create; origin = the creator's thread.
  app.post("/:agentId/crons", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const body = createCronSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const origin = await ensureDirectConversation(
      workspaceId,
      agentId,
      a.userId,
    );
    const cron = await createCron(workspaceId, agentId, body.data, {
      originConversationId: origin.id,
      createdByUserId: a.userId,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.CRON,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, cronId: cron.id, name: cron.name },
    });
    return c.json(cron, 201);
  });

  // PATCH /agents/:agentId/crons/:cronId — edit / pause / resume.
  app.patch("/:agentId/crons/:cronId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const cronId = c.req.param("cronId");
    const body = updateCronSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const cron = await updateCron(workspaceId, agentId, cronId, body.data);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CRON,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, cronId, fields: Object.keys(body.data) },
    });
    return c.json(cron);
  });

  // POST /agents/:agentId/crons/:cronId/run — force-fire by pulling
  // nextFireAt to now; the normal poll does the rest, so a forced run
  // exercises exactly the machinery a scheduled one does.
  app.post("/:agentId/crons/:cronId/run", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const cronId = c.req.param("cronId");
    const cron = await runCronNow(workspaceId, agentId, cronId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CRON,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, cronId, forced: true },
    });
    return c.json(cron);
  });

  // DELETE /agents/:agentId/crons/:cronId
  app.delete("/:agentId/crons/:cronId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const cronId = c.req.param("cronId");
    await deleteCron(workspaceId, agentId, cronId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.CRON,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, cronId },
    });
    return c.body(null, 204);
  });

  return app;
};
