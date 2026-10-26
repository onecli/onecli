import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../../types";
import { authMiddleware, requireWorkspaceId } from "../../middleware/auth";
import { requireEnterprise } from "../middleware/enterprise-gate";
import { ServiceError } from "../../services/errors";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../../services/audit-service";
import { enablePresenceUserReadAccess } from "../../services/channels/agent-channel-service";
import { oauthCallbackUrl } from "../../services/channels/posture";
import {
  deleteGrant,
  disconnect,
  getMyConnection,
  listGrants,
  listMyConversations,
  listSlackReadAgents,
  MAX_BULK_SHARE,
  READ_AUDIENCES,
  shareConversations,
  startConnect,
  upsertGrant,
} from "./service";

/**
 * "Connect your Slack" read grants - /v1/agents/:agentId/slack-read/*
 * (licensed: granular_access; the whole router is dark without it).
 *
 *   GET    /connection           the caller's own connection state
 *   POST   /connection           start the consent flow → { authorizeUrl }
 *   DELETE /connection           disconnect the caller (and their grants)
 *   GET    /conversations        the caller's own conversations (picker)
 *   GET    /grants               every grant on the agent, with granter
 *   POST   /grants               share many of the caller's own at once
 *   PUT    /grants/:externalRef  grant/re-scope one of the caller's own
 *   DELETE /grants/:grantId      remove one grant
 *
 * Every operation acts as the authenticated person on their own token:
 * there is no way to connect, list, or grant on someone else's behalf.
 */

const setGrantSchema = z.object({ audience: z.enum(READ_AUDIENCES) }).strict();

const REF = /^[A-Z0-9]{2,32}$/;

const shareManySchema = z
  .object({
    externalRefs: z
      .array(z.string().regex(REF, "Invalid conversation reference"))
      .min(1)
      .max(MAX_BULK_SHARE),
    audience: z.enum(READ_AUDIENCES),
  })
  .strict();

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

export const slackReadRoutes = () => {
  const app = new Hono<ApiEnv>();
  // Scoped to THIS router's paths: it is composed onto the shared /agents
  // base, so a "*" middleware would gate every /v1/agents/:id/* request
  // (turning an unknown path's 404 into a license 403).
  const own = "/:agentId/slack-read/*";
  app.use(own, requireEnterprise("granular_access"));
  app.use(own, authMiddleware);

  app.get("/:agentId/slack-read/connection", async (c) => {
    const a = c.get("auth");
    return c.json(
      await getMyConnection({
        workspaceId: requireWorkspaceId(a),
        agentId: c.req.param("agentId"),
        userId: a.userId,
      }),
    );
  });

  app.post("/:agentId/slack-read/connection", async (c) => {
    const a = c.get("auth");
    const redirectUri = oauthCallbackUrl("slack");
    if (!redirectUri) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "This deployment has no public URL, so Slack can't send you back after you approve.",
      );
    }
    const { authorizeUrl } = await startConnect({
      workspaceId: requireWorkspaceId(a),
      agentId: c.req.param("agentId"),
      userId: a.userId,
      redirectUri,
      ensureManifest: ({ externalId, organizationId }) =>
        enablePresenceUserReadAccess({
          provider: "slack",
          organizationId,
          externalId,
          redirectUrl: redirectUri,
        }),
    });
    return c.json({ authorizeUrl });
  });

  app.delete("/:agentId/slack-read/connection", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const removed = await disconnect({
      workspaceId,
      agentId: c.req.param("agentId"),
      userId: a.userId,
    });
    if (!removed) {
      throw new ServiceError("NOT_FOUND", "Your Slack isn't connected.");
    }
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        slackReadConnection: "disconnected",
      },
    });
    return c.body(null, 204);
  });

  app.get("/:agentId/slack-read/conversations", async (c) => {
    const a = c.get("auth");
    const conversations = await listMyConversations({
      workspaceId: requireWorkspaceId(a),
      agentId: c.req.param("agentId"),
      userId: a.userId,
    });
    return c.json({ conversations });
  });

  app.get("/:agentId/slack-read/grants", async (c) => {
    const a = c.get("auth");
    const grants = await listGrants({
      workspaceId: requireWorkspaceId(a),
      agentId: c.req.param("agentId"),
      userId: a.userId,
    });
    return c.json({ grants });
  });

  app.post("/:agentId/slack-read/grants", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const agentId = c.req.param("agentId");
    const body = shareManySchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const grants = await shareConversations({
      workspaceId,
      agentId,
      userId: a.userId,
      externalRefs: body.data.externalRefs,
      audience: body.data.audience,
    });
    // One audit row per grant: each is its own access, removable on its own.
    for (const grant of grants) {
      await recordAuditEvent({
        workspaceId,
        userId: a.userId,
        userEmail: a.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.CHANNEL,
        source: AUDIT_SOURCE.API,
        metadata: {
          agentId,
          readGrantId: grant.id,
          conversationRef: grant.externalRef,
          conversationKind: grant.subjectKind,
          readAudience: grant.audience,
          bulk: true,
        },
      });
    }
    return c.json({ grants }, 201);
  });

  app.put("/:agentId/slack-read/grants/:externalRef", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const externalRef = c.req.param("externalRef");
    if (!REF.test(externalRef)) {
      throw new ServiceError("UNPROCESSABLE", "Invalid conversation reference");
    }
    const body = setGrantSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const grant = await upsertGrant({
      workspaceId,
      agentId: c.req.param("agentId"),
      userId: a.userId,
      externalRef,
      audience: body.data.audience,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        readGrantId: grant.id,
        conversationRef: externalRef,
        conversationKind: grant.subjectKind,
        readAudience: grant.audience,
      },
    });
    return c.json(grant);
  });

  app.delete("/:agentId/slack-read/grants/:grantId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const removed = await deleteGrant({
      workspaceId,
      agentId: c.req.param("agentId"),
      grantId: c.req.param("grantId"),
    });
    if (!removed) {
      throw new ServiceError("NOT_FOUND", "This read access no longer exists.");
    }
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        readGrantId: removed.id,
        conversationRef: removed.externalRef,
      },
    });
    return c.body(null, 204);
  });

  return app;
};

/**
 * The workspace-level door - `/v1/slack-read/*` (licensed: granular_access).
 *
 *   GET /agents   the workspace's agents with a Slack app, each with the
 *                 CALLER's own standing (connected? how many shared?)
 *
 * A finder only: connecting and sharing stay per agent, on its Slack page.
 */
export const slackReadOverviewRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("granular_access"));
  app.use("*", authMiddleware);
  app.get("/agents", async (c) => {
    const a = c.get("auth");
    const agents = await listSlackReadAgents({
      workspaceId: requireWorkspaceId(a),
      organizationId: a.organizationId,
      userId: a.userId,
    });
    return c.json({ agents });
  });
  return app;
};
