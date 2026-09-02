"use server";

import "@/lib/init/server";
import { headers } from "next/headers";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import {
  activeMembershipWhere,
  findUserDefaultWorkspace,
  ensureUserOrganization,
} from "@onecli/api/services/organization-service";
import {
  canManageAllWorkspaces,
  getUserRole,
  hasWorkspaceAccessBinding,
  requireRole,
} from "@onecli/api/ee/services/authorization-service";
import {
  IDENTITY_CONFLICT_ERROR,
  resolveIdentityConflict,
} from "@onecli/api/lib/identity-conflict";
import { ensureSsoJitMembership } from "@onecli/api/ee/sso/jit-service";
import { enforceSsoSession } from "@onecli/api/ee/sso/sso-enforcement";

export interface UserContext {
  userId: string;
  userEmail: string;
  organizationId: string;
  workspaceId: string;
}

export interface OrgContext {
  userId: string;
  userEmail: string;
  organizationId: string;
}

export interface OrgContextWithRole extends OrgContext {
  role: string;
}

const userSelect = {
  id: true,
  email: true,
  organizationMemberships: {
    // Suspended memberships are invisible to the session — the org drops out
    // of memberOrgIds, so every downstream access check denies naturally.
    where: activeMembershipWhere,
    select: { organizationId: true },
    orderBy: { createdAt: "asc" as const },
  },
};

const resolveAuthenticatedUser = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  let user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: userSelect,
  });

  if (!user && session.email) {
    const existedByEmail = await db.user.findUnique({
      where: { email: session.email },
      select: { id: true, email: true, externalAuthId: true },
    });

    if (existedByEmail && existedByEmail.externalAuthId !== session.id) {
      const decision = await resolveIdentityConflict(existedByEmail, session);
      if (decision === "reject") {
        throw new Error(IDENTITY_CONFLICT_ERROR);
      }
    }

    const dbUser = await db.user.upsert({
      where: { email: session.email },
      create: {
        externalAuthId: session.id,
        email: session.email,
        name: session.name,
        lastLoginAt: new Date(),
      },
      update: {
        externalAuthId: session.id,
        lastLoginAt: new Date(),
      },
      select: { id: true, email: true, name: true },
    });

    // Mirror the /v1/auth/session ordering: SSO JIT membership runs before
    // the default-workspace check so a just-joined org satisfies it and the
    // personal-org bootstrap below self-skips.
    await ensureSsoJitMembership(session, dbUser);

    if (!existedByEmail) {
      const defaultWorkspace = await findUserDefaultWorkspace(dbUser.id);
      if (!defaultWorkspace) {
        await ensureUserOrganization(
          dbUser.id,
          dbUser.email,
          dbUser.name ?? undefined,
        );
      }
    }

    user = await db.user.findUnique({
      where: { id: dbUser.id },
      select: userSelect,
    });
  }

  if (!user) throw new Error("User not found");

  // Mirror the /v1/auth/session enforcement (enterprise "require SSO") —
  // OUTSIDE the slow-path block above, so existing users (found directly by
  // externalAuthId) are covered too. Server actions/RSC surface the message
  // as a thrown error; the login page owns the richer 401 UX.
  const denial = await enforceSsoSession(session, {
    id: user.id,
    email: user.email,
  });
  if (denial) throw new Error(denial.error);

  if (user.organizationMemberships.length === 0)
    throw new Error("No organization found");

  return user;
};

const resolveWorkspaceFromHeaders = async (
  memberOrgIds: string[],
): Promise<{ organizationId: string; workspaceId: string } | null> => {
  const headerStore = await headers();
  const headerWorkspaceId = headerStore.get("x-workspace-id");
  if (!headerWorkspaceId) return null;

  const workspace = await db.workspace.findFirst({
    where: {
      id: headerWorkspaceId,
      organizationId: { in: memberOrgIds },
    },
    select: { id: true, organizationId: true },
  });

  return workspace
    ? { organizationId: workspace.organizationId, workspaceId: workspace.id }
    : null;
};

export interface ResolveOptions {
  fallbackToDefault?: boolean;
}

export const resolveWorkspaceContext = async (
  options?: ResolveOptions,
): Promise<UserContext> => {
  const [user, headerStore] = await Promise.all([
    resolveAuthenticatedUser(),
    headers(),
  ]);
  const memberOrgIds = user.organizationMemberships.map(
    (m) => m.organizationId,
  );
  const headerWorkspaceId = headerStore.get("x-workspace-id");

  if (headerWorkspaceId) {
    // Workspace access mirrors the API auth middleware (`resolveWorkspaceId`) and the
    // cloud authorization service (`canAccessWorkspace`): a member may target a
    // workspace shared with them through a WorkspaceAccess binding (direct or via a
    // group); admins/owners may target any workspace in their org. Bindings are the
    // sole usage gate since step 13b — the creator arm was dropped. Keeping this
    // in lockstep is what lets workspace sharing work for server actions, not just
    // API-client calls. (`memberOrgIds` is active-only, so suspension is already
    // handled upstream.)
    const workspace = await db.workspace.findFirst({
      where: {
        id: headerWorkspaceId,
        organizationId: { in: memberOrgIds },
      },
      select: { id: true, organizationId: true },
    });
    if (
      workspace &&
      ((await hasWorkspaceAccessBinding(user.id, workspace.id)) ||
        canManageAllWorkspaces(
          await getUserRole(user.id, workspace.organizationId),
        ))
    ) {
      return {
        userId: user.id,
        userEmail: user.email,
        organizationId: workspace.organizationId,
        workspaceId: workspace.id,
      };
    }
  }

  if (options?.fallbackToDefault) {
    const defaultWorkspace = await findUserDefaultWorkspace(user.id);
    // `findUserDefaultWorkspace` returns the user's oldest CREATED workspace, but
    // since step 13b creating a workspace no longer implies access — gate the
    // fallback on a WorkspaceAccess binding (direct/group) or org-admin, exactly
    // like the header path above, so this branch can't smuggle back the dropped
    // creator arm. Every create path seeds the creator's binding, so a real
    // onboarding user always passes; a creator whose binding was revoked falls
    // through to the error below.
    if (
      defaultWorkspace &&
      memberOrgIds.includes(defaultWorkspace.organizationId) &&
      ((await hasWorkspaceAccessBinding(user.id, defaultWorkspace.id)) ||
        canManageAllWorkspaces(
          await getUserRole(user.id, defaultWorkspace.organizationId),
        ))
    ) {
      return {
        userId: user.id,
        userEmail: user.email,
        organizationId: defaultWorkspace.organizationId,
        workspaceId: defaultWorkspace.id,
      };
    }
  }

  // Distinguish "no header" from "header pointed at a workspace this user can't
  // access" — the old message claimed the header was missing in both cases,
  // which made an access-denied look like a plumbing bug.
  throw new Error(
    headerWorkspaceId
      ? "Forbidden: no access to the requested workspace"
      : "X-Workspace-Id header is required",
  );
};

export const resolveOrgContext = async (
  options?: ResolveOptions,
): Promise<OrgContext> => {
  const [user, headerStore] = await Promise.all([
    resolveAuthenticatedUser(),
    headers(),
  ]);
  const memberOrgIds = user.organizationMemberships.map(
    (m) => m.organizationId,
  );
  const headerOrgId = headerStore.get("x-organization-id");
  if (headerOrgId && memberOrgIds.includes(headerOrgId)) {
    return {
      userId: user.id,
      userEmail: user.email,
      organizationId: headerOrgId,
    };
  }

  const fromWorkspace = await resolveWorkspaceFromHeaders(memberOrgIds);
  if (fromWorkspace) {
    return {
      userId: user.id,
      userEmail: user.email,
      organizationId: fromWorkspace.organizationId,
    };
  }

  if (options?.fallbackToDefault) {
    const defaultWorkspace = await findUserDefaultWorkspace(user.id);
    if (
      defaultWorkspace &&
      memberOrgIds.includes(defaultWorkspace.organizationId)
    ) {
      return {
        userId: user.id,
        userEmail: user.email,
        organizationId: defaultWorkspace.organizationId,
      };
    }
    // Org context needs membership, not authorship. A member who never
    // created a workspace — directory-provisioned, their seeded workspace since
    // deleted, or their created workspaces living in a younger org — must
    // still resolve; the oldest active membership (memberOrgIds is
    // createdAt-asc) grants nothing the x-organization-id header path
    // wouldn't grant the same member.
    const [oldestMembershipOrgId] = memberOrgIds;
    if (oldestMembershipOrgId) {
      return {
        userId: user.id,
        userEmail: user.email,
        organizationId: oldestMembershipOrgId,
      };
    }
  }

  throw new Error("X-Organization-Id header is required");
};

export const resolveOrgContextWithRole =
  async (): Promise<OrgContextWithRole> => {
    const ctx = await resolveOrgContext();
    const membership = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
        },
      },
      select: { role: true, status: true },
    });
    const role =
      membership && membership.status !== "suspended"
        ? membership.role
        : "member";
    return { ...ctx, role };
  };

// Org-admin gate for server actions. Admin-screen data flows through server
// actions, which compile to POST endpoints any authenticated user can invoke —
// so an admin-only action must authenticate the caller's *role*, not just
// membership, exactly like the API auth middleware does. requireRole throws
// (ServiceError FORBIDDEN) for members and non-members, mirroring the API's
// 403. Drop-in replacement for resolveOrgContext in any admin-only action.
export const requireOrgAdminContext = async (): Promise<OrgContext> => {
  const ctx = await resolveOrgContext();
  await requireRole(ctx.userId, ctx.organizationId, "admin");
  return ctx;
};
