import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import { db } from "@onecli/db";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { assertFeatureAllowed } from "../services/quota-service";
import { updateSsoEnforcementSchema } from "../validations/sso-enforcement";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

// Admin/owner-only, like the sibling SSO-connection routes. GET stays
// readable so the settings page can render the locked/disabled states;
// ENABLING is Enterprise-gated — disabling never is (a downgraded org must
// always be able to turn enforcement off).
const admin = auth({ requireWorkspace: false, role: "admin" });

interface EnforcementState {
  ssoRequired: boolean;
  hasActiveConnection: boolean;
  hasVerifiedDomain: boolean;
  /** Both preconditions hold — the toggle may be switched on. */
  canRequire: boolean;
  /** Break-glass members; the UI warns loudly when this is 0. */
  exemptMemberCount: number;
}

const readEnforcementState = async (
  organizationId: string,
): Promise<EnforcementState> => {
  const [org, activeConnection, verifiedDomain, exemptMemberCount] =
    await Promise.all([
      db.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { ssoRequired: true },
      }),
      db.organizationSsoConnection.findFirst({
        where: { organizationId, status: "active" },
        select: { id: true },
      }),
      db.organizationDomain.findFirst({
        where: { organizationId, verifiedAt: { not: null } },
        select: { id: true },
      }),
      db.organizationMember.count({
        where: { organizationId, ssoExempt: true },
      }),
    ]);

  return {
    ssoRequired: org.ssoRequired,
    hasActiveConnection: activeConnection !== null,
    hasVerifiedDomain: verifiedDomain !== null,
    canRequire: activeConnection !== null && verifiedDomain !== null,
    exemptMemberCount,
  };
};

export const orgSsoEnforcementRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("sso"));

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    return c.json(await readEnforcementState(authCtx.organizationId));
  });

  // Login-policy only — no gateway cache to flush (agent traffic unaffected).
  app.patch("/", admin, async (c) => {
    const authCtx = c.get("auth");

    const body = await c.req.json().catch(() => null);
    const parsed = updateSsoEnforcementSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const state = await readEnforcementState(authCtx.organizationId);

    if (parsed.data.ssoRequired && !state.ssoRequired) {
      await assertFeatureAllowed(authCtx.organizationId, "sso");
      if (!state.canRequire) {
        return c.json(
          {
            error: !state.hasActiveConnection
              ? "Requiring SSO needs an active SSO connection. Complete a first sign-in through your IdP."
              : "Requiring SSO needs a verified domain. Verify your company domain first.",
          },
          400,
        );
      }
    }

    // Idempotent no-op: nothing to write or audit.
    if (parsed.data.ssoRequired === state.ssoRequired) {
      return c.json(state);
    }

    await withAudit(
      () =>
        db.organization.update({
          where: { id: authCtx.organizationId },
          data: { ssoRequired: parsed.data.ssoRequired },
          select: { id: true },
        }),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.ORGANIZATION,
        source: AUDIT_SOURCE.API,
        // Security-relevant transition — record the new value.
        metadata: { ssoRequired: parsed.data.ssoRequired },
      }),
    );

    return c.json({ ...state, ssoRequired: parsed.data.ssoRequired });
  });

  return app;
};
