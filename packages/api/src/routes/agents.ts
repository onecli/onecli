import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { apiError } from "../middleware/error-handler";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  listAgents,
  createAgent,
  agentExistsByIdentifier,
  getAgentDetail,
  updateAgent,
  deleteAgent,
  regenerateAgentToken,
} from "../services/agent-service";
import {
  createAgentSchema,
  mintSshCertificateSchema,
  updateAgentSchema,
} from "../validations/agent";
import { mintSshCertificate } from "../services/ssh-service";
import {
  setAgentImage,
  clearAgentImage,
  MAX_AGENT_IMAGE_BYTES,
} from "../services/agent-image-service";
import { readCappedBinaryBody } from "../lib/read-capped-binary-body";
import { ensureDirectConversation } from "../services/conversation-service";
import { getAgentModels } from "../services/agent-models-service";
import { agentsIncludeSchema } from "../validations/grants";
import { listAgentsWithGrantsSummary } from "../services/grants-summary-service";
import { ServiceError } from "../services/errors";
import { getResourceHooks } from "../providers";

export const agentRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents[?include=grants-summary] — the plain list, or (the first
  // `?include=` projection) each agent with its attach-list chips summary.
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const rawInclude = c.req.query("include");
    const include = agentsIncludeSchema.safeParse(rawInclude);
    if (!include.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `Unknown include: ${rawInclude ?? ""}`,
      );
    }
    if (include.data === "grants-summary") {
      return c.json(
        await listAgentsWithGrantsSummary(workspaceId, auth.organizationId),
      );
    }
    const agents = await listAgents(workspaceId);
    return c.json(agents);
  });

  // POST /agents
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const workspaceId = requireWorkspaceId(auth);

    // The agent quota gates *new* agents only -- re-creating an existing
    // identifier consumes no slot. Skip the quota check when it already exists
    // so createAgent returns the canonical 409 instead of a 403 that shadows it
    // at the cap and breaks idempotent ensureAgent. See onecli/node-sdk#40.
    if (!(await agentExistsByIdentifier(workspaceId, parsed.data.identifier))) {
      await getResourceHooks().beforeCreateAgent(
        auth.organizationId,
        workspaceId,
      );
    }

    // `parentIdentifier` stays ACCEPTED in the schema (the CLI sends it on
    // sub-agent creation) but is no longer threaded anywhere: it only ever
    // drove secret-mode inheritance, and since attach-model step 5 every new
    // agent is selective.
    const agent = await createAgent(
      workspaceId,
      {
        name: parsed.data.name,
        identifier: parsed.data.identifier,
        kind: parsed.data.kind,
        harness: parsed.data.harness,
        instructions: parsed.data.instructions,
      },
      // The grantor recorded on the LLM keys the service auto-attaches.
      auth.userId,
    );
    invalidateGatewayCache(c.req.raw);
    return c.json(agent, 201);
  });

  // The default-agent concept is retired: nothing is seeded, every agent is
  // deletable, and new defaults can no longer be set. Omitting `agent=` at
  // /v1/container-config only resolves a pre-v2 workspace's legacy default —
  // everyone else passes an explicit agent. These tombstones live HERE, not
  // in `removed-routes.ts`, because that router is mounted last: `/:agentId`
  // below would swallow `/default` before a shim ever saw it. 410 over a
  // silent 404 so a stale client reads why.
  app.all("/default", () => {
    throw new ServiceError(
      "GONE",
      "GET /v1/agents/default was removed: the default-agent concept is " +
        "retired. List agents with GET /v1/agents and pass one explicitly to " +
        "/v1/container-config (`agent=`, or pin with " +
        "`onecli config set agent <identifier>`).",
    );
  });
  app.all("/:agentId/set-default", () => {
    throw new ServiceError(
      "GONE",
      "POST /v1/agents/:agentId/set-default was removed: new default agents " +
        "can no longer be set. Pin a machine to a specific agent instead " +
        "(`onecli config set agent <identifier>`).",
    );
  });

  // GET /agents/:agentId
  app.get("/:agentId", async (c, next) => {
    const agentId = c.req.param("agentId");
    // `/granular-access` is a step-10 tombstone: fall through to the 410 shim
    // (`removedAgentEquipmentRoutes`, mounted after this router) instead of
    // answering 404 for a path that must keep saying what replaced it.
    if (agentId === "granular-access") return next();
    const auth = c.get("auth");
    const agent = await getAgentDetail(requireWorkspaceId(auth), agentId);
    return c.json(agent);
  });

  // PATCH /agents/:agentId — name, and (hosted only) the instructions brief
  // plus the model/effort override of §3.10. kind and harness stay immutable
  // after create. No gateway-cache invalidation: the gateway reads none of
  // these columns — but a model change DOES respawn the sandbox, since the
  // model is baked into its environment (handled in the service).
  app.patch("/:agentId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => null);
    const parsed = updateAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await updateAgent(requireWorkspaceId(auth), agentId, parsed.data);
    return c.json({ success: true });
  });

  // PUT /agents/:agentId/image — the avatar, raw binary body (the repo has
  // no multipart anywhere; the attachments door set the pattern). Byte-capped
  // mid-stream; the format gate is magic-byte sniffing in the service (SVG
  // refused). Returns the new public URL.
  app.put("/:agentId/image", async (c) => {
    const auth = c.get("auth");
    const body = await readCappedBinaryBody(c.req.raw, MAX_AGENT_IMAGE_BYTES);
    if (!body.ok) {
      if (body.reason === "too_large") {
        return c.json(
          apiError(
            `Images are capped at ${Math.floor(MAX_AGENT_IMAGE_BYTES / (1024 * 1024))}MB.`,
          ),
          413,
        );
      }
      throw new ServiceError(
        "UNPROCESSABLE",
        body.reason === "empty" ? "The image is empty." : "Unreadable upload.",
      );
    }
    const workspaceId = requireWorkspaceId(auth);
    const agentId = c.req.param("agentId");
    const result = await setAgentImage(workspaceId, agentId, body.bytes);
    // Audited (the agent-channels.ts API-route pattern): the avatar is
    // externally visible content — it rides every Slack post — and this
    // route is its ONLY door, so nothing else attributes the change. Ids
    // only in the metadata, never the bytes or the serving key.
    await recordAuditEvent({
      workspaceId,
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, field: "image" },
    });
    return c.json(result);
  });

  // DELETE /agents/:agentId/image — back to the default mark.
  app.delete("/:agentId/image", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const agentId = c.req.param("agentId");
    await clearAgentImage(workspaceId, agentId);
    await recordAuditEvent({
      workspaceId,
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.AGENT,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, field: "image" },
    });
    return c.body(null, 204);
  });

  // GET /agents/:agentId/models — what this agent can run, and what it runs
  // now (§3.10). Live per-provider list behind a registry, so adding a
  // provider is one entry and a model released tomorrow needs no deploy.
  // Always 200 for an agent that exists: "no key granted" is an empty view,
  // not an error, because the same payload drives the UI's quiet indicator.
  app.get("/:agentId/models", async (c) => {
    const auth = c.get("auth");
    const view = await getAgentModels(
      requireWorkspaceId(auth),
      c.req.param("agentId"),
    );
    return c.json(view);
  });

  // PUT /agents/:agentId/conversations/direct — the §3.18 door: materialize
  // (or return) THE CALLER's direct conversation with this agent (per-user
  // since step 6 — each workspace member has their own private thread, and this
  // door resolves by the authenticated user). Idempotent by the partial
  // unique index, so the web opens the thread with a single call and a retry
  // can never fork a second one. 200 either way — callers don't care which
  // side created it. Not audited, matching the conversations router's
  // deliberate posture for conversation writes.
  app.put("/:agentId/conversations/direct", async (c) => {
    const auth = c.get("auth");
    const conversation = await ensureDirectConversation(
      requireWorkspaceId(auth),
      c.req.param("agentId"),
      auth.userId,
    );
    return c.json(conversation);
  });

  // DELETE /agents/:agentId
  app.delete("/:agentId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    await deleteAgent(requireWorkspaceId(auth), agentId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  // POST /agents/:agentId/regenerate-token
  app.post("/:agentId/regenerate-token", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const result = await regenerateAgentToken(
      requireWorkspaceId(auth),
      agentId,
    );
    invalidateGatewayCache(c.req.raw);
    return c.json(result);
  });

  // POST /agents/:agentId/ssh-certificate (sandbox-platform step 5): mint a
  // short-lived OpenSSH user certificate for this agent. Same authz stack as
  // every agent sub-resource (workspace-fenced lookup inside the service);
  // the hosted-kind gate is the service's — the regenerate-token pattern
  // does NOT provide it. Dark (404) when no SSH CA is configured. No gateway
  // cache flush: the gateway reads no SSH state.
  app.post("/:agentId/ssh-certificate", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => null);
    const parsed = mintSshCertificateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    const result = await mintSshCertificate(
      requireWorkspaceId(auth),
      auth.userId,
      auth.userEmail,
      agentId,
      parsed.data,
    );
    return c.json(result);
  });

  // PATCH /:agentId/secret-mode was removed in attach-model step 5 — the
  // sub-path 410 lives in `removedAgentEquipmentRoutes`, mounted after this
  // router.

  return app;
};
