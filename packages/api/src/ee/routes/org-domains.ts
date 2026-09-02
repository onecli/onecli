import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  listDomains,
  createDomain,
  verifyDomain,
  deleteDomain,
} from "../services/org-domain-service";
import { createOrgDomainSchema } from "../validations/org-domain";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

// Org domains are admin/owner-only — every route requires admin. Adding and
// verifying are additionally Enterprise-gated ("sso"); deletion never is
// (teardown must survive a plan lapse). The list stays readable so the
// settings page can render the locked state.
const admin = auth({ requireWorkspace: false, role: "admin" });

export const orgDomainRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("sso"));

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    return c.json(await listDomains(authCtx.organizationId));
  });

  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "sso");

    const body = await c.req.json().catch(() => null);
    const parsed = createOrgDomainSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const domain = await withAudit(
      () =>
        createDomain(
          authCtx.organizationId,
          parsed.data.domain,
          authCtx.userId,
        ),
      (d) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.DOMAIN,
        source: AUDIT_SOURCE.API,
        metadata: { domainId: d.id, domain: d.domain },
      }),
    );
    return c.json(domain, 201);
  });

  app.post("/:domainId/verify", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "sso");
    const domainId = c.req.param("domainId");

    const domain = await withAudit(
      () => verifyDomain(authCtx.organizationId, domainId),
      (d) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.VERIFY,
        service: AUDIT_SERVICES.DOMAIN,
        source: AUDIT_SOURCE.API,
        metadata: { domainId: d.id, domain: d.domain, verified: true },
      }),
    );
    return c.json(domain);
  });

  // Deliberately not plan-gated: a verified domain keeps steering the whole
  // email domain into SSO login, so removing it must survive a plan lapse.
  app.delete("/:domainId", admin, async (c) => {
    const authCtx = c.get("auth");
    const domainId = c.req.param("domainId");

    await withAudit(
      () => deleteDomain(authCtx.organizationId, domainId),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.DOMAIN,
        source: AUDIT_SOURCE.API,
        metadata: { domainId },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
