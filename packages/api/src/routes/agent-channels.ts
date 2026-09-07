import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  completePresence,
  createPresence,
  detachPresence,
  getAgentChannels,
  getSetupMaterial,
} from "../services/channels/agent-channel-service";
import { isChannelProviderId } from "../services/channels/registry";
import {
  dismissReachRow,
  setPersonReachState,
  setSpaceReachState,
} from "../services/channels/agent-reach-service";
import type { ChannelProviderId } from "../services/channels/types";
import {
  attachPresenceSchema,
  channelTransportSchema,
  completePresenceSchema,
  detachPresenceSchema,
  setPersonReachStateSchema,
  setReachStateSchema,
} from "../validations/channels";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * The agent's channel surface: /v1/agents/:agentId/channels[/:provider/...] —
 * composed onto the /agents base path (mounted before the 410 shims; every
 * path here is two-plus segments, so the agents router's `/:agentId`
 * single-segment routes never shadow it).
 *
 * `recordAuditEvent`, never `withAudit`: the gateway reads none of these
 * tables (its approvals key is matched by raw string, not cached config).
 */

const parseProvider = (raw: string): ChannelProviderId => {
  if (!isChannelProviderId(raw)) {
    throw new ServiceError("NOT_FOUND", "Unknown channel provider");
  }
  return raw;
};

const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

export const agentChannelRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents/:agentId/channels — presences + posture + org-integration
  // availability + adapter liveness: the one payload the section renders.
  app.get("/:agentId/channels", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    return c.json(
      await getAgentChannels(workspaceId, c.req.param("agentId"), auth.userId),
    );
  });

  // GET /agents/:agentId/channels/:provider/manifest — the paste floor's
  // step 0 (Slack: the app manifest for the chosen transport, else the
  // current posture).
  app.get("/:agentId/channels/:provider/manifest", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const provider = parseProvider(c.req.param("provider"));
    const transport = channelTransportSchema
      .optional()
      .safeParse(c.req.query("transport"));
    if (!transport.success) {
      // Zod's own message names the accepted values ('events' | 'socket') —
      // the same vocabulary the body parsers surface.
      throw new ServiceError(
        "UNPROCESSABLE",
        transport.error.issues[0]?.message ?? "Unknown transport",
      );
    }
    return c.json(
      await getSetupMaterial(
        workspaceId,
        c.req.param("agentId"),
        provider,
        transport.data,
      ),
    );
  });

  // POST /agents/:agentId/channels/:provider — the guided arm: create the
  // provider app from the org credential. Returns what the dialog drives:
  // the install URL (events) or the settings deep-link (socket).
  app.post("/:agentId/channels/:provider", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const provider = parseProvider(c.req.param("provider"));
    const body = attachPresenceSchema.safeParse(
      (await parseBody(c.req.raw)) ?? {},
    );
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const result = await createPresence(
      workspaceId,
      c.req.param("agentId"),
      provider,
      a.userId,
      body.data.transport,
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        provider,
        agentId: c.req.param("agentId"),
        presenceId: result.presenceId,
        transport: result.transport,
      },
    });
    return c.json(result, 201);
  });

  // POST /agents/:agentId/channels/:provider/complete — the pasted-tokens
  // completion door (socket arm + the whole paste floor).
  app.post("/:agentId/channels/:provider/complete", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const provider = parseProvider(c.req.param("provider"));
    const body = completePresenceSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const presence = await completePresence(
      workspaceId,
      c.req.param("agentId"),
      provider,
      body.data,
      a.userId,
    );
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        provider,
        agentId: c.req.param("agentId"),
        presenceId: presence.id,
        transport: presence.transport,
        completed: true,
      },
    });
    return c.json(presence);
  });

  // DELETE /agents/:agentId/channels/:provider — detach. Conversations stay;
  // the presence, its links, its tokens, and its service key go.
  app.delete("/:agentId/channels/:provider", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const provider = parseProvider(c.req.param("provider"));
    const body = detachPresenceSchema.safeParse(
      (await parseBody(c.req.raw)) ?? {},
    );
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    await detachPresence(workspaceId, c.req.param("agentId"), provider, {
      deleteRemote: body.data.deleteRemote ?? false,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        provider,
        agentId: c.req.param("agentId"),
        deleteRemote: body.data.deleteRemote ?? false,
      },
    });
    return c.body(null, 204);
  });

  // PUT /agents/:agentId/channels/:provider/reach/:externalRef — the
  // dashboard's per-space reach toggle: approve opens the channel to
  // everyone in it (same provider tenant), revoke returns it to members
  // only. Idempotent upsert-and-set; the service audits with the decider.
  // The caller's workspace access IS the decide authority (the same gate
  // the card click's clicker resolution enforces).
  app.put("/:agentId/channels/:provider/reach/:externalRef", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const provider = parseProvider(c.req.param("provider"));
    // Provider-opaque but bounded: it becomes a DB row's key (Slack channel
    // ids are ~11 chars; 200 matches the wire schema's cap).
    const externalRef = c.req.param("externalRef");
    if (externalRef.length === 0 || externalRef.length > 200) {
      throw new ServiceError("UNPROCESSABLE", "Invalid channel reference");
    }
    const body = setReachStateSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const result = await setSpaceReachState({
      workspaceId,
      agentId: c.req.param("agentId"),
      provider,
      externalRef,
      state: body.data.state,
      deciderUserId: a.userId,
    });
    if (result.kind === "refused") {
      throw new ServiceError("NOT_FOUND", result.message);
    }
    return c.json(result);
  });

  // PUT /agents/:agentId/channels/:provider/reach/people/:externalRef — the
  // per-PERSON settlement. A separate path segment rather than a body field
  // so the two subject kinds can never collide on one key: a channel id and
  // a user id are both provider-opaque strings, and routing them through
  // one route would make the kind a guess.
  app.put(
    "/:agentId/channels/:provider/reach/people/:externalRef",
    async (c) => {
      const a = c.get("auth");
      const workspaceId = requireWorkspaceId(a);
      const provider = parseProvider(c.req.param("provider"));
      const externalRef = c.req.param("externalRef");
      if (externalRef.length === 0 || externalRef.length > 200) {
        throw new ServiceError("UNPROCESSABLE", "Invalid person reference");
      }
      const body = setPersonReachStateSchema.safeParse(
        await parseBody(c.req.raw),
      );
      if (!body.success) {
        throw new ServiceError(
          "UNPROCESSABLE",
          body.error.issues[0]?.message ?? "Invalid body",
        );
      }
      const result = await setPersonReachState({
        workspaceId,
        agentId: c.req.param("agentId"),
        provider,
        externalRef,
        state: body.data.state,
        deciderUserId: a.userId,
      });
      if (result.kind === "refused") {
        throw new ServiceError("NOT_FOUND", result.message);
      }
      return c.json(result);
    },
  );

  // DELETE /agents/:agentId/channels/:provider/reach/people/:externalRef —
  // DISMISS one person: delete the grant row only. Never touches thread
  // links (those belong to whoever the DM is with). The next message from
  // them re-knocks fresh.
  app.delete(
    "/:agentId/channels/:provider/reach/people/:externalRef",
    async (c) => {
      const a = c.get("auth");
      const workspaceId = requireWorkspaceId(a);
      const provider = parseProvider(c.req.param("provider"));
      const externalRef = c.req.param("externalRef");
      if (externalRef.length === 0 || externalRef.length > 200) {
        throw new ServiceError("UNPROCESSABLE", "Invalid person reference");
      }
      const result = await dismissReachRow({
        workspaceId,
        agentId: c.req.param("agentId"),
        provider,
        subjectKind: "external_user",
        externalRef,
        dismissedByUserId: a.userId,
      });
      // Audited like the space dismiss: erasing a permission decision is
      // itself a governance act, and "who un-decided this person, and when"
      // must be answerable. Ids only - never a display name.
      await recordAuditEvent({
        workspaceId,
        userId: a.userId,
        userEmail: a.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.CHANNEL,
        source: AUDIT_SOURCE.API,
        metadata: {
          agentId: c.req.param("agentId"),
          provider,
          subjectKind: "external_user",
          reachDismissed: externalRef,
          removedGrant: String(result.removedGrant),
        },
      });
      return c.json(result);
    },
  );

  // DELETE /agents/:agentId/channels/:provider/reach/:externalRef — DISMISS:
  // forget the channel entirely (grant row + thread links), whatever the
  // grant's state. The next stranger message re-knocks fresh; a re-mention
  // re-creates the routing links. Distinct from revoke (PUT state=revoked),
  // which is the sticky no.
  app.delete("/:agentId/channels/:provider/reach/:externalRef", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const provider = parseProvider(c.req.param("provider"));
    const externalRef = c.req.param("externalRef");
    if (externalRef.length === 0 || externalRef.length > 200) {
      throw new ServiceError("UNPROCESSABLE", "Invalid channel reference");
    }
    const result = await dismissReachRow({
      workspaceId,
      agentId: c.req.param("agentId"),
      provider,
      externalRef,
      dismissedByUserId: a.userId,
    });
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        provider,
        reachDismissed: externalRef,
        removedGrant: String(result.removedGrant),
        removedLinks: String(result.removedLinks),
      },
    });
    return c.body(null, 204);
  });

  return app;
};
