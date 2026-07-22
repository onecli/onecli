import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers";
import type { ResourceScope } from "../services/resource-scope";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import { policyEditingEnabled } from "../lib/policy-flags";
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
// reorder), a terminal `/default`, and a `/publish` action. The project and org
// routers share these handlers, differing only in scope + auth. Inert in step 2.

interface PolicyRouteScope {
  /** Resolve the write/read scope from the request's auth context. */
  resolveScope: (auth: AuthContext) => ResourceScope;
  /** The scope keys the audit log + gateway-cache flush key off. */
  auditScope: (auth: AuthContext) => {
    projectId?: string;
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
  // Gate the mutating methods behind the editing flag; reads (and OPTIONS/HEAD
  // preflight) stay open.
  const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  app.use("*", async (c, next) => {
    if (MUTATING.has(c.req.method) && !policyEditingEnabled()) {
      throw new ServiceError(
        "FORBIDDEN",
        "Policy editing is not enabled for this deployment yet.",
      );
    }
    return next();
  });

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
    return c.json(rule, 201);
  });

  // Registered before /rules/:id so "order" is not captured as an id.
  app.put("/rules/order", async (c) => {
    const auth = c.get("auth");
    const { orderedIds } = parse(reorderPolicyRulesSchema, await jsonBody(c));
    const rules = await withAudit(
      () => reorderPolicyRules(cfg.resolveScope(auth), orderedIds),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { reorder: true, count: orderedIds.length },
      }),
    );
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
      () => updatePolicyRule(cfg.resolveScope(auth), id, input),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { ruleId: id },
      }),
    );
    return c.json(rule);
  });

  app.delete("/rules/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    await withAudit(
      () => deletePolicyRule(cfg.resolveScope(auth), id),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { ruleId: id },
      }),
    );
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
      () => setPolicyDefaultAction(cfg.resolveScope(auth), action),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { default: true, defaultAction: action },
      }),
    );
    return c.json(rule);
  });

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
    return c.json(result);
  });

  // Who last applied this scope's policy, and when — null when never published.
  app.get("/last-publish", async (c) => {
    const auth = c.get("auth");
    return c.json(await getLastPublish(cfg.resolveScope(auth)));
  });
};

/** Project-scoped policy routes: /v1/policy/* (blanket project auth). */
export const policyRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);
  registerPolicyRoutes(app, {
    resolveScope: (auth) => ({ projectId: requireProjectId(auth) }),
    auditScope: (auth) => ({ projectId: auth.projectId }),
  });
  return app;
};
