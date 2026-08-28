import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import { z } from "zod";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";
import {
  getAppAvailability,
  setAppAvailability,
} from "../services/app-availability-service";

// Org-scoped app-availability allowlist: GET/PUT /v1/org/app-availability —
// admin/owner only. Writes are gated behind the editing flag (inert until the
// step-5/6 cutover) AND the enterprise plan (availability derives from the
// directory). Reads stay admin-only so a non-enterprise admin still sees the
// "open" state + an upgrade prompt.

// Generous upper bounds — there are only ~40 apps, and a rule targets directory
// principals — so a request past these is malformed, not legitimate. Caps the
// transaction size (defense-in-depth; the route is already admin + enterprise).
const MAX_PROVIDERS_PER_RULE = 200;
const MAX_IDENTITIES_PER_RULE = 1000;
const MAX_RULES = 1000;

const availabilityRuleSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().max(200).nullish(),
  userIds: z.array(z.string().min(1)).max(MAX_IDENTITIES_PER_RULE),
  groupIds: z.array(z.string().min(1)).max(MAX_IDENTITIES_PER_RULE),
  providers: z.array(z.string().min(1)).max(MAX_PROVIDERS_PER_RULE),
});

const setAppAvailabilitySchema = z.object({
  mode: z.enum(["open", "restricted"]),
  rules: z.array(availabilityRuleSchema).max(MAX_RULES),
});

export const orgAppAvailabilityRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("app_availability"));
  app.use("*", auth({ requireWorkspace: false, role: "admin" }));

  app.get("/", async (c) => {
    const authCtx = c.get("auth");
    return c.json(await getAppAvailability(authCtx.organizationId));
  });

  app.put("/", async (c) => {
    const authCtx = c.get("auth");
    const parsed = setAppAvailabilitySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        parsed.error.issues[0]?.message ?? "Invalid request body",
      );
    }

    // Gate the Enterprise feature only when the org is actually USING it —
    // turning restriction on, or storing rules. Resetting to plain "open" with
    // no rules is always allowed, so an org that has downgraded can never get
    // locked into a restriction it can no longer edit its way out of.
    if (parsed.data.mode === "restricted" || parsed.data.rules.length > 0) {
      await assertFeatureAllowed(authCtx.organizationId, "groups");
    }

    const result = await withAudit(
      () =>
        setAppAvailability(authCtx.organizationId, parsed.data, authCtx.userId),
      (r) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        service: AUDIT_SERVICES.APP_AVAILABILITY,
        source: AUDIT_SOURCE.API,
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { mode: r.mode, ruleCount: r.rules.length },
      }),
    );
    return c.json(result);
  });

  return app;
};
