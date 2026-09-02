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
import {
  channelProvider,
  CHANNEL_PROVIDERS,
  isChannelProviderId,
} from "../services/channels/registry";
import type {
  ChannelProviderId,
  ChannelSharedApp,
} from "../services/channels/types";
import {
  addUserLinkSchema,
  connectIntegrationSchema,
  finishInstallSchema,
  inspectInstallSchema,
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

/** The shared-app routes exist only for providers whose registry entry
 * carries the `sharedApp` facet — one refusal, four routes, so the message
 * can never drift between them. Answers the facet so callers need no second
 * lookup. */
const requireSharedApp = (raw: string): ChannelSharedApp => {
  const provider = parseProvider(raw);
  const sharedApp = channelProvider(provider).sharedApp;
  if (!sharedApp) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `${channelProvider(provider).displayName} has no shared app.`,
    );
  }
  return sharedApp;
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

  // GET /org/channels — integrations, user links, adapter liveness, and the
  // shared-app posture. One call drives the whole settings page; credentials
  // never leave the server. The response's `sharedApp` is a singleton by
  // wire-compat: exactly one provider carries the facet today, and the
  // registry walk (not a provider-id literal) is what finds it.
  app.get("/", async (c) => {
    const { organizationId } = c.get("auth");
    const sharedAppProvider = Object.values(CHANNEL_PROVIDERS).find(
      (p) => p.sharedApp,
    );
    const [integrations, userLinks, adapter, sharedApp] = await Promise.all([
      getIntegrationView(organizationId),
      listUserLinks(organizationId),
      adapterLiveness(),
      sharedAppProvider?.sharedApp
        ? sharedAppProvider.sharedApp.view(organizationId)
        : Promise.resolve(null),
    ]);
    return c.json({ integrations, userLinks, adapter, sharedApp });
  });

  // POST /org/channels/:provider/shared-install — mint the "Add to Slack"
  // consent URL for the deployment's shared app. Side-effect free; the
  // install lands (possibly days later, behind Slack admin approval) on the
  // OAuth callback.
  app.post("/:provider/shared-install", async (c) => {
    const a = c.get("auth");
    const provider = parseProvider(c.req.param("provider"));
    const sharedApp = requireSharedApp(c.req.param("provider"));
    const result = sharedApp.startInstall({
      organizationId: a.organizationId,
      actorUserId: a.userId,
    });
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: { provider, sharedInstall: "started" },
    });
    return c.json(result);
  });

  // POST /org/channels/:provider/finish-install — spend a code parked by a
  // MARKETPLACE install (one begun in Slack's directory, where no OneCLI
  // session existed to sign a state into). The org is this caller's, so the
  // admin gate above plus the two-step confirm is the authorization story:
  // INSPECT exchanges the parked code and names the workspace (binding
  // nothing), so the human confirmation the finish relies on is informed —
  // "connect workspace X" — instead of a claim the page cannot verify.
  app.post("/:provider/finish-install/inspect", async (c) => {
    const a = c.get("auth");
    const sharedApp = requireSharedApp(c.req.param("provider"));
    const body = inspectInstallSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "This install link is not valid.",
      );
    }
    return c.json(
      await sharedApp.inspectInstallCode({
        organizationId: a.organizationId,
        actorUserId: a.userId,
        code: body.data.code,
      }),
    );
  });

  // …and the CONFIRM binds the inspected claim to this caller's org.
  app.post("/:provider/finish-install", async (c) => {
    const a = c.get("auth");
    const provider = parseProvider(c.req.param("provider"));
    const sharedApp = requireSharedApp(c.req.param("provider"));
    const body = finishInstallSchema.safeParse(await parseBody(c.req.raw));
    if (!body.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "This install link is not valid.",
      );
    }
    const result = await sharedApp.confirmInstallFromClaim({
      organizationId: a.organizationId,
      actorUserId: a.userId,
      claim: body.data.claim,
    });
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        provider,
        sharedInstall: "finished-from-provider",
        teamId: result.teamId,
      },
    });
    return c.json(result);
  });

  // GET /org/channels/:provider/shared-manifest — the setup document a
  // self-hosted operator creates THEIR shared app from (then sets the
  // provider's shared-app env).
  app.get("/:provider/shared-manifest", async (c) => {
    const sharedApp = requireSharedApp(c.req.param("provider"));
    const manifest = sharedApp.setupManifest();
    if (!manifest) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "The shared app needs a public HTTPS API origin.",
      );
    }
    return c.json({ manifest });
  });

  // DELETE /org/channels/:provider/shared-install — disconnect the org's
  // shared-app install (uninstalls from Slack best-effort, deletes locally
  // regardless).
  app.delete("/:provider/shared-install", async (c) => {
    const a = c.get("auth");
    const provider = parseProvider(c.req.param("provider"));
    const sharedApp = requireSharedApp(c.req.param("provider"));
    const disconnected = await sharedApp.disconnectInstall(a.organizationId);
    if (!disconnected) {
      throw new ServiceError("NOT_FOUND", "No shared app install");
    }
    await recordAuditEvent({
      organizationId: a.organizationId,
      userId: a.userId,
      userEmail: a.userEmail,
      action: AUDIT_ACTIONS.DISCONNECT,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: { provider, sharedInstall: "disconnected" },
    });
    return c.body(null, 204);
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
