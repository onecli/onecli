import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  listPolicyRules,
  createPolicyRule,
  updatePolicyRule,
  deletePolicyRule,
} from "../services/policy-rule-service";
import {
  createPolicyRuleSchema,
  updatePolicyRuleSchema,
} from "../validations/policy-rule";

export const ruleRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /rules
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const rules = await listPolicyRules(auth.projectId);
    return c.json(rules);
  });

  // POST /rules
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createPolicyRuleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const rule = await createPolicyRule(auth.projectId, parsed.data);
    invalidateGatewayCache(c.req.raw);
    return c.json(rule, 201);
  });

  // PATCH /rules/:ruleId
  app.patch("/:ruleId", async (c) => {
    const auth = c.get("auth");
    const ruleId = c.req.param("ruleId");
    const body = await c.req.json().catch(() => null);
    const parsed = updatePolicyRuleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await updatePolicyRule(auth.projectId, ruleId, parsed.data);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  // DELETE /rules/:ruleId
  app.delete("/:ruleId", async (c) => {
    const auth = c.get("auth");
    const ruleId = c.req.param("ruleId");
    await deletePolicyRule(auth.projectId, ruleId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
