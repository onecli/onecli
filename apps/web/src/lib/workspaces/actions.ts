"use server";

import { headers } from "next/headers";
import { getServerSession } from "@/lib/auth/server";
import { getUserDefaultOrgId } from "@/lib/auth/default-org";
import { db } from "@onecli/db";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import { activeMembershipWhere } from "@onecli/api/services/organization-service";
import { enforceSsoSession } from "@onecli/api/ee/sso/sso-enforcement";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { setDefaultOrgCookie } from "@/lib/auth/set-active-scope";
import {
  ensureUserDefaultOrgAndWorkspace,
  listWorkspaces,
  createWorkspace,
  type WorkspaceListItem,
} from "@onecli/api/ee/services/workspace-service";
import { getUserRole } from "@onecli/api/ee/services/authorization-service";
import {
  getWorkspaceQuota,
  assertCanCreateWorkspace,
} from "@onecli/api/ee/services/quota-service";
import { safeAction, type ActionResult } from "@/lib/safe-action";
import {
  resolveDefaultHome,
  resolveOrgHome,
} from "@/lib/dashboard/home-landing";
import { resolveWorkspaceLanding } from "./workspace-landing";

const requireUser = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, email: true, name: true },
  });
  if (!user) throw new Error("User not found");
  // Server actions are POST endpoints any authenticated session can invoke —
  // mirror the /v1/auth/session "require SSO" enforcement here too.
  const denial = await enforceSsoSession(session, user);
  if (denial) throw new Error(denial.error);
  return user;
};

/**
 * The page the user's active workspace opens on, for client-side redirects
 * after sign-in and onboarding: its first agent (or agent creation), the
 * page the bare `/w/<id>` forwards to, so the redirect lands in one hop.
 * It still starts `/w/<id>`, which is how the onboarding flow reads the
 * workspace off it. Falls back to `/create-org` when the user has no
 * workspace yet (shouldn't happen post-signup but safe to handle).
 */
export const getActiveWorkspacePath = async (): Promise<string> => {
  const user = await requireUser();
  const defaultWorkspace = await ensureUserDefaultOrgAndWorkspace(
    user.id,
    user.email,
  );

  if (!defaultWorkspace) return "/create-org";

  return resolveWorkspaceLanding(defaultWorkspace.id);
};

/**
 * Returns all workspaces the user has access to (across their organizations).
 * Lazily ensures the user has at least one Organization + Workspace on first
 * call.
 */
export const getWorkspaces = async (): Promise<WorkspaceListItem[]> => {
  const user = await requireUser();
  await ensureUserDefaultOrgAndWorkspace(user.id, user.email);
  const { organizationId } = await resolveOrgContext();
  const role = await getUserRole(user.id, organizationId);
  return listWorkspaces(user.id, organizationId, role);
};

export type WorkspaceQuota = {
  current: number;
  limit: number;
  plan: string;
  memberCount: number;
  // Always the real org-wide workspace count (unlike `current`, which
  // `getWorkspaceQuota` reports as 0 for unlimited-workspaces plans). Used for the
  // org-scoped "can't delete the org's only workspace" guard on the workspaces list.
  workspaceCount: number;
  organizationId: string;
};

export const getWorkspaceQuotaAction = async (): Promise<WorkspaceQuota> => {
  const user = await requireUser();
  await ensureUserDefaultOrgAndWorkspace(user.id, user.email);

  const { organizationId } = await resolveOrgContext();

  const [quota, memberCount, workspaceCount] = await Promise.all([
    getWorkspaceQuota(organizationId),
    db.organizationMember.count({ where: { organizationId } }),
    db.workspace.count({ where: { organizationId } }),
  ]);
  return { ...quota, memberCount, workspaceCount, organizationId };
};

/**
 * Create a new workspace and set the active workspace cookie.
 * Returns the new workspace ID so the client can navigate.
 */
export const createWorkspaceAction = async (
  name: string,
): Promise<ActionResult<{ workspaceId: string }>> => {
  return safeAction(async () => {
    const user = await requireUser();
    await ensureUserDefaultOrgAndWorkspace(user.id, user.email);

    const { organizationId } = await resolveOrgContext();

    const memberCount = await db.organizationMember.count({
      where: { organizationId },
    });

    if (memberCount <= 1) {
      await assertCanCreateWorkspace(organizationId);
    }

    const workspace = await withAudit(
      () => createWorkspace(user.id, user.email, name, organizationId),
      (p) => ({
        workspaceId: p.id,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.WORKSPACE,
        metadata: { name: p.name, organizationId },
      }),
    );

    await setDefaultOrgCookie(organizationId);

    return { workspaceId: workspace.id };
  });
};

export interface UserOrganization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export const getUserOrganizations = async (): Promise<UserOrganization[]> => {
  const user = await requireUser();
  const memberships = await db.organizationMember.findMany({
    where: { userId: user.id, ...activeMembershipWhere },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    role: m.role,
  }));
};

export const getActiveOrganizationId = async (): Promise<string | null> => {
  // This backs the sidebar chrome (org switcher, account menu), which mounts
  // on EVERY dashboard page — including ones whose URL carries no org context:
  // bare /org while its redirect is still streaming, and /account. The
  // path-derived headers only exist on /org/<id>/... and /w/<id>/... URLs, so
  // off them the strict resolver would throw ("X-Organization-Id header is
  // required") and the action would answer 500 — the broken first-open frame
  // a fresh install showed while /org compiled. Answer those pages with the
  // same cookie-validated default org the /org index resolves to instead.
  const headerStore = await headers();
  if (
    headerStore.get("x-organization-id") ||
    headerStore.get("x-workspace-id")
  ) {
    const { organizationId } = await resolveOrgContext();
    return organizationId;
  }
  return getUserDefaultOrgId();
};

/**
 * Where a switch to this workspace lands (its first agent, or the
 * create-agent page): the page a bare `/w/<id>` would forward to, handed
 * back instead of redirected to, so a caller can go there in one hop.
 */
export const workspaceLandingAction = async (
  workspaceId: string,
): Promise<string> => resolveWorkspaceLanding(workspaceId);

/**
 * Where "go to this org" lands (its first visible workspace's first agent,
 * else its workspaces page), handed back so the org switcher, a deleted
 * workspace and the like go there in one hop, never through the org's
 * workspaces URL, which renders on the way before forwarding. Fenced by
 * `resolveOrgLanding`: a foreign org id gets its workspaces URL, whose
 * layout turns the caller away, never one of its agents.
 */
export const orgLandingAction = async (orgId: string): Promise<string> =>
  resolveOrgHome(orgId);

/**
 * Where a signed-in visitor lands with no URL of their own (the home page):
 * their default org's home in one hop, or null when they belong to no org.
 */
export const defaultLandingAction = async (): Promise<string | null> =>
  resolveDefaultHome();
