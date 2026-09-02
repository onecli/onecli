import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  listGroups,
  getGroup,
  createGroup,
  renameGroup,
  deleteGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  setGroupMembers,
} from "../services/group-service";
import {
  createGroupSchema,
  updateGroupSchema,
  setGroupMembersSchema,
  listGroupsQuerySchema,
} from "../validations/group";
import { directoryListQuerySchema } from "../validations/directory";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

// The org directory's human-group surface (§3.5 contract): admin-only on
// every route; writes are additionally enterprise-gated ("groups") while
// reads stay plan-ungated so the Groups page can render the locked state.
// Mutations run through withAudit with organizationId, which also fires the
// org-wide gateway-cache flush (a no-op until the enforcement step reads
// these tables — wired now so it can't be forgotten later).
const admin = auth({ requireWorkspace: false, role: "admin" });

export const orgGroupRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("groups"));

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    const parsed = listGroupsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(await listGroups(authCtx.organizationId, parsed.data));
  });

  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");

    const body = await c.req.json().catch(() => null);
    const parsed = createGroupSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const group = await withAudit(
      () => createGroup(authCtx.organizationId, parsed.data.name),
      (g) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.GROUP,
        source: AUDIT_SOURCE.API,
        metadata: { groupId: g.id, name: g.name },
      }),
    );
    return c.json(group, 201);
  });

  app.get("/:groupId", admin, async (c) => {
    const authCtx = c.get("auth");
    return c.json(
      await getGroup(authCtx.organizationId, c.req.param("groupId")),
    );
  });

  app.patch("/:groupId", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");
    const groupId = c.req.param("groupId");

    const body = await c.req.json().catch(() => null);
    const parsed = updateGroupSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const group = await withAudit(
      () => renameGroup(authCtx.organizationId, groupId, parsed.data.name),
      (g) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.GROUP,
        source: AUDIT_SOURCE.API,
        metadata: { groupId: g.id, name: g.name },
      }),
    );
    return c.json(group);
  });

  app.delete("/:groupId", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");
    const groupId = c.req.param("groupId");

    await withAudit(
      () => deleteGroup(authCtx.organizationId, groupId),
      (g) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.GROUP,
        source: AUDIT_SOURCE.API,
        metadata: { groupId: g.id, name: g.name },
      }),
    );
    return c.body(null, 204);
  });

  app.get("/:groupId/members", admin, async (c) => {
    const authCtx = c.get("auth");
    const parsed = directoryListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(
      await listGroupMembers(
        authCtx.organizationId,
        c.req.param("groupId"),
        parsed.data,
      ),
    );
  });

  app.put("/:groupId/members", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");
    const groupId = c.req.param("groupId");

    const body = await c.req.json().catch(() => null);
    const parsed = setGroupMembersSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const result = await withAudit(
      () =>
        setGroupMembers(
          authCtx.organizationId,
          groupId,
          parsed.data.userIds,
          authCtx.userId,
        ),
      (r) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.GROUP,
        source: AUDIT_SOURCE.API,
        metadata: { groupId, added: r.added, removed: r.removed },
      }),
    );
    return c.json(result);
  });

  app.put("/:groupId/members/:userId", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");
    const groupId = c.req.param("groupId");
    const targetUserId = c.req.param("userId");

    await withAudit(
      () =>
        addGroupMember(
          authCtx.organizationId,
          groupId,
          targetUserId,
          authCtx.userId,
        ),
      (r) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.GROUP,
        source: AUDIT_SOURCE.API,
        metadata: { groupId, targetUserId, added: r.added },
      }),
    );
    return c.body(null, 204);
  });

  app.delete("/:groupId/members/:userId", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "groups");
    const groupId = c.req.param("groupId");
    const targetUserId = c.req.param("userId");

    await withAudit(
      () => removeGroupMember(authCtx.organizationId, groupId, targetUserId),
      (r) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.GROUP,
        source: AUDIT_SOURCE.API,
        metadata: { groupId, targetUserId, removed: r.removed },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
