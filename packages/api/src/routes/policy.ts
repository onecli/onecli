import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers";
import type { ResourceScope } from "../services/resource-scope";
import { ServiceError } from "../services/errors";
import { bumpHomeForScope } from "../services/home-sync-service";
import { logger } from "../lib/logger";
import {
  listPolicyRules,
  getPolicyRule,
  createPolicyRule,
  updatePolicyRule,
  deletePolicyRule,
  reorderPolicyRules,
  getPolicyDefault,
  setPolicyDefaultAction,
  publishPolicy,
  getLastPublish,
} from "../services/policy-service";
import {
  createPolicyRuleSchema,
  updatePolicyRuleSchema,
  reorderPolicyRulesSchema,
  setDefaultRuleSchema,
  policyStatusSchema,
} from "../validations/policy";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

// ── Unified policy engine routes (/v1/policy, /v1/org/policy) ───────────────
// A scope's policy is a singleton aggregate: a `/rules` sub-collection (CRUD +
// reorder) and a terminal `/default`. Every write is enforced immediately (the
// service publishes inside the write's transaction). `/publish` and
// `/last-publish` remain only for older CLIs.

interface PolicyRouteScope {
  /** Resolve the write/read scope from the request's auth context. */
  resolveScope: (auth: AuthContext) => ResourceScope;
  /** The scope keys the audit log + gateway-cache flush key off. */
  auditScope: (auth: AuthContext) => {
    workspaceId?: string;
    organizationId?: string;
  };
}

const parse = <S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): z.infer<S> => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      result.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return result.data;
};

const jsonBody = (c: { req: { json: () => Promise<unknown> } }) =>
  c.req.json().catch(() => null);

/** Registers the policy handlers on a router whose auth middleware is already set. */
export const registerPolicyRoutes = (
  app: Hono<ApiEnv>,
  cfg: PolicyRouteScope,
) => {
  const auditBase = (auth: AuthContext) => ({
    ...cfg.auditScope(auth),
    userId: auth.userId,
    userEmail: auth.userEmail,
    service: AUDIT_SERVICES.POLICY,
    source: AUDIT_SOURCE.API,
  });

  app.get("/rules", async (c) => {
    const auth = c.get("auth");
    const raw = c.req.query("status");
    const status = raw === undefined ? "draft" : parse(policyStatusSchema, raw);
    return c.json(await listPolicyRules(cfg.resolveScope(auth), status));
  });

  // A write can attach or detach connections (provider-level grants):
  // re-render the affected agents' connected-apps list. Best-effort, a missed
  // bump self-heals at the next boot. Lives here rather than in the service:
  // home-sync-service already reaches policy-service through the rule loader,
  // so the service cannot import the bump without a cycle.
  const refreshHomes = (auth: AuthContext) =>
    bumpHomeForScope(cfg.resolveScope(auth)).catch((err: unknown) => {
      logger.warn({ err }, "policy write: agent home refresh failed");
    });

  app.post("/rules", async (c) => {
    const auth = c.get("auth");
    const input = parse(createPolicyRuleSchema, await jsonBody(c));
    const rule = await withAudit(
      () => createPolicyRule(cfg.resolveScope(auth), input, auth.userId),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.CREATE,
        metadata: { ruleId: r.id, name: r.name },
      }),
    );
    await refreshHomes(auth);
    return c.json(rule, 201);
  });

  // Registered before /rules/:id so "order" is not captured as an id.
  app.put("/rules/order", async (c) => {
    const auth = c.get("auth");
    const { orderedIds } = parse(reorderPolicyRulesSchema, await jsonBody(c));
    const rules = await withAudit(
      () => reorderPolicyRules(cfg.resolveScope(auth), orderedIds, auth.userId),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { reorder: true, count: orderedIds.length },
      }),
    );
    await refreshHomes(auth);
    return c.json(rules);
  });

  app.get("/rules/:id", async (c) => {
    const auth = c.get("auth");
    return c.json(
      await getPolicyRule(cfg.resolveScope(auth), c.req.param("id")),
    );
  });

  app.patch("/rules/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const input = parse(updatePolicyRuleSchema, await jsonBody(c));
    const rule = await withAudit(
      () => updatePolicyRule(cfg.resolveScope(auth), id, input, auth.userId),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { ruleId: id },
      }),
    );
    await refreshHomes(auth);
    return c.json(rule);
  });

  app.delete("/rules/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    await withAudit(
      () => deletePolicyRule(cfg.resolveScope(auth), id, auth.userId),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { ruleId: id },
      }),
    );
    await refreshHomes(auth);
    return c.body(null, 204);
  });

  app.get("/default", async (c) => {
    const auth = c.get("auth");
    const raw = c.req.query("status");
    const status = raw === undefined ? "draft" : parse(policyStatusSchema, raw);
    return c.json(await getPolicyDefault(cfg.resolveScope(auth), status));
  });

  app.patch("/default", async (c) => {
    const auth = c.get("auth");
    const { action } = parse(setDefaultRuleSchema, await jsonBody(c));
    const rule = await withAudit(
      () => setPolicyDefaultAction(cfg.resolveScope(auth), action, auth.userId),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { default: true, defaultAction: action },
      }),
    );
    await refreshHomes(auth);
    return c.json(rule);
  });

  // Compatibility for older CLIs (`onecli org policy publish`): writes already
  // publish, so this only re-snapshots an identical draft.
  app.post("/publish", async (c) => {
    const auth = c.get("auth");
    const result = await withAudit(
      () => publishPolicy(cfg.resolveScope(auth), auth.userId),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.PUBLISH,
        metadata: { generation: r.generation, ruleCount: r.ruleCount },
      }),
    );
    await refreshHomes(auth);
    return c.json(result);
  });

  // Compatibility for older CLIs (`onecli org policy status`).
  app.get("/last-publish", async (c) => {
    const auth = c.get("auth");
    return c.json(await getLastPublish(cfg.resolveScope(auth)));
  });
};

// The WORKSPACE mounting of this factory retired in attach-model step 6: workspace
// scope has exactly one writer now, the grants API, and `/v1/policy/*` answers
// 410 there (`removedWorkspacePolicyRoutes`). The factory itself stays — the ORG
// mirror (`routes/org-policy.ts`) registers the identical ten handlers with
// an organization scope.
