import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import {
  clampPageLimit,
  decodeCursor,
  toPage,
  type DirectoryPage,
} from "./directory-pagination";
import { AUDIT_SOURCE, type AuditSource } from "../../services/audit-service";
import { reconcileMemberRoles } from "./team-service";

/**
 * A group's membership change may flip its members' org roles when the group
 * has a role mapping (step 15). Attribute the reconcile to how the change
 * arrived: SCIM (IdP push) vs API (a manual admin edit of a `manual` group).
 */
const sourceForGroup = (source: string): AuditSource =>
  source === "scim" ? AUDIT_SOURCE.SCIM : AUDIT_SOURCE.API;

/**
 * Human groups — manually managed or SCIM-provisioned. Pure Prisma and
 * Cognito-free by design: this module is the seed of step 12's
 * org-directory-service (the SCIM dialect and the org-key provisioning
 * surface become thin layers over these functions).
 *
 * Every query is tenant-isolated: the organizationId is part of each WHERE,
 * never trusted from a row id alone.
 */

const groupSelect = {
  id: true,
  name: true,
  source: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: true } },
} as const;

type GroupRecord = Prisma.GroupGetPayload<{ select: typeof groupSelect }>;

export interface GroupRow {
  id: string;
  name: string;
  source: string;
  externalId: string | null;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const toGroupRow = (group: GroupRecord): GroupRow => ({
  id: group.id,
  name: group.name,
  source: group.source,
  externalId: group.externalId,
  memberCount: group._count.members,
  createdAt: group.createdAt,
  updatedAt: group.updatedAt,
});

export interface GroupMemberRow {
  userId: string;
  email: string;
  name: string | null;
  addedAt: Date;
}

/** Loads the group inside the org or throws NOT_FOUND (cross-org = 404). */
const requireGroup = async (organizationId: string, groupId: string) => {
  const group = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: { id: true, name: true, source: true },
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found");
  return group;
};

/**
 * SCIM-provisioned groups are managed by the customer's IdP — manual
 * mutations (rename, delete, membership) are rejected so the two writers
 * never fight. The full lock UX lands with the SCIM server; the guard is
 * correct from day one.
 */
const assertManuallyManaged = (group: { source: string }) => {
  if (group.source === "scim") {
    throw new ServiceError(
      "CONFLICT",
      "This group is managed by your identity provider.",
    );
  }
};

export interface ListGroupsParams {
  limit?: number;
  cursor?: string;
  q?: string;
  source?: "manual" | "scim";
}

export const listGroups = async (
  organizationId: string,
  params: ListGroupsParams = {},
): Promise<DirectoryPage<GroupRow>> => {
  const limit = clampPageLimit(params.limit);
  const where: Prisma.GroupWhereInput = { organizationId };
  if (params.q) where.name = { contains: params.q, mode: "insensitive" };
  if (params.source) where.source = params.source;
  if (params.cursor) {
    const pos = decodeCursor(params.cursor);
    if (typeof pos.name !== "string" || typeof pos.id !== "string") {
      throw new ServiceError("BAD_REQUEST", "Invalid cursor");
    }
    where.AND = [
      {
        OR: [
          { name: { gt: pos.name } },
          { name: pos.name, id: { gt: pos.id } },
        ],
      },
    ];
  }

  const rows = await db.group.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: groupSelect,
  });
  return toPage(rows.map(toGroupRow), limit, (last) => ({
    name: last.name,
    id: last.id,
  }));
};

export const getGroup = async (
  organizationId: string,
  groupId: string,
): Promise<GroupRow> => {
  const group = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: groupSelect,
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found");
  return toGroupRow(group);
};

/**
 * Directory-service entry point — no management-source guard. The manual
 * public functions below wrap these cores with `assertManuallyManaged`;
 * org-directory-service (the SCIM manager) calls them directly with
 * `source: "scim"` semantics.
 */
export const createGroupCore = async (
  organizationId: string,
  name: string,
  source: "manual" | "scim",
  externalId: string | null,
): Promise<GroupRow> => {
  try {
    const group = await db.group.create({
      data: { organizationId, name, source, externalId },
      select: groupSelect,
    });
    return toGroupRow(group);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Two unique constraints can fire: (org, name) and (org, source,
      // externalId) — name the right one so the conflict is actionable.
      const target = String(err.meta?.target ?? "");
      throw new ServiceError(
        "CONFLICT",
        target.includes("external")
          ? "A group with this externalId already exists."
          : "A group with this name already exists.",
      );
    }
    throw err;
  }
};

export const createGroup = (
  organizationId: string,
  name: string,
): Promise<GroupRow> => createGroupCore(organizationId, name, "manual", null);

/** Directory-service entry point — no management-source guard. */
export const renameGroupCore = async (
  organizationId: string,
  groupId: string,
  name: string,
): Promise<GroupRow> => {
  const group = await requireGroup(organizationId, groupId);
  try {
    const updated = await db.group.update({
      where: { id: group.id },
      data: { name },
      select: groupSelect,
    });
    return toGroupRow(updated);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "A group with this name already exists.",
      );
    }
    throw err;
  }
};

export const renameGroup = async (
  organizationId: string,
  groupId: string,
  name: string,
): Promise<GroupRow> => {
  const group = await requireGroup(organizationId, groupId);
  assertManuallyManaged(group);
  return renameGroupCore(organizationId, groupId, name);
};

/** Directory-service entry point — no management-source guard. */
export const deleteGroupCore = async (
  organizationId: string,
  groupId: string,
): Promise<{ id: string; name: string }> => {
  const group = await requireGroup(organizationId, groupId);
  // Snapshot members before the cascade: deleting the group drops its
  // membership rows AND its role mapping (both cascade), so an ex-member still
  // in another mapped group must be re-resolved (step 15).
  const members = await db.groupMember.findMany({
    where: { groupId: group.id },
    select: { userId: true },
  });
  await db.group.delete({ where: { id: group.id } });
  await reconcileMemberRoles(
    organizationId,
    members.map((m) => m.userId),
    sourceForGroup(group.source),
  );
  return { id: group.id, name: group.name };
};

export const deleteGroup = async (
  organizationId: string,
  groupId: string,
): Promise<{ id: string; name: string }> => {
  const group = await requireGroup(organizationId, groupId);
  assertManuallyManaged(group);
  return deleteGroupCore(organizationId, groupId);
};

export interface ListPageParams {
  limit?: number;
  cursor?: string;
}

export const listGroupMembers = async (
  organizationId: string,
  groupId: string,
  params: ListPageParams = {},
): Promise<DirectoryPage<GroupMemberRow>> => {
  await requireGroup(organizationId, groupId);
  const limit = clampPageLimit(params.limit);
  const where: Prisma.GroupMemberWhereInput = { groupId };
  if (params.cursor) {
    const pos = decodeCursor(params.cursor);
    if (typeof pos.addedAt !== "string" || typeof pos.userId !== "string") {
      throw new ServiceError("BAD_REQUEST", "Invalid cursor");
    }
    where.AND = [
      {
        OR: [
          { createdAt: { gt: new Date(pos.addedAt) } },
          { createdAt: new Date(pos.addedAt), userId: { gt: pos.userId } },
        ],
      },
    ];
  }

  const rows = await db.groupMember.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    take: limit + 1,
    select: {
      userId: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
  });
  return toPage(
    rows.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      addedAt: m.createdAt,
    })),
    limit,
    (last) => ({ addedAt: last.addedAt.toISOString(), userId: last.userId }),
  );
};

/** The target must belong to the org — any membership status (suspension gates access elsewhere). */
const requireOrgMember = async (organizationId: string, userId: string) => {
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { userId: true },
  });
  if (!member) {
    throw new ServiceError(
      "BAD_REQUEST",
      "User is not a member of this organization",
    );
  }
};

/** Directory-service entry point — no management-source guard. */
export const addGroupMemberCore = async (
  organizationId: string,
  groupId: string,
  userId: string,
  actorUserId: string | null,
): Promise<{ added: boolean }> => {
  const group = await requireGroup(organizationId, groupId);
  await requireOrgMember(organizationId, userId);
  try {
    await db.groupMember.create({
      data: { groupId: group.id, userId, createdByUserId: actorUserId },
    });
    // Joining a mapped group may change this member's org role (step 15).
    await reconcileMemberRoles(
      organizationId,
      [userId],
      sourceForGroup(group.source),
    );
    return { added: true };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { added: false }; // already a member — idempotent
    }
    throw err;
  }
};

export const addGroupMember = async (
  organizationId: string,
  groupId: string,
  userId: string,
  actorUserId: string,
): Promise<{ added: boolean }> => {
  const group = await requireGroup(organizationId, groupId);
  assertManuallyManaged(group);
  return addGroupMemberCore(organizationId, groupId, userId, actorUserId);
};

/** Directory-service entry point — no management-source guard. */
export const removeGroupMemberCore = async (
  organizationId: string,
  groupId: string,
  userId: string,
): Promise<{ removed: boolean }> => {
  const group = await requireGroup(organizationId, groupId);
  const { count } = await db.groupMember.deleteMany({
    where: { groupId: group.id, userId },
  });
  // Leaving a mapped group may re-resolve this member's org role among their
  // remaining mapped groups (step 15).
  await reconcileMemberRoles(
    organizationId,
    [userId],
    sourceForGroup(group.source),
  );
  return { removed: count > 0 }; // absent row — idempotent
};

export const removeGroupMember = async (
  organizationId: string,
  groupId: string,
  userId: string,
): Promise<{ removed: boolean }> => {
  const group = await requireGroup(organizationId, groupId);
  assertManuallyManaged(group);
  return removeGroupMemberCore(organizationId, groupId, userId);
};

/** Directory-service entry point — no management-source guard. */
export const setGroupMembersCore = async (
  organizationId: string,
  groupId: string,
  userIds: string[],
  actorUserId: string | null,
): Promise<{ added: number; removed: number }> => {
  const group = await requireGroup(organizationId, groupId);

  const target = [...new Set(userIds)];
  const validRows = await db.organizationMember.findMany({
    where: { organizationId, userId: { in: target } },
    select: { userId: true },
  });
  const valid = new Set(validRows.map((m) => m.userId));
  const unknown = target.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Not members of this organization: ${unknown.join(", ")}`,
    );
  }

  const currentRows = await db.groupMember.findMany({
    where: { groupId: group.id },
    select: { userId: true },
  });
  const current = new Set(currentRows.map((m) => m.userId));
  const targetSet = new Set(target);
  const toAdd = target.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !targetSet.has(id));
  if (toAdd.length === 0 && toRemove.length === 0) {
    return { added: 0, removed: 0 };
  }

  await db.$transaction([
    db.groupMember.deleteMany({
      where: { groupId: group.id, userId: { in: toRemove } },
    }),
    // skipDuplicates makes a concurrent double-add idempotent (composite PK).
    db.groupMember.createMany({
      data: toAdd.map((userId) => ({
        groupId: group.id,
        userId,
        createdByUserId: actorUserId,
      })),
      skipDuplicates: true,
    }),
  ]);
  // Added and removed users alike may have their org role re-resolved (step 15).
  await reconcileMemberRoles(
    organizationId,
    [...toAdd, ...toRemove],
    sourceForGroup(group.source),
  );
  return { added: toAdd.length, removed: toRemove.length };
};

export const setGroupMembers = async (
  organizationId: string,
  groupId: string,
  userIds: string[],
  actorUserId: string,
): Promise<{ added: number; removed: number }> => {
  const group = await requireGroup(organizationId, groupId);
  assertManuallyManaged(group);
  return setGroupMembersCore(organizationId, groupId, userIds, actorUserId);
};

/**
 * Reverse lookup: the groups a user belongs to inside this org. A user with
 * no memberships (or outside the org) gets an empty page, never a 404.
 */
export const listGroupsForUser = async (
  organizationId: string,
  userId: string,
  params: ListPageParams = {},
): Promise<DirectoryPage<GroupRow>> => {
  const limit = clampPageLimit(params.limit);
  const where: Prisma.GroupMemberWhereInput = {
    userId,
    group: { organizationId },
  };
  if (params.cursor) {
    const pos = decodeCursor(params.cursor);
    if (typeof pos.name !== "string" || typeof pos.id !== "string") {
      throw new ServiceError("BAD_REQUEST", "Invalid cursor");
    }
    where.AND = [
      {
        OR: [
          { group: { name: { gt: pos.name } } },
          { group: { name: pos.name }, groupId: { gt: pos.id } },
        ],
      },
    ];
  }

  const rows = await db.groupMember.findMany({
    where,
    orderBy: [{ group: { name: "asc" } }, { groupId: "asc" }],
    take: limit + 1,
    select: { group: { select: groupSelect } },
  });
  return toPage(
    rows.map((m) => toGroupRow(m.group)),
    limit,
    (last) => ({ name: last.name, id: last.id }),
  );
};
