import { cache } from "react";
import { db } from "@onecli/db";
import { userIsOrgAdmin } from "@onecli/api/services/workspace-access-check";
import {
  canManageWorkspace,
  getUserRole,
  visibleWorkspacesWhere,
} from "@onecli/api/ee/services/authorization-service";
import { getRunnerAvailability } from "@onecli/api/services/runner-service";
import { CAPS } from "@/lib/env";
import { getServerSession } from "@/lib/auth/server";
import { requireAccessibleWorkspace } from "@/lib/workspaces/workspace-access";
import {
  isSettingsPageId,
  settingsPage,
  visibleSettingsPages,
  type SettingsPageId,
  type SettingsViewer,
} from "./pages";

/**
 * Everything the `@settings` slot page needs to decide what to render, in
 * one request-cached read: who is looking, and which page `?settings=`
 * names.
 */

export interface SettingsScope {
  organizationId: string;
  /** Set on a `/w/<id>` URL; the modal's workspace pages act on it. */
  workspaceId?: string;
}

interface SettingsModalRequest {
  /** The page to show, or null: the param is missing, unknown, or names a
   *  page this viewer may not open (the nav never offered it either). */
  page: SettingsPageId | null;
  viewer: SettingsViewer;
  /** Workspaces the viewer may switch the modal to (the picker, >1 only). */
  workspaces: { id: string; name: string | null }[];
}

/** The signed-in user's id, read once per request. */
const sessionUserId = cache(async (): Promise<string | null> => {
  const session = await getServerSession();
  if (!session) return null;
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  return user?.id ?? null;
});

const viewerFor = cache(
  async (scope: SettingsScope): Promise<SettingsViewer | null> => {
    const userId = await sessionUserId();
    if (!userId) return null;
    const membership = await db.organizationMember.findFirst({
      where: {
        organizationId: scope.organizationId,
        userId,
        status: { not: "suspended" },
      },
      select: { userId: true },
    });
    if (!membership) return null;
    // Fail closed, like the admin layout: an error reads as "not allowed".
    const [isAdmin, manage, runners] = await Promise.all([
      userIsOrgAdmin(userId, scope.organizationId).catch(() => false),
      scope.workspaceId
        ? canManageWorkspace(userId, scope.workspaceId).catch(() => false)
        : Promise.resolve(false),
      // The nav hides Slack when no runner is registered (§3.13); the
      // same read, server side.
      getRunnerAvailability().catch(() => ({ registered: false })),
    ]);
    return {
      hasWorkspace: Boolean(scope.workspaceId),
      canManageWorkspace: manage,
      isAdmin,
      billing: CAPS.billing,
      hosted: runners.registered,
    };
  },
);

/** The workspaces the picker offers: the ones this viewer may open, by the
 *  same predicate the workspaces list and the org landing use, so a member
 *  never sees the name of a workspace nobody shared with them. */
const visibleWorkspaces = cache(async (organizationId: string) => {
  const userId = await sessionUserId();
  if (!userId) return [];
  const role = await getUserRole(userId, organizationId);
  if (!role) return [];
  return db.workspace.findMany({
    where: visibleWorkspacesWhere(userId, organizationId, role),
    select: { id: true, name: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
});

/**
 * Resolve a `?settings=` request for the given scope. Returns null when the
 * modal must not render at all: the param does not open a modal page for
 * this viewer.
 */
export const resolveSettingsModal = async (
  scope: SettingsScope,
  searchParams: Promise<Record<string, string | string[] | undefined>>,
): Promise<SettingsModalRequest | null> => {
  const raw = (await searchParams).settings;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  if (!isSettingsPageId(requested)) return null;
  if (scope.workspaceId) {
    // Proves access (or redirects) before any page body runs under this
    // workspace, the same way the workspace layout does. Cached per request.
    await requireAccessibleWorkspace(scope.workspaceId);
  }
  const viewer = await viewerFor(scope);
  if (!viewer) return null;
  const visible = visibleSettingsPages(viewer);
  if (!visible.some((p) => p.id === requested)) return null;
  const meta = settingsPage(requested);
  const workspaces =
    // Every page under the Workspace heading offers the picker (they all
    // act on one workspace), and only when there is something to pick.
    meta.section === "Workspace"
      ? await visibleWorkspaces(scope.organizationId)
      : [];
  return {
    page: requested,
    viewer,
    workspaces: workspaces.length > 1 ? workspaces : [],
  };
};
