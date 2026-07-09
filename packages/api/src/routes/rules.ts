import { Hono } from "hono";
import { z } from "zod";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import {
  listPolicyRules,
  getPolicyRule,
  createPolicyRule,
  updatePolicyRule,
  deletePolicyRule,
  listAppPermissionRules,
  setAppPermissionsService,
  buildAppPermissionStates,
  resolvePermissionChanges,
  countOverlappingRulesForApp,
  providerDisplayName,
} from "../services/policy-rule-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import { getAppPermissionDefinition } from "../apps/app-permissions";
import {
  createPolicyRuleSchema,
  updatePolicyRuleSchema,
  ruleConditionSchema,
  type PolicyMode,
} from "../validations/policy-rule";

const setPermissionsSchema = z.object({
  changes: z
    .array(
      z.object({
        toolId: z.string().min(1),
        permission: z.enum(["allow", "manual_approval", "block", "inherit"]),
      }),
    )
    .min(1),
  conditions: z.array(ruleConditionSchema).max(10).optional(),
  agentId: z.string().min(1).optional(),
});

export const ruleRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /rules
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const rules = await listPolicyRules({
      projectId: requireProjectId(auth),
      organizationId: auth.organizationId,
    });
    return c.json(rules);
  });

  // ── GET /rules/permissions/:provider ── layered app-permission states ──
  app.get("/permissions/:provider", async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider");
    const rules = await listAppPermissionRules(
      { projectId: requireProjectId(auth) },
      provider,
    );
    return c.json(buildAppPermissionStates(rules));
  });

  // ── PUT /rules/permissions/:provider ── set app permissions (layered) ──
  // Accepts the agent-layer semantics: `agentId` targets one agent's override
  // layer, and "inherit" deletes that agent's rows for a tool. The layered
  // reconciliation itself lives in setAppPermissionsService.
  app.put("/permissions/:provider", async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider");
    const def = getAppPermissionDefinition(provider);
    if (!def) {
      return c.json(
        { error: `No permission definition for provider: ${provider}` },
        400,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = setPermissionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const resolution = resolvePermissionChanges(def, parsed.data.changes);
    if ("unknownToolId" in resolution) {
      return c.json(
        { error: `Unknown tool: ${resolution.unknownToolId}` },
        400,
      );
    }

    const projectId = requireProjectId(auth);
    const agentId = parsed.data.agentId;
    const appName = providerDisplayName(provider);

    const [org, agent] = await Promise.all([
      db.organization.findUniqueOrThrow({
        where: { id: auth.organizationId },
        select: { policyMode: true },
      }),
      agentId
        ? db.agent.findFirst({
            where: { id: agentId, projectId },
            select: { name: true },
          })
        : null,
    ]);

    const result = await withAudit(
      () =>
        setAppPermissionsService(
          { projectId },
          provider,
          appName,
          resolution.resolved,
          parsed.data.conditions,
          org.policyMode as PolicyMode,
          agentId,
        ),
      (setResult) => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.RULE,
        source: AUDIT_SOURCE.API,
        metadata: {
          source: "app_permission",
          provider,
          agentId: agentId ?? null,
          ...(agent ? { agentName: agent.name } : {}),
          changes: parsed.data.changes,
          ...setResult,
        },
      }),
    );
    return c.json(result);
  });

  // ── GET /rules/overlap/:provider ── custom rules overlapping an app ────
  app.get("/overlap/:provider", async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider");
    const count = await countOverlappingRulesForApp(
      { projectId: requireProjectId(auth) },
      provider,
    );
    return c.json({ count });
  });

  // GET /rules/:ruleId
  app.get("/:ruleId", async (c) => {
    const auth = c.get("auth");
    const ruleId = c.req.param("ruleId");
    const rule = await getPolicyRule(
      { projectId: requireProjectId(auth) },
      ruleId,
    );
    return c.json(rule);
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

    const projectId = requireProjectId(auth);
    const rule = await withAudit(
      () => createPolicyRule({ projectId }, parsed.data),
      (created) => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.RULE,
        source: AUDIT_SOURCE.API,
        metadata: {
          ruleId: created.id,
          name: parsed.data.name,
          action: parsed.data.action,
        },
      }),
    );
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

    const projectId = requireProjectId(auth);
    await withAudit(
      () => updatePolicyRule({ projectId }, ruleId, parsed.data),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.RULE,
        source: AUDIT_SOURCE.API,
        metadata: { ruleId },
      }),
    );
    return c.json({ success: true });
  });

  // DELETE /rules/:ruleId
  app.delete("/:ruleId", async (c) => {
    const auth = c.get("auth");
    const ruleId = c.req.param("ruleId");
    const projectId = requireProjectId(auth);
    await withAudit(
      () => deletePolicyRule({ projectId }, ruleId),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.RULE,
        source: AUDIT_SOURCE.API,
        metadata: { ruleId },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
