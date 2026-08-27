import { db } from "@onecli/db";
import { IS_CLOUD } from "../../lib/env";
import {
  activeMembershipWhere,
  findUserDefaultWorkspace,
} from "../../services/organization-service";
import { canAccessWorkspaceAsUser } from "../../services/workspace-access-check";

export { canAccessWorkspaceAsUser };

export const resolveUserEmail = async (userId: string): Promise<string> => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return user?.email ?? "";
};

export const resolveOrganizationIdFromWorkspace = async (
  workspaceId: string,
): Promise<string | null> => {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return workspace?.organizationId ?? null;
};

/**
 * The bare active-membership fence, for callers that already hold an
 * organizationId from a NON-membership source (an API key's own org row).
 * Session paths never need this — their org only resolves through the
 * membership-fenced lookups below.
 */
export const hasActiveMembership = async (
  userId: string,
  organizationId: string,
): Promise<boolean> => {
  const membership = await db.organizationMember.findFirst({
    where: { userId, organizationId, ...activeMembershipWhere },
    select: { userId: true },
  });
  return membership !== null;
};

export const resolveOrganizationId = async (
  request: Request,
  userId: string,
): Promise<string | null> => {
  const headerOrgId = request.headers.get("x-organization-id");
  if (!headerOrgId) return null;

  const membership = await db.organizationMember.findFirst({
    where: { userId, organizationId: headerOrgId, ...activeMembershipWhere },
    select: { organizationId: true },
  });

  return membership?.organizationId ?? null;
};

export const resolveWorkspaceId = async (
  request: Request,
  userId: string,
): Promise<string | null> => {
  const headerWorkspaceId = request.headers.get("x-workspace-id");
  if (!headerWorkspaceId) {
    // Cloud never falls back to a default workspace — the web always names the
    // workspace explicitly (from the URL); onprem keeps the header-less fallback
    // for local flows. Mirrors the gateway's session workspace resolution.
    if (IS_CLOUD) return null;
    // An EXPLICIT org scope beats the implicit fallback: an org-scoped call
    // (`x-organization-id`, no workspace) from a multi-org self-host user
    // must resolve the org IT NAMES — the fallback would silently re-scope
    // the request to the first-joined org's workspace, making every other
    // org's pages (and the Slack finish-install bind) read the wrong tenant.
    // The named org is membership-fenced in `resolveOrganizationId`.
    if (request.headers.get("x-organization-id")) return null;
    const fallback = await findUserDefaultWorkspace(userId);
    return fallback?.id ?? null;
  }

  const memberOrgIds = await db.user
    .findUnique({
      where: { id: userId },
      select: {
        organizationMemberships: {
          where: activeMembershipWhere,
          select: { organizationId: true },
        },
      },
    })
    .then((u) => u?.organizationMemberships.map((m) => m.organizationId) ?? []);

  const workspace = await db.workspace.findFirst({
    where: {
      id: headerWorkspaceId,
      organizationId: { in: memberOrgIds },
    },
    select: { id: true, organizationId: true },
  });

  if (!workspace) return null;

  // Multi-org (cloud): a member may only target workspaces they hold a binding on;
  // admins and owners may target any workspace in their org. Non-multi-org editions
  // register no role resolver, so this gate is skipped and any in-org workspace is
  // accepted, as before. Mirrors `canAccessWorkspace` in the EE authz service.
  if (!(await canAccessWorkspaceAsUser(userId, workspace))) return null;

  return workspace.id;
};
