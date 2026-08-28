import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";

/**
 * Group→role mappings (step 15) — a priority-ordered map from an IdP group to
 * an org role. A member's effective role is resolved from the mappings of the
 * groups they belong to (SCIM-populated). This module is pure Prisma and holds
 * the resolution logic + CRUD; the *applier* that writes roles lives in
 * team-service (`reconcileMemberRoles`) so every role write stays in one place
 * (and to avoid an import cycle).
 *
 * Every query is tenant-isolated: organizationId is part of each WHERE, never
 * trusted from a row id alone. Owner is never IdP-managed — the only mappable
 * roles are admin | member.
 */

export type MappableRole = "admin" | "member";

const roleMappingSelect = {
  id: true,
  groupId: true,
  role: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  group: { select: { name: true, _count: { select: { members: true } } } },
} as const;

type RoleMappingRecord = Prisma.GroupRoleMappingGetPayload<{
  select: typeof roleMappingSelect;
}>;

export interface RoleMappingRow {
  id: string;
  groupId: string;
  groupName: string;
  role: string;
  priority: number;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const toRoleMappingRow = (m: RoleMappingRecord): RoleMappingRow => ({
  id: m.id,
  groupId: m.groupId,
  groupName: m.group.name,
  role: m.role,
  priority: m.priority,
  memberCount: m.group._count.members,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

/** Loads the mapping inside the org or throws NOT_FOUND (cross-org = 404). */
const requireRoleMapping = async (organizationId: string, id: string) => {
  const mapping = await db.groupRoleMapping.findFirst({
    where: { id, organizationId },
    select: { id: true, groupId: true },
  });
  if (!mapping) throw new ServiceError("NOT_FOUND", "Role mapping not found");
  return mapping;
};

// ── CRUD ──────────────────────────────────────────────────────────────────

/** Highest priority first (index 0 is the winner shown at the top of the UI). */
export const listRoleMappings = async (
  organizationId: string,
): Promise<RoleMappingRow[]> => {
  const rows = await db.groupRoleMapping.findMany({
    where: { organizationId },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    select: roleMappingSelect,
  });
  return rows.map(toRoleMappingRow);
};

export const createRoleMapping = async (
  organizationId: string,
  input: { groupId: string; role: MappableRole; priority?: number },
): Promise<RoleMappingRow> => {
  // The group must belong to the org (unknown / cross-org group = 404).
  const group = await db.group.findFirst({
    where: { id: input.groupId, organizationId },
    select: { id: true },
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found");

  // Default new mappings to the lowest priority (bottom of the list) so they
  // never silently outrank existing ones; the admin reorders to promote.
  const priority = input.priority ?? (await nextLowestPriority(organizationId));

  try {
    const created = await db.groupRoleMapping.create({
      data: {
        organizationId,
        groupId: input.groupId,
        role: input.role,
        priority,
      },
      select: roleMappingSelect,
    });
    return toRoleMappingRow(created);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "This group already has a role mapping.",
      );
    }
    throw err;
  }
};

const nextLowestPriority = async (organizationId: string): Promise<number> => {
  const agg = await db.groupRoleMapping.aggregate({
    where: { organizationId },
    _min: { priority: true },
  });
  return (agg._min.priority ?? 1) - 1;
};

export const updateRoleMapping = async (
  organizationId: string,
  id: string,
  input: { role: MappableRole; priority?: number },
): Promise<RoleMappingRow> => {
  await requireRoleMapping(organizationId, id);
  try {
    const updated = await db.groupRoleMapping.update({
      where: { id },
      data: {
        role: input.role,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      },
      select: roleMappingSelect,
    });
    return toRoleMappingRow(updated);
  } catch (err) {
    // Concurrently deleted between the require-check and the update.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw new ServiceError("NOT_FOUND", "Role mapping not found");
    }
    throw err;
  }
};

export const deleteRoleMapping = async (
  organizationId: string,
  id: string,
): Promise<{ id: string; groupId: string }> => {
  const mapping = await requireRoleMapping(organizationId, id);
  try {
    await db.groupRoleMapping.delete({ where: { id } });
  } catch (err) {
    // Already gone (concurrent delete) — the outcome we wanted.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw new ServiceError("NOT_FOUND", "Role mapping not found");
    }
    throw err;
  }
  return { id: mapping.id, groupId: mapping.groupId };
};

/**
 * Reassign priorities from a fully-specified order (index 0 = highest). The
 * list must name every mapping exactly once, so a stale client can't drop or
 * duplicate a row. Transactional.
 */
export const reorderRoleMappings = async (
  organizationId: string,
  orderedIds: string[],
): Promise<RoleMappingRow[]> => {
  const existing = await db.groupRoleMapping.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((m) => m.id));
  const orderedSet = new Set(orderedIds);
  if (
    orderedIds.length !== existingIds.size ||
    orderedSet.size !== orderedIds.length ||
    !orderedIds.every((id) => existingIds.has(id))
  ) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Order must list every role mapping exactly once.",
    );
  }
  // Top of the list = highest priority: assign descending so index 0 wins.
  try {
    await db.$transaction(
      orderedIds.map((id, i) =>
        db.groupRoleMapping.update({
          where: { id },
          data: { priority: orderedIds.length - i },
        }),
      ),
    );
  } catch (err) {
    // A mapping was deleted mid-reorder — the transaction rolled back cleanly.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "Role mappings changed. Please refresh and try again.",
      );
    }
    throw err;
  }
  return listRoleMappings(organizationId);
};

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * The winning role among a user's mapped groups: highest `priority`; on a tie,
 * the more-privileged role (admin > member) wins so an equal-priority pair can
 * never silently demote. `null` when the user is in no mapped group.
 */
export const resolveWinningRole = (
  mapped: { role: string; priority: number }[],
): MappableRole | null => {
  let winner: { role: string; priority: number } | null = null;
  for (const m of mapped) {
    if (
      !winner ||
      m.priority > winner.priority ||
      (m.priority === winner.priority &&
        m.role === "admin" &&
        winner.role !== "admin")
    ) {
      winner = m;
    }
  }
  if (!winner) return null;
  return winner.role === "admin" ? "admin" : "member";
};

/** Reduce (userId, its group's roleMapping) rows to each user's mapped roles. */
const groupMappingsByUser = (
  rows: {
    userId: string;
    group: { roleMapping: { role: string; priority: number } | null };
  }[],
): Map<string, { role: string; priority: number }[]> => {
  const byUser = new Map<string, { role: string; priority: number }[]>();
  for (const row of rows) {
    const rm = row.group.roleMapping;
    if (!rm) continue;
    const list = byUser.get(row.userId) ?? [];
    list.push(rm);
    byUser.set(row.userId, list);
  }
  return byUser;
};

/**
 * The mapped role each user would get from their group memberships, keyed by
 * userId. A user absent from the map is "unmatched" (in no mapped group) and
 * must keep their current role — never stripped. One query for the batch.
 */
export const resolveRolesForUsers = async (
  organizationId: string,
  userIds: string[],
): Promise<Map<string, MappableRole>> => {
  const result = new Map<string, MappableRole>();
  if (userIds.length === 0) return result;

  const rows = await db.groupMember.findMany({
    where: {
      userId: { in: userIds },
      group: { organizationId, roleMapping: { isNot: null } },
    },
    select: {
      userId: true,
      group: {
        select: { roleMapping: { select: { role: true, priority: true } } },
      },
    },
  });

  const byUser = groupMappingsByUser(rows);
  for (const [userId, mapped] of byUser) {
    const winner = resolveWinningRole(mapped);
    if (winner) result.set(userId, winner);
  }
  return result;
};

/** userIds of a group's members — the set to re-resolve after a mapping change. */
export const memberIdsForGroup = async (
  organizationId: string,
  groupId: string,
): Promise<string[]> => {
  const rows = await db.groupMember.findMany({
    where: { groupId, group: { organizationId } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
};

/**
 * Every user holding a membership in any mapped group — the set to re-resolve
 * after a reorder (priority changes can flip winners for multi-group members).
 */
export const allMappedMemberIds = async (
  organizationId: string,
): Promise<string[]> => {
  const rows = await db.groupMember.findMany({
    where: { group: { organizationId, roleMapping: { isNot: null } } },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
};

/**
 * Whether a member's role is governed by ≥1 group→role mapping — the predicate
 * behind the "managed by your identity provider" manual-edit lock.
 */
export const isRoleManagedByIdp = async (
  organizationId: string,
  userId: string,
): Promise<boolean> => {
  const count = await db.groupRoleMapping.count({
    where: { organizationId, group: { members: { some: { userId } } } },
  });
  return count > 0;
};

// ── Preview ──────────────────────────────────────────────────────────────────

/**
 * Dry-run for the UI: how many of the target group's members would change org
 * role if the group were mapped to `role`. The priority is resolved
 * server-side — the group's existing priority if it's already mapped (an edit),
 * else the lowest slot a create assigns — so the count matches exactly what
 * saving does (the client priority isn't trusted). Owners and suspended members
 * are never counted (never IdP-managed).
 */
export const previewRoleMappingImpact = async (
  organizationId: string,
  proposed: { groupId: string; role: MappableRole },
): Promise<{ affectedCount: number }> => {
  const existing = await db.groupRoleMapping.findFirst({
    where: { groupId: proposed.groupId, organizationId },
    select: { priority: true },
  });
  const priority =
    existing?.priority ?? (await nextLowestPriority(organizationId));

  const groupMembers = await db.groupMember.findMany({
    where: { groupId: proposed.groupId, group: { organizationId } },
    select: { userId: true },
  });
  const userIds = groupMembers.map((m) => m.userId);
  if (userIds.length === 0) return { affectedCount: 0 };

  const members = await db.organizationMember.findMany({
    where: {
      organizationId,
      userId: { in: userIds },
      status: { not: "suspended" },
      role: { not: "owner" },
    },
    select: { userId: true, role: true },
  });
  if (members.length === 0) return { affectedCount: 0 };

  // Each member's OTHER mapped groups; the target group's own row (if any) is
  // replaced by the proposed { role, priority } below.
  const rows = await db.groupMember.findMany({
    where: {
      userId: { in: members.map((m) => m.userId) },
      group: {
        organizationId,
        roleMapping: { isNot: null },
        id: { not: proposed.groupId },
      },
    },
    select: {
      userId: true,
      group: {
        select: { roleMapping: { select: { role: true, priority: true } } },
      },
    },
  });
  const otherByUser = groupMappingsByUser(rows);

  let affectedCount = 0;
  for (const m of members) {
    const mapped = [
      ...(otherByUser.get(m.userId) ?? []),
      { role: proposed.role, priority },
    ];
    const winner = resolveWinningRole(mapped);
    if (winner && winner !== m.role) affectedCount++;
  }
  return { affectedCount };
};
