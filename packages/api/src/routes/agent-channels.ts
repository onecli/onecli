import { Hono } from "hono";
import { db } from "@onecli/db";
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
import {
  ACTION_APPROVAL_STATUSES,
  decideActionApproval,
  listActionApprovals,
  type ActionApprovalStatus,
} from "../services/channels/action-approval-service";
import {
  deleteContact,
  listContacts,
  setContactPolicy,
} from "../services/channels/send-message-service";
import {
  forgetLink,
  listPeers,
  resumePairConversation,
  setLinkPolicy,
} from "../services/channels/agent-link-service";
import {
  actionApprovalDecisionSchema,
  contactPolicySchema,
} from "../validations/channels";
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

  // GET /agents/:agentId/approvals — the agent's one-shot action approvals
  // (the dashboard's pending list + history). Workspace-fenced at the
  // query inside the service; ?status narrows.
  app.get("/:agentId/approvals", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const status = c.req.query("status");
    const approvals = await listActionApprovals({
      workspaceId,
      agentId: c.req.param("agentId"),
      ...(status &&
      (ACTION_APPROVAL_STATUSES as readonly string[]).includes(status)
        ? { status: status as ActionApprovalStatus }
        : {}),
    });
    return c.json({ approvals });
  });

  // POST /agents/:agentId/approvals/:approvalId/decision — the dashboard's
  // decide door (and the only surface that captures a rejection REASON —
  // the Slack card's buttons cannot carry text). The caller's workspace
  // access is the decide authority, same as the reach PUT; the service
  // audits with the decider.
  app.post("/:agentId/approvals/:approvalId/decision", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const body = actionApprovalDecisionSchema.safeParse(
      await parseBody(c.req.raw),
    );
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    // The approval must belong to THIS workspace's agent — fenced at the
    // QUERY (never fetch-then-check), not-found-shaped: existence is never
    // disclosed across tenants.
    const owned = await db.actionApproval.findFirst({
      where: {
        id: c.req.param("approvalId"),
        agentId: c.req.param("agentId"),
        agent: { workspaceId },
      },
      select: { id: true },
    });
    if (!owned) {
      throw new ServiceError("NOT_FOUND", "This request no longer exists.");
    }
    const result = await decideActionApproval({
      approvalId: c.req.param("approvalId"),
      decision: body.data.decision,
      deciderUserId: a.userId,
      ...(body.data.reason !== undefined && { reason: body.data.reason }),
    });
    if (result.kind === "refused") {
      throw new ServiceError("NOT_FOUND", result.message);
    }
    return c.json(result);
  });

  // GET /agents/:agentId/contacts — the agent's outbound address book
  // (send_message's standing decisions). Workspace-fenced in the service.
  app.get("/:agentId/contacts", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const contacts = await listContacts({
      workspaceId,
      agentId: c.req.param("agentId"),
    });
    return c.json({ contacts });
  });

  // PUT /agents/:agentId/contacts/:contactId — flip the policy. `ask` is
  // the revoke direction (the row survives; the standing permission goes).
  app.put("/:agentId/contacts/:contactId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const body = contactPolicySchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const result = await setContactPolicy({
      workspaceId,
      agentId: c.req.param("agentId"),
      contactId: c.req.param("contactId"),
      policy: body.data.policy,
      deciderUserId: a.userId,
    });
    if (!result) {
      throw new ServiceError("NOT_FOUND", "This contact no longer exists.");
    }
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        contactId: result.id,
        contactPolicy: result.policy,
      },
    });
    return c.json(result);
  });

  // GET /agents/:agentId/links — the agent's peers (PR 5b): every other
  // hosted agent it may message, with both sides' standing decision and the
  // pair conversation once they have talked. Workspace-fenced in the service.
  app.get("/:agentId/links", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const peers = await listPeers({
      workspaceId,
      agentId: c.req.param("agentId"),
    });
    return c.json({ peers });
  });

  // PUT /agents/:agentId/links/:peerAgentId — set THIS agent's side of the
  // relationship. Same three words as a contact (ask / allow / blocked), so
  // the same body schema; `ask` is the revoke direction here too. The peer
  // may live in another workspace by design: only `agentId` is fenced.
  app.put("/:agentId/links/:peerAgentId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const body = contactPolicySchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const result = await setLinkPolicy({
      workspaceId,
      agentId: c.req.param("agentId"),
      peerAgentId: c.req.param("peerAgentId"),
      policy: body.data.policy,
      deciderUserId: a.userId,
    });
    if (!result) {
      throw new ServiceError("NOT_FOUND", "Agent not found");
    }
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        peerAgentId: c.req.param("peerAgentId"),
        linkId: result.id,
        linkPolicy: result.policy,
      },
    });
    return c.json(result);
  });

  // POST /agents/:agentId/links/:peerAgentId/resume — a person continues
  // THIS agent's pair conversation past the turn cap (the peer row's
  // Resume). Approves the pending continue card when there is one (same
  // live gate, same one-round reset, the parked message replays), else
  // resets the streak. Idempotent on a pair that is not paused. Answers
  // the row's new state, so the client can settle its cache without a
  // refetch.
  app.post("/:agentId/links/:peerAgentId/resume", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const resumed = await resumePairConversation({
      workspaceId,
      agentId: c.req.param("agentId"),
      peerAgentId: c.req.param("peerAgentId"),
      deciderUserId: a.userId,
    });
    if (!resumed) {
      throw new ServiceError("NOT_FOUND", "Agent not found");
    }
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.APPROVE,
      service: AUDIT_SERVICES.AGENT,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        peerAgentId: c.req.param("peerAgentId"),
        resumed: "pair_conversation",
      },
    });
    return c.json({ paused: false });
  });

  // DELETE /agents/:agentId/links/:peerAgentId — forget the relationship
  // from THIS agent's side: pair row, this side's pair conversation, and
  // this side's pending cards about the pair. The peer keeps its own.
  app.delete("/:agentId/links/:peerAgentId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const removed = await forgetLink({
      workspaceId,
      agentId: c.req.param("agentId"),
      peerAgentId: c.req.param("peerAgentId"),
    });
    if (!removed) {
      throw new ServiceError("NOT_FOUND", "Agent not found");
    }
    await recordAuditEvent({
      workspaceId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.AGENT,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: c.req.param("agentId"),
        peerAgentId: c.req.param("peerAgentId"),
      },
    });
    return c.body(null, 204);
  });

  // DELETE /agents/:agentId/contacts/:contactId — remove the row entirely
  // (back to the ask-by-default pristine state).
  app.delete("/:agentId/contacts/:contactId", async (c) => {
    const a = c.get("auth");
    const workspaceId = requireWorkspaceId(a);
    const removed = await deleteContact({
      workspaceId,
      agentId: c.req.param("agentId"),
      contactId: c.req.param("contactId"),
    });
    if (!removed) {
      throw new ServiceError("NOT_FOUND", "This contact no longer exists.");
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
        contactId: c.req.param("contactId"),
      },
    });
    return c.body(null, 204);
  });

  return app;
};
