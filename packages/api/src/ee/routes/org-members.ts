import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import { db } from "@onecli/db";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  updateOrgMemberSchema,
  listOrgMembersQuerySchema,
  createOrgMemberSchema,
} from "../validations/org-members";
import {
  suspendMember,
  reinstateMember,
  setMemberSsoExempt,
  listMembersPage,
  removeMember,
} from "../services/team-service";
import {
  provisionMember,
  findMemberByUserId,
} from "../services/org-directory-service";
import { listGroupsForUser } from "../services/group-service";
import { directoryListQuerySchema } from "../validations/directory";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

const admin = auth({ requireWorkspace: false, role: "admin" });

/**
 * Member lifecycle + policy flags (step 9): suspend/reinstate and the
 * break-glass SSO exemption. One change per PATCH (enforced by the schema)
 * so every audit event describes a single transition. Role changes keep
 * their existing surfaces.
 *
 * Plus the §3.5 directory reads: the members list (the group member
 * picker's data source) and the user→groups reverse lookup. And, from
 * step 12, the first-party provisioning writes — the org-key twin of the
 * SCIM dialect (POST = SCIM POST /Users; DELETE = hard offboarding): same
 * directory core, same validation, one behavior.
 */
export const orgMemberRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("members_directory"));

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    const parsed = listOrgMembersQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(await listMembersPage(authCtx.organizationId, parsed.data));
  });

  app.get("/:userId/groups", admin, async (c) => {
    const authCtx = c.get("auth");
    const parsed = directoryListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query" },
        400,
      );
    }
    return c.json(
      await listGroupsForUser(
        authCtx.organizationId,
        c.req.param("userId"),
        parsed.data,
      ),
    );
  });

  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "sso");

    const body = await c.req.json().catch(() => null);
    const parsed = createOrgMemberSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const result = await withAudit(
      async () => {
        const provisioned = await provisionMember(
          authCtx.organizationId,
          parsed.data.email,
          parsed.data.name ?? null,
        );
        if (!provisioned.created) {
          throw new ServiceError(
            "CONFLICT",
            "This user is already a member of the organization.",
          );
        }
        return provisioned;
      },
      (provisioned) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.MEMBER,
        source: AUDIT_SOURCE.API,
        metadata: {
          targetUserId: provisioned.userId,
          email: provisioned.email,
          userCreated: provisioned.userCreated,
        },
      }),
    );
    return c.json(
      {
        userId: result.userId,
        email: result.email,
        name: result.name,
        role: result.role,
        status: result.status,
        joinedAt: result.joinedAt,
      },
      201,
    );
  });

  app.delete("/:userId", admin, async (c) => {
    const authCtx = c.get("auth");
    const targetUserId = c.req.param("userId");

    // Pre-check with typed errors — team-service removeMember throws plain
    // Errors, which would surface as 500s through the error handler.
    const member = await findMemberByUserId(
      authCtx.organizationId,
      targetUserId,
    );
    if (!member) {
      throw new ServiceError(
        "NOT_FOUND",
        "User is not a member of this organization",
      );
    }
    if (member.role === "owner") {
      throw new ServiceError(
        "BAD_REQUEST",
        "The organization owner cannot be removed",
      );
    }

    await withAudit(
      () => removeMember(authCtx.organizationId, targetUserId),
      (revocation) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.MEMBER,
        source: AUDIT_SOURCE.API,
        metadata: { targetUserId, email: member.email, revocation },
      }),
    );
    return c.body(null, 204);
  });

  app.patch("/:userId", admin, async (c) => {
    const authCtx = c.get("auth");
    const targetUserId = c.req.param("userId");

    const body = await c.req.json().catch(() => null);
    const parsed = updateOrgMemberSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error:
            'Provide exactly one of { status: "active" | "suspended" } or { ssoExempt: boolean }',
        },
        400,
      );
    }
    const change = parsed.data;

    if ("status" in change) {
      const suspending = change.status === "suspended";
      const outcome = await withAudit(
        () =>
          suspending
            ? suspendMember(
                authCtx.organizationId,
                targetUserId,
                authCtx.userId,
              )
            : reinstateMember(authCtx.organizationId, targetUserId),
        (revocation) => ({
          organizationId: authCtx.organizationId,
          userId: authCtx.userId,
          userEmail: authCtx.userEmail,
          action: AUDIT_ACTIONS.UPDATE,
          service: AUDIT_SERVICES.MEMBER,
          source: AUDIT_SOURCE.API,
          // The Cognito side is best-effort — record what actually happened.
          metadata: { targetUserId, status: change.status, revocation },
        }),
      );
      const updated = await db.organizationMember.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: authCtx.organizationId,
            userId: targetUserId,
          },
        },
        select: { userId: true, status: true, ssoExempt: true },
      });
      return c.json({ ...updated, revocation: outcome });
    }

    await withAudit(
      () =>
        setMemberSsoExempt(
          authCtx.organizationId,
          targetUserId,
          change.ssoExempt,
        ),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.MEMBER,
        source: AUDIT_SOURCE.API,
        metadata: { targetUserId, ssoExempt: change.ssoExempt },
      }),
    );
    const updated = await db.organizationMember.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: authCtx.organizationId,
          userId: targetUserId,
        },
      },
      select: { userId: true, status: true, ssoExempt: true },
    });
    return c.json(updated);
  });

  return app;
};
