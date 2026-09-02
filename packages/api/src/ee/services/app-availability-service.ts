import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { getApp } from "../../apps/registry";

// ── App availability (policy-engine step 7) ─────────────────────────────────
// A SEPARATE org-level allowlist deciding which apps a workspace may connect (the
// provisioning gate; policy rules govern use). An org is "open" by default —
// every app available to everyone, non-regressing — or "restricted", where an
// app is available to a workspace only when a RULE that grants it names one of the
// workspace's inherited people (its WorkspaceAccess users/groups, active-only).
//
// A rule is a named bundle: a set of principals (users + groups) granted a set
// of apps. A person can be in multiple rules; a workspace's available apps are the
// UNION of every rule that names one of its people. Mirrors the PolicyRuleV2 +
// PolicyRuleIdentity shape but is a separate axis. EE-only.

export type AppAvailabilityMode = "open" | "restricted";

/** A named availability rule: principals (users + groups) → apps. */
export interface AvailabilityRule {
  /** Present for an existing rule (drives the update/create diff); absent = new. */
  id?: string;
  name?: string | null;
  userIds: string[];
  groupIds: string[];
  providers: string[];
}

export interface AppAvailabilityConfig {
  mode: AppAvailabilityMode;
  rules: AvailabilityRule[];
}

/**
 * Read the org's availability posture + rules (with their identities), oldest
 * first. A missing org row reads as "open" with no rules.
 */
export const getAppAvailability = async (
  organizationId: string,
): Promise<AppAvailabilityConfig> => {
  const [org, rules] = await Promise.all([
    db.organization.findUnique({
      where: { id: organizationId },
      select: { appAvailabilityMode: true },
    }),
    db.appAvailabilityRule.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        providers: true,
        identities: { select: { userId: true, groupId: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const mode: AppAvailabilityMode =
    org?.appAvailabilityMode === "restricted" ? "restricted" : "open";

  return {
    mode,
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      userIds: r.identities.flatMap((i) => (i.userId ? [i.userId] : [])),
      groupIds: r.identities.flatMap((i) => (i.groupId ? [i.groupId] : [])),
      providers: r.providers,
    })),
  };
};

/** A rule after dedup + no-op removal, ready to validate + persist. */
interface NormalizedRule {
  id?: string;
  name: string | null;
  userIds: string[];
  groupIds: string[];
  providers: string[];
}

/**
 * Dedupe each rule's principals + providers, and DROP no-op rules — a rule with
 * no identities OR no apps grants nothing, so it isn't persisted.
 */
const normalizeRules = (rules: AvailabilityRule[]): NormalizedRule[] =>
  rules
    .map((r) => ({
      id: r.id,
      name: r.name?.trim() ? r.name.trim() : null,
      userIds: [...new Set(r.userIds)],
      groupIds: [...new Set(r.groupIds)],
      providers: [...new Set(r.providers)],
    }))
    .filter(
      (r) =>
        (r.userIds.length > 0 || r.groupIds.length > 0) &&
        r.providers.length > 0,
    );

/**
 * Validate that every referenced principal + provider across all rules belongs
 * to the acting org (mirrors `assertIdentitiesValid`): every provider is a known
 * app, every user an ACTIVE org member, every group an org group. Rejects
 * cross-org IDOR.
 */
const assertRulesValid = async (
  organizationId: string,
  rules: NormalizedRule[],
): Promise<void> => {
  const providers = [...new Set(rules.flatMap((r) => r.providers))];
  const userIds = [...new Set(rules.flatMap((r) => r.userIds))];
  const groupIds = [...new Set(rules.flatMap((r) => r.groupIds))];

  const unknownProvider = providers.find((p) => !getApp(p));
  if (unknownProvider) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Unknown app provider: ${unknownProvider}`,
    );
  }

  // Each id set is deduped, so an exact count match proves every id resolved
  // inside this org — a foreign-org user/group can't slip in.
  const verify = async (ids: string[], count: () => Promise<number>) => {
    if (ids.length === 0) return;
    if ((await count()) !== ids.length) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "A referenced identity does not belong to this organization.",
      );
    }
  };

  await Promise.all([
    verify(userIds, () =>
      db.organizationMember.count({
        // Suspended members are non-members for authz (and the gateway excludes
        // them from the principal set) — a rule can't target one.
        where: {
          userId: { in: userIds },
          organizationId,
          status: { not: "suspended" },
        },
      }),
    ),
    verify(groupIds, () =>
      db.group.count({ where: { id: { in: groupIds }, organizationId } }),
    ),
  ]);
};

/**
 * Replace the org's availability posture + rules as one aggregate: validate
 * ownership, then diff the desired rules against the stored ones by id — delete
 * removed rules, update kept rules (replacing their identities), create new ones
 * — alongside the mode, in one transaction. Returns the resulting config.
 */
export const setAppAvailability = async (
  organizationId: string,
  input: AppAvailabilityConfig,
  actorUserId: string,
): Promise<AppAvailabilityConfig> => {
  const desired = normalizeRules(input.rules);
  await assertRulesValid(organizationId, desired);

  // A well-formed payload references each existing rule at most once. Reject a
  // duplicate id rather than let two entries update the same row (last-wins).
  const ids = desired.flatMap((r) => (r.id ? [r.id] : []));
  if (new Set(ids).size !== ids.length) {
    throw new ServiceError("BAD_REQUEST", "Duplicate rule id in the request.");
  }

  const current = await db.appAvailabilityRule.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const currentIds = new Set(current.map((r) => r.id));
  // A payload id only counts as "kept" if it's actually one of THIS org's rules
  // — a forged/foreign id falls through to a fresh create (never touches another
  // org's row).
  const keptIds = new Set(
    desired.flatMap((r) => (r.id && currentIds.has(r.id) ? [r.id] : [])),
  );
  const toDelete = [...currentIds].filter((id) => !keptIds.has(id));

  const identitiesOf = (r: NormalizedRule) => [
    ...r.userIds.map((userId) => ({ userId })),
    ...r.groupIds.map((groupId) => ({ groupId })),
  ];

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  // Removed rules (their identity rows cascade), org-fenced.
  if (toDelete.length > 0) {
    ops.push(
      db.appAvailabilityRule.deleteMany({
        where: { organizationId, id: { in: toDelete } },
      }),
    );
  }
  for (const rule of desired) {
    if (rule.id && keptIds.has(rule.id)) {
      const ruleId = rule.id;
      // Update the rule (org-fenced) + fully replace its identity rows.
      ops.push(
        db.appAvailabilityRule.updateMany({
          where: { id: ruleId, organizationId },
          data: { name: rule.name, providers: rule.providers },
        }),
        db.appAvailabilityRuleIdentity.deleteMany({ where: { ruleId } }),
        db.appAvailabilityRuleIdentity.createMany({
          data: identitiesOf(rule).map((i) => ({ ...i, ruleId })),
        }),
      );
    } else {
      ops.push(
        db.appAvailabilityRule.create({
          data: {
            organizationId,
            name: rule.name,
            providers: rule.providers,
            createdByUserId: actorUserId,
            identities: { create: identitiesOf(rule) },
          },
        }),
      );
    }
  }
  // The mode is idempotent — always written so a toggle-only change persists.
  ops.push(
    db.organization.update({
      where: { id: organizationId },
      data: { appAvailabilityMode: input.mode },
    }),
  );
  await db.$transaction(ops);

  return getAppAvailability(organizationId);
};

/**
 * The app-provider ids available to a workspace, or `null` when the org is "open"
 * (unrestricted → all apps). The TS mirror of the gateway's
 * `find_available_providers`: the union of the providers of every rule that
 * names one of the workspace's inherited people — its WorkspaceAccess users (direct
 * + members of granted groups), active-only, plus the groups to match (granted
 * directly + every group those users belong to). Every arm is org-fenced.
 *
 * Off the gateway hot path (this backs the connect-UI filter only); the gateway
 * resolves its own set once at connect. A handful of indexed queries, and only a
 * "restricted" org reaches past the first.
 */
export const deriveAvailableProviders = async (
  workspaceId: string,
  organizationId: string,
): Promise<string[] | null> => {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { appAvailabilityMode: true },
  });
  if (org?.appAvailabilityMode !== "restricted") return null; // open → all apps

  // WorkspaceAccess rows for the workspace: direct users + candidate groups.
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

  // all_users: only ACTIVE org members contribute (org-fenced + suspended out).
  const allUserIds = candidateUserIds.length
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

  // all_groups: direct groups ∪ org-fenced groups the inherited users belong to.
  const memberGroupIds = allUserIds.length
    ? (
        await db.groupMember.findMany({
          where: { userId: { in: allUserIds }, group: { organizationId } },
          select: { groupId: true },
        })
      ).map((m) => m.groupId)
    : [];
  const allGroupIds = [...new Set([...directGroups, ...memberGroupIds])];

  if (allUserIds.length === 0 && allGroupIds.length === 0) return [];

  // Rules in this org that name one of the inherited people → union of providers.
  const rules = await db.appAvailabilityRule.findMany({
    where: {
      organizationId,
      identities: {
        some: {
          OR: [
            ...(allUserIds.length ? [{ userId: { in: allUserIds } }] : []),
            ...(allGroupIds.length ? [{ groupId: { in: allGroupIds } }] : []),
          ],
        },
      },
    },
    select: { providers: true },
  });
  return [...new Set(rules.flatMap((r) => r.providers))];
};
