import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { generateWorkspaceId } from "../../lib/ids";
import {
  activeMembershipWhere,
  defaultWorkspaceSeed,
  findUserDefaultWorkspace,
  ensureWorkspaceSeeds,
  slugify,
} from "../../services/organization-service";
import {
  visibleWorkspacesWhere,
  canManageAllWorkspaces,
  workspaceAccessBindingArms,
} from "./authorization-service";
import { invalidateGatewayCacheForKeys } from "../../lib/gateway-invalidate";
import { teardownWorkspacePresences } from "../../services/channels/agent-channel-service";
import type { OrgRole } from "../../providers";

/**
 * Delete all child resources of a workspace inside an existing transaction.
 * Caller is responsible for wrapping in `db.$transaction`.
 */
export const deleteWorkspaceContent = async (
  workspaceId: string,
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
) => {
  await tx.requestLog.deleteMany({ where: { workspaceId } });
  // Workspace-tier skills: the FK is Restrict on purpose — this explicit line
  // is the deletion path, and forgetting it fails the delete loudly.
  // (Agent-tier skills cascade with their agents on the next line.)
  await tx.skill.deleteMany({ where: { workspaceId } });
  await tx.agent.deleteMany({ where: { workspaceId } });
  await tx.appConnection.deleteMany({ where: { workspaceId } });
  await tx.secret.deleteMany({ where: { workspaceId } });
  await tx.appConfig.deleteMany({ where: { workspaceId } });
  await tx.vaultConnection.deleteMany({ where: { workspaceId } });
  await tx.onboardingSurvey.deleteMany({ where: { workspaceId } });
  await tx.auditLog.deleteMany({ where: { workspaceId } });
  await tx.apiKey.deleteMany({ where: { workspaceId } });
  await tx.workspace.delete({ where: { id: workspaceId } });
};

/**
 * Ensure the user's workspaces all have an ApiKey and default Agent, then
 * return the user's default workspace (creating org + workspace if needed).
 *
 * Idempotent — safe to call on every dashboard page load.
 */
export const ensureUserDefaultOrgAndWorkspace = async (
  userId: string,
  userEmail: string,
) => {
  // Backfill API keys + agents for any workspaces missing them
  const memberships = await db.organizationMember.findMany({
    where: { userId, ...activeMembershipWhere },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);

  if (orgIds.length > 0) {
    const workspaces = await db.workspace.findMany({
      where: { organizationId: { in: orgIds }, createdByUserId: userId },
      select: { id: true },
    });
    for (const { id: workspaceId } of workspaces) {
      await ensureWorkspaceSeeds(workspaceId, userId, userEmail);
    }
  }

  const existing = await findUserDefaultWorkspace(userId);
  if (existing) return existing;

  return null;
};

export interface WorkspaceOwner {
  name: string | null;
  email: string | null;
  isCurrentUser: boolean;
}

export interface WorkspaceListItem {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: Date;
  agentCount: number;
  resourceCount: number;
  owner: WorkspaceOwner | null;
  /**
   * Whether the current user may manage the workspace (rename / delete / share) —
   * an owner-role WorkspaceAccess binding, or an org admin/owner (step 13c). Drives
   * whether the card shows management controls; the API enforces it independently.
   */
  canManage: boolean;
}

/**
 * Index `groupBy({ by: ["organizationId"] })` rows into an orgId→count map.
 * The null-org group can't occur here (we always filter on a concrete set of
 * org ids), but is dropped defensively so the map key stays a plain string.
 */
const countsByOrg = (
  groups: { organizationId: string | null; _count: { _all: number } }[],
): Map<string, number> =>
  new Map(
    groups.flatMap((g) =>
      g.organizationId ? [[g.organizationId, g._count._all] as const] : [],
    ),
  );

/**
 * Total resources a workspace can actually use: its own workspace-scoped secrets
 * and connected app connections, plus the organization-scoped ("global") ones
 * every workspace in the org inherits. Inherited counts are passed in as per-org
 * maps so a single org-level aggregation applies to all of an org's workspaces.
 */
export const sumWorkspaceResources = (
  workspace: {
    organizationId: string;
    secretCount: number;
    connectionCount: number;
  },
  orgSecretCounts: ReadonlyMap<string, number>,
  orgConnectionCounts: ReadonlyMap<string, number>,
): number =>
  workspace.secretCount +
  workspace.connectionCount +
  (orgSecretCounts.get(workspace.organizationId) ?? 0) +
  (orgConnectionCounts.get(workspace.organizationId) ?? 0);

/**
 * Resolve a workspace's owner (its creator) for display. Prefers the live
 * `createdByUser` relation for name/email, falling back to the denormalized
 * `createdByUserEmail` if the creator's user row is gone. Returns `null` for
 * legacy workspaces with no recorded creator, so callers can omit the indicator.
 */
export const resolveWorkspaceOwner = (
  workspace: {
    createdByUserId: string | null;
    createdByUserEmail: string | null;
    createdByUser: { name: string | null; email: string | null } | null;
  },
  currentUserId: string,
): WorkspaceOwner | null => {
  if (!workspace.createdByUserId) return null;
  return {
    name: workspace.createdByUser?.name ?? null,
    email:
      workspace.createdByUser?.email ?? workspace.createdByUserEmail ?? null,
    isCurrentUser: workspace.createdByUserId === currentUserId,
  };
};

/**
 * List the user's workspaces with a count of agents and of usable resources.
 * "Resources" folds workspace-scoped secrets + connected app connections together
 * with the organization-scoped (global) ones the workspace inherits, so the card
 * reflects what the workspace can actually access — not just what was created
 * directly on it. Scope rules mirror services/counts-service.ts (the source of
 * truth): workspace + organization scope, connected connections, all secret
 * types.
 */
export const listWorkspaces = async (
  userId: string,
  organizationId?: string,
  role?: OrgRole | null,
): Promise<WorkspaceListItem[]> => {
  let orgIds: string[];

  if (organizationId) {
    orgIds = [organizationId];
  } else {
    const memberships = await db.organizationMember.findMany({
      where: { userId, ...activeMembershipWhere },
      select: { organizationId: true },
    });
    if (memberships.length === 0) return [];
    orgIds = memberships.map((m) => m.organizationId);
  }

  const where =
    organizationId !== undefined
      ? visibleWorkspacesWhere(userId, organizationId, role ?? null)
      : // Defensive multi-org fallback (the sole caller passes a defined org):
        // usage is bindings-only since step 13b — the creator arm was dropped
        // here too so it can't silently regress to creator-scoped visibility.
        {
          organizationId: { in: orgIds },
          OR: workspaceAccessBindingArms(userId),
        };

  // Org-scoped secrets/connections are shared by every workspace in the org, so
  // aggregate them once per org rather than per workspace — three queries total,
  // no N+1, regardless of how many workspaces or orgs are involved.
  const [workspaces, orgSecretGroups, orgConnectionGroups] = await Promise.all([
    db.workspace.findMany({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        organizationId: true,
        createdByUserId: true,
        createdByUserEmail: true,
        createdByUser: { select: { name: true, email: true } },
        // step 13c: the viewer's own owner-role binding (the management gate),
        // loaded in the same query so `canManage` costs no extra round-trip.
        accessBindings: {
          where: { userId, role: "owner" },
          select: { id: true },
          take: 1,
        },
        _count: {
          select: {
            agents: true,
            secrets: true,
            appConnections: { where: { status: "connected" } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.secret.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds }, scope: "organization" },
      _count: { _all: true },
    }),
    db.appConnection.groupBy({
      by: ["organizationId"],
      where: {
        organizationId: { in: orgIds },
        scope: "organization",
        status: "connected",
      },
      _count: { _all: true },
    }),
  ]);

  const orgSecretCounts = countsByOrg(orgSecretGroups);
  const orgConnectionCounts = countsByOrg(orgConnectionGroups);

  // Admins/owners manage every workspace; other members manage a workspace only via
  // an owner-role WorkspaceAccess binding (step 13c) — a plain (member) share grants
  // use, not management (matches `canManageWorkspace` on the API).
  const isOrgManager = canManageAllWorkspaces(role ?? null);

  return workspaces.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    createdAt: p.createdAt,
    agentCount: p._count.agents,
    resourceCount: sumWorkspaceResources(
      {
        organizationId: p.organizationId,
        secretCount: p._count.secrets,
        connectionCount: p._count.appConnections,
      },
      orgSecretCounts,
      orgConnectionCounts,
    ),
    owner: resolveWorkspaceOwner(p, userId),
    canManage: isOrgManager || p.accessBindings.length > 0,
  }));
};

export interface UserOrgWithWorkspaces {
  id: string;
  name: string;
  workspaces: { id: string; name: string | null }[];
}

/**
 * Lists the user's organizations, each with the workspaces they own in it. Used
 * by the CLI device-auth confirm screen so the user can pick which workspace to
 * connect a terminal to. Ordered oldest-first to match the dashboard.
 */
export const getUserOrgsWithWorkspaces = async (
  userId: string,
): Promise<UserOrgWithWorkspaces[]> => {
  const memberships = await db.organizationMember.findMany({
    where: { userId, ...activeMembershipWhere },
    select: { organization: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const orgIds = memberships.map((m) => m.organization.id);

  const workspaces = orgIds.length
    ? await db.workspace.findMany({
        where: { organizationId: { in: orgIds }, createdByUserId: userId },
        select: { id: true, name: true, organizationId: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  return memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    workspaces: workspaces
      .filter((p) => p.organizationId === m.organization.id)
      .map((p) => ({ id: p.id, name: p.name })),
  }));
};

const MIN_WORKSPACE_NAME_LEN = 2;
const MAX_WORKSPACE_NAME_LEN = 50;

const validateWorkspaceName = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_WORKSPACE_NAME_LEN) {
    throw new Error(
      `Workspace name must be at least ${MIN_WORKSPACE_NAME_LEN} characters`,
    );
  }
  if (trimmed.length > MAX_WORKSPACE_NAME_LEN) {
    throw new Error(
      `Workspace name must be at most ${MAX_WORKSPACE_NAME_LEN} characters`,
    );
  }
  if (!/[a-z0-9]/i.test(trimmed)) {
    throw new Error(
      "Workspace name must contain at least one letter or number",
    );
  }
  return trimmed;
};

export const createWorkspace = async (
  userId: string,
  userEmail: string,
  rawName: string,
  organizationId: string,
) => {
  const name = validateWorkspaceName(rawName);

  const baseSlug = slugify(name) || "workspace";
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;

  return db.workspace.create({
    data: {
      id: generateWorkspaceId(),
      name,
      slug,
      organizationId,
      createdByUserId: userId,
      createdByUserEmail: userEmail,
      ...defaultWorkspaceSeed(userId, userEmail),
      // Seed the creator's WorkspaceAccess binding (step 13) atomically with the
      // workspace, as owner (13c — workspace management rides the owner role).
      // createdByUserId left null marks it a system write, matching the migration
      // seed.
      accessBindings: { create: { userId, role: "owner" } },
    },
    select: { id: true, name: true, slug: true },
  });
};

/**
 * Delete a workspace (in a transaction) and flush the gateway cache for its API
 * keys. The keys are read inside the same transaction that deletes them, then
 * flushed once it commits — otherwise a just-deleted key would keep being
 * served from the gateway's cache until its TTL expires (the org-wide
 * invalidation in `withAudit` can no longer find a deleted workspace's keys).
 * Shared by both delete entry points: `deleteWorkspace` (the cascade helper run
 * when a member or whole org is removed) and the `deleteOrgWorkspace` API route.
 */
const deleteWorkspaceAndFlushCache = async (workspaceId: string) => {
  // Provider-side teardown FIRST, outside the transaction: a presence holds a
  // Slack app installed in the customer's workspace and a service key, and
  // the row cascade below would drop our end and leave both alive with
  // nothing pointing at them. Network calls must not sit inside
  // `db.$transaction`, and it is best-effort inside — a refusing provider
  // must never block the deletion.
  await teardownWorkspacePresences(workspaceId);

  const keys = await db.$transaction(async (tx) => {
    const apiKeys = await tx.apiKey.findMany({
      where: { workspaceId },
      select: { key: true },
    });
    await deleteWorkspaceContent(workspaceId, tx);
    return apiKeys;
  });
  invalidateGatewayCacheForKeys(keys.map((k) => k.key));
};

/**
 * Permanently delete a workspace and all of its data — agents,
 * secrets, connections, rules, audit log, etc. Runs in a single transaction
 * so a partial delete can't leave the DB in a broken state.
 */
export const deleteWorkspace = async (workspaceId: string) => {
  await deleteWorkspaceAndFlushCache(workspaceId);
};

// ── API-facing functions (org-scoped, used by workspace CRUD routes) ──────

const API_WORKSPACE_SELECT = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
} as const;

export const getWorkspaceById = async (
  userId: string,
  organizationId: string,
  targetId: string,
  role: OrgRole | null,
) => {
  const workspace = await db.workspace.findFirst({
    where: {
      ...visibleWorkspacesWhere(userId, organizationId, role),
      id: targetId,
    },
    select: API_WORKSPACE_SELECT,
  });
  if (!workspace) throw new ServiceError("NOT_FOUND", "Workspace not found");
  return workspace;
};

export const listOrgWorkspaces = async (organizationId: string) => {
  return db.workspace.findMany({
    where: { organizationId },
    select: API_WORKSPACE_SELECT,
    orderBy: { createdAt: "asc" },
  });
};

/**
 * Org workspace list scoped to what the caller may see: all workspaces for
 * admins/owners, only their own for members. Used by the workspace list API.
 */
export const listOrgWorkspacesForUser = async (
  userId: string,
  organizationId: string,
  role: OrgRole | null,
) => {
  return db.workspace.findMany({
    where: visibleWorkspacesWhere(userId, organizationId, role),
    select: API_WORKSPACE_SELECT,
    orderBy: { createdAt: "asc" },
  });
};

export const createOrgWorkspace = async (
  organizationId: string,
  userId: string,
  input: { name: string },
) => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const userEmail = user?.email ?? "";

  const name = input.name.trim();
  const slug = slugify(name) || "workspace";

  const existing = await db.workspace.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
    select: { id: true },
  });
  if (existing) {
    throw new ServiceError(
      "CONFLICT",
      `A workspace with slug "${slug}" already exists`,
    );
  }

  const newWorkspace = await db.workspace.create({
    data: {
      id: generateWorkspaceId(),
      name,
      slug,
      organizationId,
      createdByUserId: userId,
      createdByUserEmail: userEmail,
      // Creator's WorkspaceAccess binding (step 13), seeded owner (13c) with the workspace.
      accessBindings: { create: { userId, role: "owner" } },
    },
    select: API_WORKSPACE_SELECT,
  });

  await ensureWorkspaceSeeds(newWorkspace.id, userId, userEmail);

  const apiKey = await db.apiKey.findFirst({
    where: { userId, workspaceId: newWorkspace.id },
    select: { key: true },
  });

  return {
    ...newWorkspace,
    apiKey: apiKey?.key ?? null,
  };
};

export const updateOrgWorkspace = async (
  organizationId: string,
  targetId: string,
  input: { name?: string },
) => {
  const workspace = await db.workspace.findFirst({
    where: { id: targetId, organizationId },
    select: { id: true },
  });
  if (!workspace) throw new ServiceError("NOT_FOUND", "Workspace not found");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    const slug = slugify(name) || "workspace";

    const conflict = await db.workspace.findFirst({
      where: { organizationId, slug, NOT: { id: targetId } },
      select: { id: true },
    });
    if (conflict) {
      throw new ServiceError(
        "CONFLICT",
        `A workspace with slug "${slug}" already exists`,
      );
    }

    data.name = name;
    data.slug = slug;
  }

  return db.workspace.update({
    where: { id: targetId },
    data,
    select: API_WORKSPACE_SELECT,
  });
};

export const deleteOrgWorkspace = async (
  organizationId: string,
  targetId: string,
) => {
  const workspace = await db.workspace.findFirst({
    where: { id: targetId, organizationId },
    select: { id: true },
  });
  if (!workspace) throw new ServiceError("NOT_FOUND", "Workspace not found");

  const count = await db.workspace.count({ where: { organizationId } });
  if (count <= 1) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Cannot delete the only workspace in the organization",
    );
  }

  await deleteWorkspaceAndFlushCache(targetId);
};
