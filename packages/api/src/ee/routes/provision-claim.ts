import { Hono } from "hono";
import { db } from "@onecli/db";
import { z } from "zod";
import type { ApiEnv } from "../../types";
import { requireEnterprise } from "../middleware/enterprise-gate";
import { getSessionProvider } from "../../providers";
import { logger } from "../../lib/logger";
import { ServiceError } from "../../services/errors";
import { claimProvision } from "../services/user-provision-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

const claimProvisionSchema = z.strictObject({ token: z.string().min(1) });

/**
 * Redeeming a provision claim link, deliberately NOT under `/team`.
 *
 * The teamRoutes router applies org-admin auth to everything beneath it, and
 * the person claiming a provision is not a member of any organization yet —
 * that is the whole point. Mirrors `/v1/invitations/accept`: only a session is
 * needed; the token names the organization, and the service transfers the
 * pre-minted placeholder to the caller.
 */
export const provisionClaimRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("provisioning"));

  // POST /claim
  app.post("/claim", async (c) => {
    // Deliberately NOT the auth middleware: it resolves the caller's
    // organization, and someone claiming a provision has none yet.
    const session = await getSessionProvider().getSession(c.req.raw);
    if (!session?.email) return c.json({ error: "Not authenticated" }, 401);

    const user = await db.user.findUnique({
      where: { externalAuthId: session.id },
      select: { id: true, email: true },
    });
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const parsed = claimProvisionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "A token is required" }, 400);
    }

    // The refusals here are all things a person can hit by accident — a link
    // used twice, one that expired, one already registered elsewhere. The
    // service reports them as plain errors, so they would otherwise surface
    // as a 500 and read as a crash rather than as an answer.
    let result: Awaited<ReturnType<typeof claimProvision>>;
    try {
      result = await claimProvision(
        parsed.data.token,
        user.id,
        user.email,
        session.id,
      );
    } catch (err) {
      logger.warn({ err, userId: user.id }, "provision could not be claimed");
      // Only the service's own refusals are safe to repeat back — anything
      // else is a fault, and echoing its message would hand out internals.
      if (err instanceof ServiceError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    // Audited against the organization being JOINED, not the caller's current
    // one — the claim is the first thing that happens in that org's history
    // for this person. The token never reaches the audit trail.
    await withAudit(
      async () => result,
      () => ({
        organizationId: result.organizationId,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.ACCEPT,
        service: AUDIT_SERVICES.PROVISION,
        source: AUDIT_SOURCE.API,
        metadata: { email: user.email },
      }),
    );

    return c.json(result);
  });

  return app;
};
