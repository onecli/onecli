import { Hono } from "hono";
import { z } from "zod";

import {
  authMiddleware,
  requireWorkspaceId,
  sessionAuth,
} from "../middleware/auth";
import { previewRelayAuth } from "../middleware/preview-relay-auth";
import { PREVIEW_DOMAIN } from "../lib/env";
import { previewsEnabled } from "../lib/preview-availability";
import { ServiceError } from "../services/errors";
import {
  authorizePreview,
  listSandboxPorts,
  markPreviewActivity,
  mintPreviewTicket,
  resolveHost,
  shareSandboxPort,
  unshareSandboxPort,
  userCanViewHost,
  verifyPreviewTicket,
} from "../services/sandbox-port-service";
import { getAgentDesktop } from "../providers/hooks/agent-desktop";
import { wakeSandboxFor } from "../services/turn-service";
import { signalWork } from "../services/due-work";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";
import type { ApiEnv } from "../types";

/**
 * Sandbox ports HTTP surfaces (plans/sandbox-ports.md):
 *
 * - `/agents/:agentId/ports` — the dashboard's Ports tab (session/API-key
 *   auth, workspace-fenced in the service).
 * - `/preview-auth` — the login handoff. A browser without a preview session
 *   is sent here by the relay; if the OneCLI session belongs to a workspace
 *   member, it is bounced back with a 60s host-bound ticket. The preview
 *   domain never sees a OneCLI cookie.
 * - `/preview-relay/*` — the relay's own channel (static secret): resolve a
 *   hostname, verify a ticket, re-check a viewer, wake a sandbox, report
 *   activity.
 */

const hostSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+(:\d{1,5})?$/i);

export const sandboxPortRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/:agentId/ports", async (c) => {
    const auth = c.get("auth");
    return c.json(
      await listSandboxPorts(requireWorkspaceId(auth), c.req.param("agentId")),
    );
  });

  app.put("/:agentId/ports/:port", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const agentId = c.req.param("agentId");
    const port = Number(c.req.param("port"));
    const share = await shareSandboxPort({
      workspaceId,
      agentId,
      port,
      userId: auth.userId,
    });
    await recordAuditEvent({
      workspaceId,
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.PREVIEW,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, port: String(port), hostname: share.hostname },
    });
    return c.json(share);
  });

  app.delete("/:agentId/ports/:port", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const agentId = c.req.param("agentId");
    const port = Number(c.req.param("port"));
    await unshareSandboxPort(workspaceId, agentId, port);
    await recordAuditEvent({
      workspaceId,
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.PREVIEW,
      source: AUDIT_SOURCE.API,
      metadata: { agentId, port: String(port) },
    });
    return c.body(null, 204);
  });

  return app;
};

/** Same-origin paths only: browsers read `/\host` as `//host` and strip
 * tabs/newlines, so any backslash or control char falls back to `/`. */
const safePath = (rawPath: string) =>
  rawPath.startsWith("/") &&
  !rawPath.startsWith("//") &&
  // eslint-disable-next-line no-control-regex -- refusing control chars is the point
  !/[\\\u0000-\u001f\u007f]/.test(rawPath)
    ? rawPath
    : "/";

/**
 * POST /v1/preview-auth `{host, path}` — the login handoff, called by the
 * dashboard's /preview-auth page with the viewer's normal credentials (the
 * Bearer token in the cloud, the session cookie on self-host), so it works
 * in every edition and on split hosts. Answers the preview's ticket URL;
 * the page navigates there. The ticket never rides a credential in a URL.
 */
export const previewAuthRoutes = () => {
  const app = new Hono<ApiEnv>();
  // The PERSON-only session middleware, not `auth()`: the /preview-auth page
  // lives outside every `/w/<id>` and `/org/<id>` URL, so the dashboard
  // sends no tenant header, and the cloud's `auth()` can resolve a session
  // only through one (no default-workspace fallback by design) — the first
  // dev roll answered every handoff with the generic 401. The preview names
  // its own workspace; authorizePreview fences the viewer against it. An
  // API key (an agent's or a script's) is refused outright by sessionAuth:
  // a viewer is a person, and a key must never mint a browser session.
  app.use("*", sessionAuth());
  app.post("/", async (c) => {
    const viewer = c.get("sessionUser");
    const body = z
      .object({ host: hostSchema, path: z.string().max(2048).default("/") })
      .safeParse(await c.req.json().catch(() => null));
    const host = body.success ? body.data.host.toLowerCase() : "";
    if (
      !body.success ||
      !previewsEnabled() ||
      !host.endsWith(`.${PREVIEW_DOMAIN}`)
    ) {
      throw new ServiceError("NOT_FOUND", "Unknown preview");
    }
    const target = await authorizePreview(viewer.userId, host);
    if (!target)
      throw new ServiceError(
        "FORBIDDEN",
        "You don't have access to this preview",
      );
    const ticket = mintPreviewTicket(host, viewer.userId);
    // Who opened which preview, like an SSH session open: a person getting
    // into an agent's computer through a browser is an access event.
    await recordAuditEvent({
      workspaceId: target.workspaceId,
      userId: viewer.userId,
      userEmail: viewer.userEmail,
      action: AUDIT_ACTIONS.SESSION_OPEN,
      service: AUDIT_SERVICES.PREVIEW,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: target.agentId,
        port: String(target.port),
        hostname: host,
      },
    });
    const dest = new URL(`https://${host}/__onecli/auth`);
    dest.searchParams.set("ticket", ticket);
    dest.searchParams.set("path", safePath(body.data.path));
    return c.json({ url: dest.toString() });
  });

  /**
   * POST /v1/preview-auth/desktop-ticket `{host}`: a hosted-platform
   * stream credential, minted by its implementation for a person who may
   * use that host right now. Absent (self-host): not found, like an
   * unknown host.
   */
  app.post("/desktop-ticket", async (c) => {
    const viewer = c.get("sessionUser");
    const agentDesktop = getAgentDesktop();
    const body = z
      .object({ host: hostSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!agentDesktop || !body.success) {
      throw new ServiceError("NOT_FOUND", "Unknown desktop");
    }
    return c.json(
      await agentDesktop.mintTicket({
        userId: viewer.userId,
        userEmail: viewer.userEmail,
        host: body.data.host,
      }),
    );
  });
  return app;
};

export const previewRelayRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", previewRelayAuth);

  app.post("/resolve", async (c) => {
    const body = z
      .object({ host: hostSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ServiceError("BAD_REQUEST", "bad host");
    const target = await resolveHost(body.data.host);
    if (!target) return c.json({ state: "not_found" });
    return c.json(target);
  });

  app.post("/verify-ticket", async (c) => {
    const body = z
      .object({ host: hostSchema, ticket: z.string().min(10).max(2048) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ServiceError("BAD_REQUEST", "bad ticket");
    const verified = verifyPreviewTicket(
      body.data.ticket,
      body.data.host.toLowerCase(),
    );
    if (!verified) return c.json({ ok: false });
    // Re-authorize at redemption (membership may have changed in the 60s).
    const ok = await userCanViewHost(
      verified.userId,
      body.data.host.toLowerCase(),
    );
    return c.json(ok ? { ok: true, userId: verified.userId } : { ok: false });
  });

  app.post("/check-viewer", async (c) => {
    const body = z
      .object({ host: hostSchema, userId: z.string().min(1).max(100) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ServiceError("BAD_REQUEST", "bad viewer");
    return c.json({
      ok: await userCanViewHost(body.data.userId, body.data.host.toLowerCase()),
    });
  });

  // The relay names a HOST, never a raw agent id: each action resolves the
  // host to a LIVE private share first, so a relay-secret holder can only
  // wake or touch sandboxes that someone actually shared.
  const liveShareFor = async (raw: unknown) => {
    const body = z.object({ host: hostSchema }).safeParse(raw);
    if (!body.success) throw new ServiceError("BAD_REQUEST", "bad host");
    const target = await resolveHost(body.data.host);
    if (!target || target.state !== "ok")
      throw new ServiceError("NOT_FOUND", "No live share for this host");
    return target;
  };

  // A preview hit's wake also relaunches the shares' apps (the start payload
  // reads the reason); a desktop host's wake is a plain one, its screen
  // needs no app.
  app.post("/wake", async (c) => {
    const target = await liveShareFor(await c.req.json().catch(() => null));
    await wakeSandboxFor(
      target.agentId,
      target.kind === "desktop" ? null : "preview",
    );
    // Wake the runner's held poll too (the SSH mint precedent): the viewer
    // is staring at a "waking up" page, so the boot should start now, not
    // after the poll's next re-check.
    signalWork();
    return c.json({ ok: true });
  });

  // A person is using a preview, or a hosted-platform stream on a sandbox
  // host: restart the idle clock, exactly as an attached SSH session does.
  // Only for a sandbox already running (never a wake), and the relay
  // throttles previews to once a minute per host. A non-preview host's
  // beat names its viewer and goes to that capability's implementation,
  // with the role taken from this api's own resolve of the host, never
  // from the relay's body.
  app.post("/activity", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const target = await liveShareFor(raw);
    if (target.kind === "desktop") {
      const viewer = z
        .object({ userId: z.string().min(1).max(100).optional() })
        .safeParse(raw);
      await getAgentDesktop()?.markActivity(
        target.agentId,
        viewer.success ? (viewer.data.userId ?? null) : null,
        target.desktop.role,
      );
    } else {
      await markPreviewActivity(target.agentId);
    }
    return c.json({ ok: true });
  });

  return app;
};
