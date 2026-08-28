import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { CAPS } from "../lib/env";
import { ServiceError } from "../services/errors";
import {
  addUserLink,
  connectIntegration,
  disconnectIntegration,
  getIntegrationView,
  listUserLinks,
  removeUserLink,
} from "../services/channels/channel-integration-service";
import { adapterLiveness } from "../services/channels/channel-adapter-service";
import { isChannelProviderId } from "../services/channels/registry";
import type { ChannelProviderId } from "../services/channels/types";
import {
  addUserLinkSchema,
  connectIntegrationSchema,
} from "../validations/channels";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";

/**
 * Org-level channel integrations: /v1/org/channels/* — a FREE surface
 * (§3.16: never the EE org-credential store), mounted in the free block of
 * `app.ts` beside org-policy.
 *
 * Admin-gated where roles exist; with RBAC off there is no role resolver at
 * all, so asking for one would 403 every caller including the owner (the
 * `runners.ts` posture, not `org-policy.ts`'s unconditional variant).
 *
 * Audited with `recordAuditEvent`, not `withAudit` — the gateway reads none
 * of these tables, and `withAudit` flushes its cache unconditionally.
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

export const orgChannelRoutes = () => {
  const app = new Hono<ApiEnv>();

  const guard = CAPS.rbac
    ? auth({ requireWorkspace: false, role: "admin" })
    : auth({ requireWorkspace: false });
  app.use("*", guard);

  // GET /org/channels — integrations, user links, adapter liveness. One call
  // drives the whole settings page; credentials never leave the server.
  app.get("/", async (c) => {
    const { organizationId } = c.get("auth");
    const [integrations, userLinks, adapter] = await Promise.all([
      getIntegrationView(organizationId),
      listUserLinks(organizationId),
      adapterLiveness(),
    ]);
    return c.json({ integrations, userLinks, adapter });
  });

  // PUT /org/channels/:provider/credentials — connect or refresh the org's
  // automation credential (Slack: the app-config token pair).
  app.put("/:provider/credentials", async (c) => {
    const a = c.get("auth");
    const provider = parseProvider(c.req.param("provider"));
    const body = connectIntegrationSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }

    const result = await connectIntegration(
      a.organizationId,
      provider,
      body.data.credential,
      a.userId,
    );
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: { provider, tenantId: result.tenant.externalId },
    });
    return c.json({ provider, tenant: result.tenant });
  });

  // DELETE /org/channels/:provider — drop the automation credential (or the
  // whole integration when nothing references it).
  app.delete("/:provider", async (c) => {
    const a = c.get("auth");
    const provider = parseProvider(c.req.param("provider"));
    await disconnectIntegration(a.organizationId, provider);
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DISCONNECT,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: { provider },
    });
    return c.body(null, 204);
  });

  // POST /org/channels/:provider/user-links — an explicit identity link.
  app.post("/:provider/user-links", async (c) => {
    const a = c.get("auth");
    const provider = parseProvider(c.req.param("provider"));
    const body = addUserLinkSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        body.error.issues[0]?.message ?? "Invalid body",
      );
    }
    const link = await addUserLink(a.organizationId, provider, body.data);
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        provider,
        linkedUserId: body.data.userId,
        externalUserId: body.data.externalUserId,
      },
    });
    return c.json(link, 201);
  });

  // DELETE /org/channels/:provider/user-links/:linkId
  app.delete("/:provider/user-links/:linkId", async (c) => {
    const a = c.get("auth");
    parseProvider(c.req.param("provider"));
    const linkId = c.req.param("linkId");
    await removeUserLink(a.organizationId, linkId);
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: { linkId },
    });
    return c.body(null, 204);
  });

  return app;
};
