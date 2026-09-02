import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  listRoleMappings,
  createRoleMapping,
  updateRoleMapping,
  deleteRoleMapping,
  reorderRoleMappings,
  previewRoleMappingImpact,
  memberIdsForGroup,
  allMappedMemberIds,
} from "../services/role-mapping-service";
import { reconcileMemberRoles } from "../services/team-service";
import {
  createRoleMappingSchema,
  updateRoleMappingSchema,
  reorderRoleMappingsSchema,
  previewRoleMappingSchema,
} from "../validations/role-mapping";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

// Group→role mappings (step 15). Admin-only on every route; writes are
// enterprise-gated (reuse the "groups" feature) while the list stays
// plan-ungated so the Groups page can render a locked state. Every write
// runs through withAudit (org gateway-flush) and then applies immediately:
// the affected members' roles are re-resolved on save.
const admin = auth({ requireWorkspace: false, role: "admin" });

export const orgRoleMappingRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("groups"));

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    return c.json(await listRoleMappings(authCtx.organizationId));
  });

  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    const body = await c.req.json().catch(() => null);
    const parsed = createRoleMappingSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const mapping = await withAudit(
      () => createRoleMapping(authCtx.organizationId, parsed.data),
      (m) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.ROLE_MAPPING,
        source: AUDIT_SOURCE.API,
        metadata: {
          roleMappingId: m.id,
          groupId: m.groupId,
          role: m.role,
          priority: m.priority,
        },
      }),
    );

    await reconcileMemberRoles(
      authCtx.organizationId,
      await memberIdsForGroup(authCtx.organizationId, mapping.groupId),
      AUDIT_SOURCE.API,
    );
    return c.json(mapping, 201);
  });

  // Static routes before the `/:id` param routes.
  app.put("/order", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    const body = await c.req.json().catch(() => null);
    const parsed = reorderRoleMappingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const mappings = await withAudit(
      () => reorderRoleMappings(authCtx.organizationId, parsed.data.orderedIds),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.ROLE_MAPPING,
        source: AUDIT_SOURCE.API,
        metadata: { reordered: parsed.data.orderedIds.length },
      }),
    );

    // A reorder can flip the winner for members of multiple mapped groups.
    await reconcileMemberRoles(
      authCtx.organizationId,
      await allMappedMemberIds(authCtx.organizationId),
      AUDIT_SOURCE.API,
    );
    return c.json(mappings);
  });

  app.post("/preview", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    const body = await c.req.json().catch(() => null);
    const parsed = previewRoleMappingSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    return c.json(
      await previewRoleMappingImpact(authCtx.organizationId, parsed.data),
    );
  });

  app.patch("/:id", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");
    const id = c.req.param("id");

    const body = await c.req.json().catch(() => null);
    const parsed = updateRoleMappingSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const mapping = await withAudit(
      () => updateRoleMapping(authCtx.organizationId, id, parsed.data),
      (m) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.ROLE_MAPPING,
        source: AUDIT_SOURCE.API,
        metadata: {
          roleMappingId: m.id,
          groupId: m.groupId,
          role: m.role,
          priority: m.priority,
        },
      }),
    );

    await reconcileMemberRoles(
      authCtx.organizationId,
      await memberIdsForGroup(authCtx.organizationId, mapping.groupId),
      AUDIT_SOURCE.API,
    );
    return c.json(mapping);
  });

  app.delete("/:id", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");
    const id = c.req.param("id");

    const removed = await withAudit(
      () => deleteRoleMapping(authCtx.organizationId, id),
      (r) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.ROLE_MAPPING,
        source: AUDIT_SOURCE.API,
        metadata: { roleMappingId: r.id, groupId: r.groupId },
      }),
    );

    // The group's members re-resolve among their remaining mapped groups (or
    // become unmatched and keep their current role — never stripped).
    await reconcileMemberRoles(
      authCtx.organizationId,
      await memberIdsForGroup(authCtx.organizationId, removed.groupId),
      AUDIT_SOURCE.API,
    );
    return c.body(null, 204);
  });

  return app;
};
