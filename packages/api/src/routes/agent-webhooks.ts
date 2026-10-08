import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { apiError } from "../middleware/error-handler";
import { ServiceError } from "../services/errors";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  receiveWebhook,
  updateWebhook,
} from "../services/agent-webhook-service";
import { ensureDirectConversation } from "../services/conversation-service";
import {
  MAX_WEBHOOK_BODY_BYTES,
  createWebhookSchema,
  updateWebhookSchema,
} from "../validations/webhooks";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * Agent webhooks (plans/agent-webhooks.md). Two surfaces:
 *
 * - `/v1/agents/:agentId/webhooks[...]` — the dashboard's CRUD, session/API
 *   key auth, workspace-fenced in the service. Created webhooks report to the
 *   creator's direct thread (the cron rule). `recordAuditEvent`, never
 *   `withAudit`: the gateway reads no webhook table, so there is no cache to
 *   flush.
 * - `/v1/hooks/:token` — the public catch URL an external app POSTs to. The
 *   token is the only credential; anything wrong reads as 404.
 */

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

const invalid = (issues: { message: string }[]) =>
  new ServiceError("UNPROCESSABLE", issues[0]?.message ?? "Invalid body");

export const agentWebhookRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/:agentId/webhooks", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    return c.json({
      webhooks: await listWebhooks(workspaceId, c.req.param("agentId")),
    });
  });

  app.post("/:agentId/webhooks", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const body = createWebhookSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) throw invalid(body.error.issues);
    const origin = await ensureDirectConversation(
      workspaceId,
      agentId,
      a.userId,
    );
    const hook = await createWebhook(workspaceId, agentId, body.data, {
      userId: a.userId,
      originConversationId: origin.id,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.WEBHOOK,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, webhookId: hook.id, name: hook.name },
    });
    return c.json(hook, 201);
  });

  app.patch("/:agentId/webhooks/:webhookId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const webhookId = c.req.param("webhookId");
    const body = updateWebhookSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) throw invalid(body.error.issues);
    const hook = await updateWebhook(
      workspaceId,
      agentId,
      webhookId,
      body.data,
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.WEBHOOK,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, webhookId, fields: Object.keys(body.data) },
    });
    return c.json(hook);
  });

  app.delete("/:agentId/webhooks/:webhookId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const webhookId = c.req.param("webhookId");
    await deleteWebhook(workspaceId, agentId, webhookId);
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.WEBHOOK,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, webhookId },
    });
    return c.body(null, 204);
  });

  return app;
};

/**
 * POST /v1/hooks/:token — the public catch URL. Every refusal is a
 * `ServiceError`, so the body is the one house error shape
 * (`{ error: { message, type } }`) the rest of /v1 answers with:
 *
 * - 202 queued · 404 unknown, malformed, or paused token (all alike)
 * - 413 body over the cap (before the service sees it)
 * - 429 that webhook's queue is full — the sender should retry later rather
 *   than have the event accepted and dropped
 */
export const webhookReceiveRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.post(
    "/:token",
    bodyLimit({
      maxSize: MAX_WEBHOOK_BODY_BYTES,
      onError: (c) => c.json(apiError("Payload too large"), 413),
    }),
    async (c) => {
      const outcome = await receiveWebhook(
        c.req.param("token"),
        await c.req.text(),
        c.req.header("content-type") ?? "",
      ).catch((error: unknown) => {
        if (error instanceof ServiceError && error.code === "CONFLICT") {
          throw new ServiceError("RATE_LIMITED", "Busy, retry later");
        }
        throw error;
      });
      if (outcome === "not_found") {
        throw new ServiceError("NOT_FOUND", "Not found");
      }
      return c.json({ accepted: true }, 202);
    },
  );
  // Any other method on a catch URL answers HERE, not in the app's generic
  // 404, whose body echoes the request path: that path IS the credential.
  app.all("/:token", () => {
    throw new ServiceError("NOT_FOUND", "Not found");
  });
  return app;
};
