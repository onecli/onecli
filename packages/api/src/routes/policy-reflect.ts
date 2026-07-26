import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { auth, requireProjectId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import { getRoleResolver } from "../providers";
import { effectiveAppPermissions } from "../services/policy-reflect/effective-tools";
import { effectiveCredentials } from "../services/policy-reflect/effective-credentials";
import { effectiveAgents } from "../services/policy-reflect/effective-agents";

// Org-rule redaction driver: resolve the viewer's role via the roleResolver
// provider. EE sets it (authorization-service); OSS/onprem-slim leave it null →
// non-admin → fail-safe redaction of org-rule details.
const resolveRole = (userId: string, organizationId: string) =>
  getRoleResolver()?.getUserRole(userId, organizationId) ??
  Promise.resolve(null);

// The step-9.7b read-only reflections (EE; compose onto the shared routers like
// the simulate precedent): what the ENFORCED v2 rules mean for the legacy
// equipment panels. Reads only — never audited, no write path exists. Org-rule
// details are redacted for non-org-admins inside the services (the simulate
// response-layer contract).

const effectiveAppPermissionsQuery = z.object({
  provider: z.string().trim().min(1).max(100),
  agentId: z.string().trim().min(1).optional(),
});

/** Composes onto the shared /policy router (project scope). */
export const policyReflectRoutes = () => {
  const app = new Hono<ApiEnv>();

  // GET /v1/policy/effective-app-permissions?provider=X[&agentId=Y] — the
  // per-tool effective-permissions reflection for the App Permissions
  // panel. Any PROJECT MEMBER (it replaces a member-visible panel).
  app.get("/effective-app-permissions", auth(), async (c) => {
    const authCtx = c.get("auth");
    const projectId = requireProjectId(authCtx);
    const parsed = effectiveAppPermissionsQuery.safeParse({
      provider: c.req.query("provider"),
      agentId: c.req.query("agentId"),
    });
    if (!parsed.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        parsed.error.issues[0]?.message ?? "Invalid query",
      );
    }
    // Org-admin viewers see org rule details; everyone else gets redaction.
    // A null resolver/role (OSS, unknown) fails SAFE to non-admin.
    const role = await resolveRole(authCtx.userId, authCtx.organizationId);
    const viewerSeesOrgRules = role === "admin" || role === "owner";
    return c.json(
      await effectiveAppPermissions(parsed.data, {
        scope: "project",
        projectId,
        organizationId: authCtx.organizationId,
        viewerSeesOrgRules,
      }),
    );
  });

  return app;
};

/** Composes onto the shared /agents router: the injectable-credential
 * reflection for the "Credential access" dialog. Any PROJECT MEMBER
 * (it replaces a member-visible dialog — the member fence, not the
 * resolved-identity admin gate). */
export const agentReflectRoutes = () => {
  const app = new Hono<ApiEnv>();

  app.get("/:agentId/effective-credentials", auth(), async (c) => {
    const authCtx = c.get("auth");
    const projectId = requireProjectId(authCtx);
    const role = await resolveRole(authCtx.userId, authCtx.organizationId);
    const viewerSeesOrgRules = role === "admin" || role === "owner";
    return c.json(
      await effectiveCredentials(c.req.param("agentId"), {
        projectId,
        organizationId: authCtx.organizationId,
        viewerSeesOrgRules,
      }),
    );
  });

  return app;
};

/** Composes onto the shared /connections router: the per-agent access
 * reflection for the connection "agent access" dialog. Any PROJECT
 * MEMBER (it replaces a member-visible dialog). */
export const connectionReflectRoutes = () => {
  const app = new Hono<ApiEnv>();

  app.get("/:connectionId/effective-agents", auth(), async (c) => {
    const authCtx = c.get("auth");
    const projectId = requireProjectId(authCtx);
    const role = await resolveRole(authCtx.userId, authCtx.organizationId);
    const viewerSeesOrgRules = role === "admin" || role === "owner";
    return c.json(
      await effectiveAgents(c.req.param("connectionId"), {
        projectId,
        organizationId: authCtx.organizationId,
        viewerSeesOrgRules,
      }),
    );
  });

  return app;
};

/** Composes onto /org/policy (org scope — the admin global-connections page's
 * agent-less variant: org rules + org default only). */
export const orgPolicyReflectRoutes = () => {
  const app = new Hono<ApiEnv>();
  const admin = auth({ requireProject: false, role: "admin" });

  app.get("/effective-app-permissions", admin, async (c) => {
    const authCtx = c.get("auth");
    const parsed = effectiveAppPermissionsQuery
      .omit({ agentId: true })
      .safeParse({ provider: c.req.query("provider") });
    if (!parsed.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        parsed.error.issues[0]?.message ?? "Invalid query",
      );
    }
    return c.json(
      await effectiveAppPermissions(parsed.data, {
        scope: "organization",
        organizationId: authCtx.organizationId,
        // Admin-gated route — org rule details are the viewer's to see.
        viewerSeesOrgRules: true,
      }),
    );
  });

  return app;
};
