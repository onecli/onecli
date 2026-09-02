import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";

/**
 * Workspace access bindings (step 13) — the human sharing surface for a workspace.
 * A workspace's creator is seeded a binding at create time; this service lists
 * and replaces the people and groups it is shared with. Since step 13b the
 * creator's own binding is a normal, removable share like any other (usage is
 * bindings-only, so revoking it revokes the creator's use) — the last-binding
 * guard is a soft UI warning, not a server block, because org admins remain the
 * backstop. The `isOwner` flag survives only as a display hint.
 *
 * Placeholder users (provision seat-warmers, `@onecli.internal`) are
 * never surfaced as people, mirroring the directory listing.
 */

const PLACEHOLDER_EMAIL_SUFFIX = "@onecli.internal";

export interface WorkspaceAccessUserRow {
  /** WorkspaceAccess row id. */
  id: string;
  userId: string;
  name: string | null;
  email: string;
  /** Management role on this binding (step 13c): "owner" may manage the workspace. */
  role: "owner" | "member";
  /** The workspace creator — a display hint only; removable like any share since 13b. */
  isOwner: boolean;
  createdAt: Date;
}

export interface WorkspaceAccessGroupRow {
  id: string;
  groupId: string;
  name: string;
  memberCount: number;
  createdAt: Date;
}

export interface WorkspaceAccessBindings {
  users: WorkspaceAccessUserRow[];
  groups: WorkspaceAccessGroupRow[];
}

const requireWorkspaceInOrg = async (
  organizationId: string,
  workspaceId: string,
): Promise<{ id: string; createdByUserId: string | null }> => {
  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, organizationId },
    select: { id: true, createdByUserId: true },
  });
  if (!workspace) throw new ServiceError("NOT_FOUND", "Workspace not found");
  return workspace;
};

/**
 * The people and groups a workspace is shared with (plus the owner row, flagged).
 * Placeholder users are filtered out.
 */
export const listWorkspaceAccess = async (
  organizationId: string,
  workspaceId: string,
): Promise<WorkspaceAccessBindings> => {
  const workspace = await requireWorkspaceInOrg(organizationId, workspaceId);

  const rows = await db.workspaceAccess.findMany({
    where: { workspaceId },
    select: {
      id: true,
      userId: true,
      groupId: true,
      role: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
      group: {
        select: { name: true, _count: { select: { members: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const users: WorkspaceAccessUserRow[] = [];
  const groups: WorkspaceAccessGroupRow[] = [];
  for (const row of rows) {
    if (row.userId && row.user) {
      if (row.user.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX)) continue;
      users.push({
        id: row.id,
        userId: row.userId,
        name: row.user.name,
        email: row.user.email,
        role: row.role === "owner" ? "owner" : "member",
        isOwner: row.userId === workspace.createdByUserId,
        createdAt: row.createdAt,
      });
    } else if (row.groupId && row.group) {
      groups.push({
        id: row.id,
        groupId: row.groupId,
        name: row.group.name,
        memberCount: row.group._count.members,
        createdAt: row.createdAt,
      });
    }
  }
  return { users, groups };
};

/**
 * Replace a workspace's shares. `users` (each with a management `role`) and
 * `groupIds` are the principals to keep; the diff adds, removes, and retargets
 * roles in one transaction. Since step 13b every binding — the creator's included
 * — is removable (a caller may leave a workspace with zero human bindings; org
 * admins still reach it and the UI warns first). Step 13c adds the per-user
 * `owner | member` role: owner may manage the workspace. Groups carry no role (v1).
 */
export const replaceWorkspaceAccess = async (
  organizationId: string,
  workspaceId: string,
  input: {
    users: { userId: string; role: "owner" | "member" }[];
    groupIds: string[];
  },
  actorUserId: string,
  // Plan entitlements, asserted only when the request ADDS a share of that kind
  // (the route supplies them). Gating on additions — not on presence — lets a
  // caller preserve a legacy binding they can no longer create (e.g. a group
  // added while on Enterprise, since downgraded) without re-tripping the gate.
  // A role change on an existing share needs no entitlement.
  gates?: {
    assertCanAddUsers?: () => Promise<void>;
    assertCanAddGroups?: () => Promise<void>;
  },
): Promise<{ added: number; removed: number; roleChanged: number }> => {
  // Validates the workspace is in the org (throws NOT_FOUND); the creator is no
  // longer special here — since 13b their binding is removable like any other.
  await requireWorkspaceInOrg(organizationId, workspaceId);

  // Target principals: dedupe users by id (last role wins), dedupe group ids.
  const targetUserRoles = new Map<string, "owner" | "member">();
  for (const u of input.users) targetUserRoles.set(u.userId, u.role);
  const targetGroups = [...new Set(input.groupIds)];
  const targetGroupSet = new Set(targetGroups);

  const currentRows = await db.workspaceAccess.findMany({
    where: { workspaceId },
    select: { userId: true, groupId: true, role: true },
  });
  const currentUserRoles = new Map<string, string>();
  for (const r of currentRows) {
    if (r.userId) currentUserRoles.set(r.userId, r.role);
  }
  const currentGroups = new Set(
    currentRows.flatMap((r) => (r.groupId ? [r.groupId] : [])),
  );

  const addUsers = [...targetUserRoles.keys()].filter(
    (id) => !currentUserRoles.has(id),
  );
  // Any current user not in the target set is removed — including the creator,
  // whose binding is revocable since 13b (no owner-protection carve-out).
  const removeUsers = [...currentUserRoles.keys()].filter(
    (id) => !targetUserRoles.has(id),
  );
  // Preserved users whose management role flips (member↔owner).
  const toOwner: string[] = [];
  const toMember: string[] = [];
  for (const [id, role] of targetUserRoles) {
    const current = currentUserRoles.get(id);
    if (current === undefined || current === role) continue;
    (role === "owner" ? toOwner : toMember).push(id);
  }
  const addGroups = targetGroups.filter((id) => !currentGroups.has(id));
  const removeGroups = [...currentGroups].filter(
    (id) => !targetGroupSet.has(id),
  );

  if (
    addUsers.length === 0 &&
    removeUsers.length === 0 &&
    toOwner.length === 0 &&
    toMember.length === 0 &&
    addGroups.length === 0 &&
    removeGroups.length === 0
  ) {
    return { added: 0, removed: 0, roleChanged: 0 };
  }

  // Validate only the *additions* — a new user needs an ACTIVE membership, a new
  // group must be in the org. Preserved bindings are never re-validated, so
  // re-sending a member you already shared with who has since been suspended (or
  // a group you can no longer create) doesn't block an otherwise-valid edit.
  if (addUsers.length > 0) {
    const validRows = await db.organizationMember.findMany({
      where: { organizationId, userId: { in: addUsers }, status: "active" },
      select: { userId: true },
    });
    const valid = new Set(validRows.map((m) => m.userId));
    const unknown = addUsers.filter((id) => !valid.has(id));
    if (unknown.length > 0) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Not active members of this organization: ${unknown.join(", ")}`,
      );
    }
  }
  if (addGroups.length > 0) {
    const validRows = await db.group.findMany({
      where: { organizationId, id: { in: addGroups } },
      select: { id: true },
    });
    const valid = new Set(validRows.map((g) => g.id));
    const unknown = addGroups.filter((id) => !valid.has(id));
    if (unknown.length > 0) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Groups not in this organization: ${unknown.join(", ")}`,
      );
    }
  }

  // Entitlement is required only to ADD a share, and only for the kind being
  // added — never for preserving or removing an existing one.
  if (addUsers.length > 0) await gates?.assertCanAddUsers?.();
  if (addGroups.length > 0) await gates?.assertCanAddGroups?.();

  const ops: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [];
  if (removeUsers.length > 0) {
    ops.push(
      db.workspaceAccess.deleteMany({
        where: { workspaceId, userId: { in: removeUsers } },
      }),
    );
  }
  if (removeGroups.length > 0) {
    ops.push(
      db.workspaceAccess.deleteMany({
        where: { workspaceId, groupId: { in: removeGroups } },
      }),
    );
  }
  // Re-role preserved user bindings, batched by target role.
  if (toOwner.length > 0) {
    ops.push(
      db.workspaceAccess.updateMany({
        where: { workspaceId, userId: { in: toOwner } },
        data: { role: "owner" },
      }),
    );
  }
  if (toMember.length > 0) {
    ops.push(
      db.workspaceAccess.updateMany({
        where: { workspaceId, userId: { in: toMember } },
        data: { role: "member" },
      }),
    );
  }
  const createData = [
    ...addUsers.map((userId) => ({
      workspaceId,
      userId,
      role: targetUserRoles.get(userId) ?? "member",
      createdByUserId: actorUserId,
    })),
    ...addGroups.map((groupId) => ({
      workspaceId,
      groupId,
      createdByUserId: actorUserId,
    })),
  ];
  if (createData.length > 0) {
    // skipDuplicates keeps a concurrent double-add idempotent (composite uniques).
    ops.push(
      db.workspaceAccess.createMany({ data: createData, skipDuplicates: true }),
    );
  }
  await db.$transaction(ops);

  return {
    added: addUsers.length + addGroups.length,
    removed: removeUsers.length + removeGroups.length,
    roleChanged: toOwner.length + toMember.length,
  };
};
