import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import {
  suspendMember,
  reinstateMember,
  type TeamMember,
} from "./team-service";
import {
  createGroupCore,
  renameGroupCore,
  deleteGroupCore,
  setGroupMembersCore,
  addGroupMemberCore,
  removeGroupMemberCore,
} from "./group-service";

/**
 * The org directory core (step 12 of the enterprise-idp plan): pure Prisma
 * and Cognito-free — identity side-effects stay behind the step-9
 * cognito-user-service, which team-service already wires. Two thin surfaces
 * consume this module with identical behavior: the SCIM dialect (/scim/v2)
 * and the first-party provisioning routes (/v1/org/members).
 *
 * SCIM-managed groups bypass the manual-management guard by construction:
 * this module calls the group-service *Core entry points (the manual public
 * functions keep the guard).
 */

/**
 * A user provisioned before their first sign-in gets a real email plus a
 * `scim-<uuid>` placeholder externalAuthId (a member of the
 * PLACEHOLDER_AUTH_ID_PREFIXES family, so Cognito revocation skips them).
 * The first real sign-in re-points externalAuthId through the email-keyed
 * session upsert, gated by resolveIdentityConflict.
 */
const scimPlaceholderAuthId = (): string => `scim-${randomUUID()}`;

export interface DirectoryUser {
  userId: string;
  email: string;
  name: string | null;
  created: boolean;
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const normalizeEmail = (rawEmail: string): string => {
  const email = rawEmail.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new ServiceError("BAD_REQUEST", "userName must be an email address");
  }
  return email;
};

export const upsertUserByEmail = async (
  rawEmail: string,
  name?: string | null,
  nameComponents?: Prisma.InputJsonValue | null,
): Promise<DirectoryUser> => {
  const email = normalizeEmail(rawEmail);
  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });
  if (existing) {
    return {
      userId: existing.id,
      email: existing.email,
      name: existing.name,
      created: false,
    };
  }
  try {
    const user = await db.user.create({
      data: {
        email,
        externalAuthId: scimPlaceholderAuthId(),
        name,
        nameComponents: nameComponents ?? undefined,
      },
      select: { id: true, email: true, name: true },
    });
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      created: true,
    };
  } catch (err) {
    // Concurrent provisioning (an IdP retry racing itself) — the loser of
    // the unique(email) race adopts the winner's row.
    if (!isUniqueViolation(err)) throw err;
    const winner = await db.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, email: true, name: true },
    });
    return {
      userId: winner.id,
      email: winner.email,
      name: winner.name,
      created: false,
    };
  }
};

export interface ProvisionedMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  joinedAt: Date;
  /** false = the membership already existed (the SCIM 409 uniqueness path). */
  created: boolean;
  /** true = a brand-new User row was minted (vs an existing user joining). */
  userCreated: boolean;
}

export const provisionMember = async (
  organizationId: string,
  email: string,
  name?: string | null,
  nameComponents?: Prisma.InputJsonValue | null,
): Promise<ProvisionedMember> => {
  const user = await upsertUserByEmail(email, name, nameComponents);
  const existing = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: user.userId } },
    select: { role: true, status: true, createdAt: true },
  });
  if (existing) {
    return {
      userId: user.userId,
      email: user.email,
      name: user.name,
      role: existing.role,
      status: existing.status,
      joinedAt: existing.createdAt,
      created: false,
      userCreated: user.created,
    };
  }
  try {
    const membership = await db.organizationMember.create({
      data: {
        organizationId,
        userId: user.userId,
        userEmail: user.email,
        role: "member",
      },
      select: { role: true, status: true, createdAt: true },
    });
    return {
      userId: user.userId,
      email: user.email,
      name: user.name,
      role: membership.role,
      status: membership.status,
      joinedAt: membership.createdAt,
      created: true,
      userCreated: user.created,
    };
  } catch (err) {
    // Composite-PK race (concurrent provisioning) — surface the existing
    // membership as the created:false path, same as the pre-check above.
    if (!isUniqueViolation(err)) throw err;
    const raced = await db.organizationMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId, userId: user.userId } },
      select: { role: true, status: true, createdAt: true },
    });
    return {
      userId: user.userId,
      email: user.email,
      name: user.name,
      role: raced.role,
      status: raced.status,
      joinedAt: raced.createdAt,
      created: false,
      userCreated: user.created,
    };
  }
};

/**
 * Idempotent deactivation (IdPs retry): already-suspended is success, not
 * team-service's human-facing CONFLICT. The owner guard is checked here —
 * before team-service's self-guard, which would otherwise fire first with a
 * misleading message when the SCIM actor (the owner) is also the target.
 * Guards propagate as ServiceError; the SCIM layer maps them to a 400 with
 * the message as `detail` — visible in the IdP's admin console.
 */
export const deactivateMember = async (
  organizationId: string,
  userId: string,
  actorUserId: string,
): Promise<void> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { status: true, role: true },
  });
  if (!membership) {
    throw new ServiceError("NOT_FOUND", "User not found");
  }
  if (membership.status === "suspended") return;
  if (membership.role === "owner") {
    throw new ServiceError(
      "BAD_REQUEST",
      "The organization owner cannot be deactivated. Transfer ownership first.",
    );
  }
  await suspendMember(organizationId, userId, actorUserId);
};

/** Idempotent reactivation — already-active is success. */
export const reactivateMember = async (
  organizationId: string,
  userId: string,
): Promise<void> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { status: true },
  });
  if (!membership) {
    throw new ServiceError("NOT_FOUND", "User not found");
  }
  if (membership.status !== "suspended") return;
  await reinstateMember(organizationId, userId);
};

export interface MemberProfilePatch {
  /** User.name — the display string. Explicit null clears it. */
  displayName?: string | null;
  /** The SCIM `name` object, stored verbatim. Explicit null clears it. */
  nameComponents?: Prisma.InputJsonValue | null;
}

/**
 * Profile sync from the IdP (display-only metadata, never access-bearing).
 * The membership check is the cross-tenant guard: only an org the user
 * belongs to may edit their profile.
 */
export const updateMemberProfile = async (
  organizationId: string,
  userId: string,
  patch: MemberProfilePatch,
): Promise<void> => {
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { userId: true },
  });
  if (!membership) {
    throw new ServiceError("NOT_FOUND", "User not found");
  }
  const data: Prisma.UserUpdateInput = {};
  if (patch.displayName !== undefined) data.name = patch.displayName;
  if (patch.nameComponents !== undefined) {
    data.nameComponents = patch.nameComponents ?? Prisma.JsonNull;
  }
  if (Object.keys(data).length === 0) return;
  await db.user.update({ where: { id: userId }, data });
};

/**
 * userName (email) rename — the Entra UPN-change sync path. Allowed only
 * for SOLE-ORG members (this org effectively owns the account — a
 * placeholder or bound identity alike; even a placeholder provisioned by
 * two orgs' IdPs must not be renamable by one of them). Multi-org → the
 * SCIM layer surfaces a `mutability` 400. The email-keyed session upsert
 * (auth-session.ts) is WHY this exists: an IdP-renamed SSO user's next
 * login carries the new email, and without this rename it would mint a
 * duplicate account.
 */
export const renameMemberEmail = async (
  organizationId: string,
  userId: string,
  rawNewEmail: string,
): Promise<{ email: string }> => {
  const email = normalizeEmail(rawNewEmail);
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { user: { select: { email: true } } },
  });
  if (!membership) {
    throw new ServiceError("NOT_FOUND", "User not found");
  }
  if (membership.user.email === email) return { email };

  const membershipCount = await db.organizationMember.count({
    where: { userId },
  });
  if (membershipCount !== 1) {
    throw new ServiceError(
      "BAD_REQUEST",
      "userName cannot be changed for a user who belongs to multiple organizations.",
    );
  }

  try {
    await db.$transaction([
      db.user.update({ where: { id: userId }, data: { email } }),
      // Live denormalizations follow the rename; historical snapshots
      // (AuditLog.userEmail, provenance columns) deliberately do not.
      db.organizationMember.updateMany({
        where: { userId },
        data: { userEmail: email },
      }),
      db.apiKey.updateMany({
        where: { userId },
        data: { userEmail: email },
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "A user with this userName already exists.",
      );
    }
    throw err;
  }
  return { email };
};

const memberSelect = {
  userId: true,
  userEmail: true,
  role: true,
  status: true,
  ssoExempt: true,
  createdAt: true,
  user: { select: { name: true, nameComponents: true, updatedAt: true } },
} as const;

/**
 * TeamMember plus the SCIM extras: the stored `name` object, and the
 * `meta.lastModified` source (RFC 7643 §3.1) — the latest of the user
 * row's update and the membership's creation, so a user row last touched
 * before joining the org never yields lastModified < created.
 */
export interface DirectoryMember extends TeamMember {
  lastModifiedAt: Date;
  nameComponents: Prisma.JsonValue | null;
}

const toDirectoryMember = (m: {
  userId: string;
  userEmail: string;
  role: string;
  status: string;
  ssoExempt: boolean;
  createdAt: Date;
  user: {
    name: string | null;
    nameComponents: Prisma.JsonValue | null;
    updatedAt: Date;
  };
}): DirectoryMember => ({
  userId: m.userId,
  email: m.userEmail,
  name: m.user.name,
  role: m.role,
  status: m.status,
  ssoExempt: m.ssoExempt,
  joinedAt: m.createdAt,
  lastModifiedAt:
    m.user.updatedAt > m.createdAt ? m.user.updatedAt : m.createdAt,
  nameComponents: m.user.nameComponents,
});

export const findMemberByUserId = async (
  organizationId: string,
  userId: string,
): Promise<DirectoryMember | null> => {
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: memberSelect,
  });
  return member ? toDirectoryMember(member) : null;
};

export const findMemberByEmail = async (
  organizationId: string,
  rawEmail: string,
): Promise<DirectoryMember | null> => {
  const member = await db.organizationMember.findFirst({
    where: { organizationId, userEmail: rawEmail.trim().toLowerCase() },
    select: memberSelect,
  });
  return member ? toDirectoryMember(member) : null;
};

export interface MemberOffsetPage {
  members: DirectoryMember[];
  totalResults: number;
}

/**
 * SCIM protocol pagination (1-based startIndex/count) — deliberately NOT the
 * §3.5 cursor envelope; the SCIM dialect keeps its own wire format. Ordering
 * is stable (createdAt, userId) so IdP pagination never skips or repeats.
 */
export const listMembersOffset = async (
  organizationId: string,
  startIndex: number,
  count: number,
): Promise<MemberOffsetPage> => {
  const where = {
    organizationId,
    NOT: { userEmail: { endsWith: "@onecli.internal" } },
  };
  const [totalResults, members] = await Promise.all([
    db.organizationMember.count({ where }),
    count > 0
      ? db.organizationMember.findMany({
          where,
          select: memberSelect,
          orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
          skip: Math.max(startIndex - 1, 0),
          take: count,
        })
      : Promise.resolve([]),
  ]);
  return { members: members.map(toDirectoryMember), totalResults };
};

/**
 * Every SCIM audit is attributed to the org owner — the guaranteed
 * fixed-point identity (AuditLog.userId is a required FK and the token's
 * creator is nullable). The token id/label and the affected target ride in
 * metadata.
 */
export const resolveScimActor = async (
  organizationId: string,
): Promise<{ userId: string; userEmail: string }> => {
  const owner = await db.organizationMember.findFirst({
    where: { organizationId, role: "owner" },
    select: { userId: true, userEmail: true },
  });
  if (!owner) {
    // Every org is created with an owner; absence is data corruption.
    throw new ServiceError("NOT_FOUND", "Organization owner not found");
  }
  return owner;
};

// ── SCIM group reads (offset pagination + eq lookups, full member lists) ─

export interface ScimGroupRecord {
  id: string;
  name: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Null when the caller excluded members (Entra excludedAttributes). */
  members: { userId: string; email: string }[] | null;
}

const scimGroupBaseSelect = {
  id: true,
  name: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const scimGroupWithMembersSelect = {
  ...scimGroupBaseSelect,
  members: {
    select: { userId: true, user: { select: { email: true } } },
    orderBy: { userId: "asc" as const },
  },
} as const;

const toScimGroupRecord = (group: {
  id: string;
  name: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  members?: { userId: string; user: { email: string } }[];
}): ScimGroupRecord => ({
  id: group.id,
  name: group.name,
  externalId: group.externalId,
  createdAt: group.createdAt,
  updatedAt: group.updatedAt,
  members:
    group.members?.map((m) => ({ userId: m.userId, email: m.user.email })) ??
    null,
});

export type ScimGroupFilter =
  | { attribute: "displayname"; value: string }
  | { attribute: "externalid"; value: string };

export interface GroupOffsetPage {
  groups: ScimGroupRecord[];
  totalResults: number;
}

export const listGroupsOffset = async (
  organizationId: string,
  startIndex: number,
  count: number,
  options: { filter?: ScimGroupFilter; includeMembers: boolean },
): Promise<GroupOffsetPage> => {
  const where: {
    organizationId: string;
    name?: { equals: string; mode: "insensitive" };
    externalId?: string;
  } = { organizationId };
  if (options.filter?.attribute === "displayname") {
    // displayName is caseExact=false in the SCIM schema → insensitive eq.
    where.name = { equals: options.filter.value, mode: "insensitive" };
  } else if (options.filter?.attribute === "externalid") {
    where.externalId = options.filter.value; // caseExact=true
  }
  const orderBy = [{ createdAt: "asc" as const }, { id: "asc" as const }];
  const skip = Math.max(startIndex - 1, 0);
  // Two constant selects instead of one dynamic spread — Prisma's payload
  // typing only stays precise over literal select objects.
  const fetchGroups = async (): Promise<ScimGroupRecord[]> => {
    if (count <= 0) return [];
    if (options.includeMembers) {
      const rows = await db.group.findMany({
        where,
        select: scimGroupWithMembersSelect,
        orderBy,
        skip,
        take: count,
      });
      return rows.map(toScimGroupRecord);
    }
    const rows = await db.group.findMany({
      where,
      select: scimGroupBaseSelect,
      orderBy,
      skip,
      take: count,
    });
    return rows.map(toScimGroupRecord);
  };
  const [totalResults, groups] = await Promise.all([
    db.group.count({ where }),
    fetchGroups(),
  ]);
  return { groups, totalResults };
};

export const findScimGroupById = async (
  organizationId: string,
  groupId: string,
  includeMembers = true,
): Promise<ScimGroupRecord | null> => {
  const where = { id: groupId, organizationId };
  const group = includeMembers
    ? await db.group.findFirst({ where, select: scimGroupWithMembersSelect })
    : await db.group.findFirst({ where, select: scimGroupBaseSelect });
  return group ? toScimGroupRecord(group) : null;
};

// ── SCIM-managed groups (source: "scim"; bypass the manual guard) ────────

export const scimCreateGroup = (
  organizationId: string,
  displayName: string,
  externalId: string | null,
) => createGroupCore(organizationId, displayName, "scim", externalId);

export const scimRenameGroup = (
  organizationId: string,
  groupId: string,
  displayName: string,
) => renameGroupCore(organizationId, groupId, displayName);

export const scimDeleteGroup = (organizationId: string, groupId: string) =>
  deleteGroupCore(organizationId, groupId);

/** externalId is SCIM-owned; unique per (org, source) — collision → 409. */
export const scimSetGroupExternalId = async (
  organizationId: string,
  groupId: string,
  externalId: string | null,
): Promise<void> => {
  const group = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: { id: true },
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found");
  try {
    await db.group.update({ where: { id: group.id }, data: { externalId } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "A group with this externalId already exists.",
      );
    }
    throw err;
  }
};

export const scimSetGroupMembers = (
  organizationId: string,
  groupId: string,
  userIds: string[],
) => setGroupMembersCore(organizationId, groupId, userIds, null);

export const scimAddGroupMember = (
  organizationId: string,
  groupId: string,
  userId: string,
) => addGroupMemberCore(organizationId, groupId, userId, null);

export const scimRemoveGroupMember = (
  organizationId: string,
  groupId: string,
  userId: string,
) => removeGroupMemberCore(organizationId, groupId, userId);
