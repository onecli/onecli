import { db } from "@onecli/db";

// LICENSED-MIRROR: deliberate Apache twin of the gateway's licensed
// principal CTE (apps/gateway/crates/ee/ee/src/principals/resolve.rs). Free hot paths
// execute this file (credential injection, grants summaries, reflections),
// so it must NOT move into ee/ — declared in ee-boundary.ts LICENSED_MIRRORS.
//
// The TS mirror of the gateway's connect-time `find_principal_set` CTE —
// the set of principals the policy engine matches an
// agent's requests against: the humans the agent inherits from its workspace's
// WorkspaceAccess (direct users + members of granted groups, ACTIVE org members
// only), and every directory group those humans belong to. Role-agnostic
// (presence-only) and ORG-FENCED on every arm — a granted group or a user's
// membership in ANOTHER org's groups can never leak in. Agent-independent, so
// one resolution covers every agent of the workspace. Off the hot path (backs
// the read-only reflections); the gateway resolves its own
// set at connect. Keep in lockstep with the CTE.

export interface PrincipalSet {
  userIds: string[];
  groupIds: string[];
}

export const resolvePrincipalSet = async (
  workspaceId: string,
  organizationId: string,
): Promise<PrincipalSet> => {
  // WorkspaceAccess rows: direct users + candidate granted groups.
  const accessRows = await db.workspaceAccess.findMany({
    where: { workspaceId },
    select: { userId: true, groupId: true },
  });
  const directUserIds = accessRows.flatMap((r) => (r.userId ? [r.userId] : []));
  const groupCandidates = accessRows.flatMap((r) =>
    r.groupId ? [r.groupId] : [],
  );

  // direct_groups: org-fenced — a granted group must belong to this org.
  const directGroups = groupCandidates.length
    ? (
        await db.group.findMany({
          where: { id: { in: groupCandidates }, organizationId },
          select: { id: true },
        })
      ).map((g) => g.id)
    : [];

  // candidate_users: direct WorkspaceAccess users ∪ members of the direct groups.
  const groupMemberUserIds = directGroups.length
    ? (
        await db.groupMember.findMany({
          where: { groupId: { in: directGroups } },
          select: { userId: true },
        })
      ).map((m) => m.userId)
    : [];
  const candidateUserIds = [
    ...new Set([...directUserIds, ...groupMemberUserIds]),
  ];

  // all_users: only ACTIVE org members contribute — a suspended member is
  // excluded, mirroring the people-gate `user_can_manage_workspace`.
  const userIds = candidateUserIds.length
    ? (
        await db.organizationMember.findMany({
          where: {
            userId: { in: candidateUserIds },
            organizationId,
            status: { not: "suspended" },
          },
          select: { userId: true },
        })
      ).map((m) => m.userId)
    : [];

  // all_groups: the direct grants ∪ every group the inherited users belong to —
  // org-fenced, because a user can belong to OTHER orgs' groups.
  const userGroupIds = userIds.length
    ? (
        await db.groupMember.findMany({
          where: { userId: { in: userIds }, group: { organizationId } },
          select: { groupId: true },
        })
      ).map((m) => m.groupId)
    : [];
  const groupIds = [...new Set([...directGroups, ...userGroupIds])];

  return { userIds, groupIds };
};
