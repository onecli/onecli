import { db } from "@onecli/db";

// The TS mirror of the gateway's connect-time `find_principal_set` CTE
// (apps/gateway/src/db.rs) — the set of principals the policy engine matches an
// agent's requests against: the agent's agent-groups, the humans the agent
// inherits from its project's ProjectAccess (direct users + members of granted
// groups, ACTIVE org members only), and every directory group those humans
// belong to. Role-agnostic (presence-only) and ORG-FENCED on every arm — a
// granted group or a user's membership in ANOTHER org's groups can never leak
// in. Off the hot path (backs the resolved-identity view + the simulator); the
// gateway resolves its own set at connect. Keep in lockstep with the CTE.

export interface PrincipalSet {
  agentGroupIds: string[];
  userIds: string[];
  groupIds: string[];
}

/** The PROJECT-level arms of the principal set (everything except the agent's
 * own agent-groups) — agent-INDEPENDENT, so a caller resolving many agents of
 * one project (the connection reflection) resolves these once and batches only
 * the per-agent agent-group arm. */
export interface ProjectPrincipals {
  userIds: string[];
  groupIds: string[];
}

export const resolvePrincipalSet = async (
  agentId: string,
  projectId: string,
  organizationId: string,
): Promise<PrincipalSet> => {
  // agent_groups_matched: the agent's groups, org-fenced via the group row.
  const agentGroupIds = (
    await db.agentGroupMember.findMany({
      where: { agentId, agentGroup: { organizationId } },
      select: { agentGroupId: true },
    })
  ).map((m) => m.agentGroupId);

  const { userIds, groupIds } = await resolveProjectPrincipals(
    projectId,
    organizationId,
  );
  return { agentGroupIds, userIds, groupIds };
};

export const resolveProjectPrincipals = async (
  projectId: string,
  organizationId: string,
): Promise<ProjectPrincipals> => {
  // ProjectAccess rows: direct users + candidate granted groups.
  const accessRows = await db.projectAccess.findMany({
    where: { projectId },
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

  // candidate_users: direct ProjectAccess users ∪ members of the direct groups.
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
  // excluded, mirroring the people-gate `user_can_manage_project`.
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
