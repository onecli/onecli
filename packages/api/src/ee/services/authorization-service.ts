import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { ROLE_HIERARCHY } from "../../providers";
import type { OrgRole, WorkspaceAccessChecker } from "../../providers";
import { CAPS } from "../../lib/env";

export type { OrgRole };

/**
 * The role of a user's ACTIVE membership — suspended members read as
 * non-members (null), which is what closes every role gate, the org-key
 * re-check, and the workspace-key re-check in one place.
 */
export const getUserRole = async (
  userId: string,
  organizationId: string,
): Promise<OrgRole | null> => {
  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    select: { role: true, status: true },
  });

  if (!membership || membership.status === "suspended") return null;
  return membership.role as OrgRole;
};

/**
 * Pure hierarchy check: does `role` meet or exceed `minimumRole`? A null role
 * (not a member) never satisfies any threshold. This is the single place the
 * "role meets threshold" comparison lives on the cloud side, so `requireRole`
 * and any other cloud caller stay consistent with ROLE_HIERARCHY. The API auth
 * middleware enforces the same rule independently (it cannot import cloud code).
 */
export const hasMinimumRole = (
  role: OrgRole | null,
  minimumRole: OrgRole,
): boolean =>
  role !== null && ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minimumRole];

export const requireRole = async (
  userId: string,
  organizationId: string,
  minimumRole: OrgRole,
): Promise<OrgRole> => {
  const role = await getUserRole(userId, organizationId);

  // The non-RBAC edition (oss) enforces no roles — every member passes. This
  // is the single choke point, so all callers (requireOrgAdminContext, the team
  // actions, route guards, …) stay consistent without each re-checking `rbac`.
  if (!CAPS.rbac) return role ?? minimumRole;

  if (!role) {
    throw new ServiceError("FORBIDDEN", "Not a member of this organization");
  }

  if (!hasMinimumRole(role, minimumRole)) {
    throw new ServiceError("FORBIDDEN", "Insufficient permissions");
  }

  return role;
};

// ── Workspace access policy ───────────────────────────────────────────────
// Single source of truth for "who can see/use/manage which workspaces". Two
// distinct questions live here:
//   • ACCESS (use a workspace): a direct/group WorkspaceAccess binding OR an
//     admin/owner of its org. Bindings are the sole human usage gate — step 13b
//     dropped the creator arm; org-admins keep control-plane reach.
//   • MANAGE (rename/share/delete): an OWNER-role WorkspaceAccess binding OR an org
//     admin/owner (step 13c). Management rides the binding's role, so it is
//     transferable and revocable; a plain (member) binding grants use, not
//     management. Group bindings stay role-less in v1 (org-admin is the override).

/**
 * Whether a role grants org-wide workspace access (admin or owner). Used as the
 * one place that decides the "admins see all" rule so UI, API, and the auth
 * middleware stay in lockstep.
 */
export const canManageAllWorkspaces = (role: OrgRole | null): boolean =>
  // The non-RBAC edition (oss) doesn't scope workspaces by role — everyone in
  // the org may manage all of them (the org itself is the trust boundary).
  !CAPS.rbac || (role !== null && ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin);

/**
 * `Workspace.where` OR-arms matching the workspaces a user is granted through a
 * WorkspaceAccess binding — either directly (`userId`) or through a group they
 * belong to. Callers OR these with the org-admin arm — together the sole usage
 * gate since the 13b creator-arm drop.
 */
export const workspaceAccessBindingArms = (
  userId: string,
): Prisma.WorkspaceWhereInput[] => [
  { accessBindings: { some: { userId } } },
  { accessBindings: { some: { group: { members: { some: { userId } } } } } },
];

/**
 * Whether a user holds a WorkspaceAccess binding on a workspace — directly or via a
 * group they are a member of. The single-workspace counterpart to
 * `workspaceAccessBindingArms`.
 *
 * The single definition on the API side: the shared predicates in
 * `services/workspace-access-check.ts` reach it through the injected
 * `WorkspaceAccessChecker` (`eeWorkspaceAccessChecker` below), so no shared
 * mirror exists anymore. The gateway's `crate::ee::rbac::user_can_manage_workspace`
 * mirrors these semantics in SQL — keep the two in lockstep; a divergence
 * could open a suspended-member access leak.
 */
export const hasWorkspaceAccessBinding = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const binding = await db.workspaceAccess.findFirst({
    where: {
      workspaceId,
      OR: [{ userId }, { group: { members: { some: { userId } } } }],
    },
    select: { id: true },
  });
  return binding !== null;
};

/**
 * The licensed implementation behind the shared workspace-access predicates
 * (`services/workspace-access-check.ts`), injected through the
 * `workspaceAccessChecker` provider slot by `ensureEditionDefaults()` on cloud
 * and on a licensed self-host. The semantics are the RBAC access law:
 *
 * - Only an ACTIVE member can reach anything — a suspended/removed member
 *   reads as no-role and is denied, and a stale binding never rescues them
 *   (the binding check lives INSIDE the active-member gate — the suspension
 *   invariant; keep the ordering).
 * - An org admin/owner passes outright; a member passes iff they hold a
 *   WorkspaceAccess binding (direct or via a group).
 */
export const eeWorkspaceAccessChecker: WorkspaceAccessChecker = {
  canAccessWorkspaceAsUser: async (userId, workspace) => {
    const role = await getUserRole(userId, workspace.organizationId);
    if (!role) return false;
    if (hasMinimumRole(role, "admin")) return true;
    return hasWorkspaceAccessBinding(userId, workspace.id);
  },
  userIsOrgAdmin: async (userId, organizationId) => {
    const role = await getUserRole(userId, organizationId);
    return hasMinimumRole(role, "admin");
  },
};

/**
 * Whether a user holds an OWNER-role WorkspaceAccess binding on a workspace — the
 * management grant since step 13c. User bindings only: a group binding never
 * confers management in v1 (org-admin is the standing override). The management
 * counterpart to `hasWorkspaceAccessBinding` (usage), role-scoped and direct-user.
 */
export const hasWorkspaceOwnerBinding = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const binding = await db.workspaceAccess.findFirst({
    where: { workspaceId, userId, role: "owner" },
    select: { id: true },
  });
  return binding !== null;
};

/**
 * Prisma `where` fragment for the workspaces a user may see in an organization:
 * all of them for admins/owners; for members, the ones shared with them through
 * a WorkspaceAccess binding (direct or via a group). Usage is bindings-only since
 * step 13b — the creator arm was dropped.
 *
 * This fragment is status-blind — it never checks suspension. Its callers must
 * pass an `organizationId` the user is an ACTIVE member of (every current caller
 * resolves it through `activeMembershipWhere`), so a suspended member's bound
 * workspaces are already out of scope. A caller that passes a suspended user's org
 * plus a null role would leak them — keep the active-org contract.
 */
export const visibleWorkspacesWhere = (
  userId: string,
  organizationId: string,
  role: OrgRole | null,
): Prisma.WorkspaceWhereInput =>
  canManageAllWorkspaces(role)
    ? { organizationId }
    : {
        organizationId,
        OR: workspaceAccessBindingArms(userId),
      };

/**
 * Whether a user may ACCESS (use) a single workspace: they hold a WorkspaceAccess
 * binding (direct or via a group), or they are an admin/owner of its
 * organization. Bindings are the sole usage gate since step 13b (the creator arm
 * was dropped). Returns false for workspaces outside the user's organizations, so
 * callers can 404 without leaking existence.
 */
export const canAccessWorkspace = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      // Suspended members read as non-members here — this relation filter is what
      // keeps a suspended binding-holder out (the binding query below is
      // status-blind, so suspension must be enforced by this gate).
      organization: {
        members: { some: { userId, status: { not: "suspended" } } },
      },
    },
    select: { organizationId: true },
  });
  if (!workspace) return false;
  if (await hasWorkspaceAccessBinding(userId, workspaceId)) return true;
  const role = await getUserRole(userId, workspace.organizationId);
  return canManageAllWorkspaces(role);
};

/**
 * Whether a user may MANAGE a single workspace (rename, share, delete): they hold
 * an OWNER-role WorkspaceAccess binding, or they are an admin/owner of its
 * organization (step 13c). A plain (member) binding grants use, not management —
 * being shared a workspace does not let you administer it. The org-active-member
 * filter runs first, so a suspended owner is denied. Returns false for workspaces
 * outside the user's organizations.
 */
export const canManageWorkspace = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const workspace = await db.workspace.findFirst({
    where: {
      id: workspaceId,
      organization: {
        members: { some: { userId, status: { not: "suspended" } } },
      },
    },
    select: { organizationId: true },
  });
  if (!workspace) return false;
  // Check the org role first: admins/owners manage every workspace, and the
  // non-RBAC edition (oss) manages org-wide — so those paths
  // skip the binding query. Otherwise management rides an owner-role binding.
  const role = await getUserRole(userId, workspace.organizationId);
  if (canManageAllWorkspaces(role)) return true;
  return hasWorkspaceOwnerBinding(userId, workspaceId);
};
