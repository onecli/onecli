import { db } from "@onecli/db";
import {
  normalizePlan,
  getPlanConfig,
  isPlanAtLeast,
  type Plan,
  type PlanLimits,
} from "../billing/plans";
import { requiredPlanFor, type PremiumFeature } from "../billing/plan-features";
import { ServiceError } from "../../services/errors";
import { isEnterpriseFeature, isEntitled } from "../../lib/entitlements";
import {
  assertEntitled,
  enterpriseLicenseMessage,
} from "../../lib/entitlements-guard";
import { CAPS } from "../../lib/env";
import { getRedis } from "../clients/redis-client";
import { redisKeys } from "../clients/redis-keys";

export class QuotaExceededError extends ServiceError {
  public readonly resource: string;
  public readonly current: number;
  public readonly limit: number;
  public readonly plan: Plan;

  constructor(resource: string, current: number, limit: number, plan: Plan) {
    super(
      "FORBIDDEN",
      `${resource} limit reached (${current}/${limit} on the ${getPlanConfig(plan).name} plan). Upgrade to add more.`,
    );
    this.name = "QuotaExceededError";
    this.resource = resource;
    this.current = current;
    this.limit = limit;
    this.plan = plan;
  }
}

// Non-billing editions are fully entitled — every quota is unbounded.
// Explicit per-field so a new PlanLimits key is a compile error here rather
// than a silently-finite limit.
const UNLIMITED_LIMITS: PlanLimits = {
  maxAgents: Infinity,
  maxWorkspaces: Infinity,
  maxSecrets: Infinity,
  maxOAuthApps: Infinity,
  maxMembers: Infinity,
  maxIntegrationCalls: Infinity,
  auditLogDays: Infinity,
};

const getOrgLimits = async (
  organizationId: string,
): Promise<{
  plan: Plan;
  limits: PlanLimits;
}> => {
  // Quotas are a billing concept. Editions without billing never gate on
  // them — return before any plan lookup or usage counting; they report the
  // top tier.
  if (!CAPS.billing) {
    return { plan: "enterprise", limits: UNLIMITED_LIMITS };
  }

  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      subscriptionStatus: true,
      maxAgentsOverride: true,
      maxMembersOverride: true,
    },
  });

  const plan = normalizePlan(org.subscriptionStatus);
  const planLimits = getPlanConfig(plan).limits;
  // maxAgentsOverride / maxMembersOverride are the ops-set per-org caps (SQL
  // only, no UI): null = plan default; a value replaces the plan's limit in
  // both directions (600 raises scale's 20 agents, 0 blocks all creation).
  // Applied to the plan limits here so every caller — the invite gate, the
  // pre-check dialog and the usage page — shares one answer.
  //
  // AWS Marketplace orgs are SOFT-capped on agents: the contract includes 10
  // but extras are allowed and metered as overage ($1,200/agent-year,
  // plans/aws-marketplace-listing.md §5), so agent creation is never blocked.
  // The ops override still wins if set (a kill switch for abuse).
  const maxAgents =
    org.maxAgentsOverride ??
    (plan === "aws-marketplace" ? Infinity : planLimits.maxAgents);
  return {
    plan,
    limits: {
      ...planLimits,
      maxAgents,
      maxMembers: org.maxMembersOverride ?? planLimits.maxMembers,
    },
  };
};

/**
 * Seats in use = every OrganizationMember row (suspended members and
 * @onecli.internal placeholders deliberately count — they hold usable
 * identities and workspaces) plus pending, unexpired invitations (an invite is
 * a committed seat until it's accepted, cancelled or expires — otherwise N
 * parallel invites at the cap could all accept and overshoot it).
 *
 * Shared by assertCanInviteMember and getUsageOverview so the invite gate,
 * the pre-check dialog and the usage page can never disagree. Expired-but-
 * uncleaned provision placeholders still count until their cleanup runs (the
 * team page and the invite/provision gates run it); that bounded drift only
 * ever over-counts, never under-counts.
 */
const countSeatsInUse = async (organizationId: string): Promise<number> => {
  const [members, pendingInvites] = await Promise.all([
    db.organizationMember.count({ where: { organizationId } }),
    db.invitation.count({
      where: {
        organizationId,
        status: "pending",
        expiresAt: { gte: new Date() },
      },
    }),
  ]);
  return members + pendingInvites;
};

export interface ResourceUsage {
  name: string;
  current: number;
  limit: number;
}

export interface UsageOverview {
  plan: Plan;
  resources: ResourceUsage[];
}

async function getIntegrationCallCount(
  organizationId: string,
): Promise<number> {
  try {
    const redis = getRedis();
    const key = redisKeys.quotaInjectionCalls(organizationId);
    const val = await redis.get(key);
    return val ? parseInt(val, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export async function getUsageOverview(
  organizationId: string,
): Promise<UsageOverview> {
  const { plan, limits } = await getOrgLimits(organizationId);

  const [workspaces, agents, secrets, oauthApps, seats, integrationCalls] =
    await Promise.all([
      db.workspace.count({ where: { organizationId } }),
      db.agent.count({ where: { workspace: { organizationId } } }),
      db.secret.count({ where: { workspace: { organizationId } } }),
      db.appConnection.count({ where: { workspace: { organizationId } } }),
      countSeatsInUse(organizationId),
      getIntegrationCallCount(organizationId),
    ]);

  return {
    plan,
    resources: [
      { name: "Workspaces", current: workspaces, limit: limits.maxWorkspaces },
      { name: "Agents", current: agents, limit: limits.maxAgents },
      { name: "Secrets", current: secrets, limit: limits.maxSecrets },
      { name: "OAuth apps", current: oauthApps, limit: limits.maxOAuthApps },
      {
        name: "Integration calls",
        current: integrationCalls,
        limit: limits.maxIntegrationCalls,
      },
      { name: "Members", current: seats, limit: limits.maxMembers },
    ],
  };
}

export async function assertCanCreateAgent(
  organizationId: string,
): Promise<void> {
  const { plan, limits } = await getOrgLimits(organizationId);
  if (limits.maxAgents === Infinity) return;

  const count = await db.agent.count({
    where: { workspace: { organizationId } },
  });

  if (count >= limits.maxAgents) {
    throw new QuotaExceededError("agents", count, limits.maxAgents, plan);
  }
}

export async function getWorkspaceQuota(organizationId: string) {
  const { plan, limits } = await getOrgLimits(organizationId);
  if (limits.maxWorkspaces === Infinity) {
    return { current: 0, limit: Infinity as number, plan };
  }
  const current = await db.workspace.count({ where: { organizationId } });
  return { current, limit: limits.maxWorkspaces, plan };
}

export async function assertCanCreateWorkspace(
  organizationId: string,
): Promise<void> {
  const { plan, limits } = await getOrgLimits(organizationId);
  if (limits.maxWorkspaces === Infinity) return;

  const count = await db.workspace.count({
    where: { organizationId },
  });

  if (count >= limits.maxWorkspaces) {
    throw new QuotaExceededError(
      "workspaces",
      count,
      limits.maxWorkspaces,
      plan,
    );
  }
}

export async function assertCanCreateSecret(
  organizationId: string,
): Promise<void> {
  const { plan, limits } = await getOrgLimits(organizationId);
  if (limits.maxSecrets === Infinity) return;

  const count = await db.secret.count({
    where: { workspace: { organizationId } },
  });

  if (count >= limits.maxSecrets) {
    throw new QuotaExceededError("secrets", count, limits.maxSecrets, plan);
  }
}

export async function assertCanCreateOAuthApp(
  organizationId: string,
): Promise<void> {
  const { plan, limits } = await getOrgLimits(organizationId);
  if (limits.maxOAuthApps === Infinity) return;

  const count = await db.appConnection.count({
    where: { workspace: { organizationId } },
  });

  if (count >= limits.maxOAuthApps) {
    throw new QuotaExceededError(
      "OAuth apps",
      count,
      limits.maxOAuthApps,
      plan,
    );
  }
}

/**
 * Gate a premium feature behind its required plan. Single server-side check
 * used by rule-action authorization and the policy-mode action; the required
 * plan per feature is single-sourced in `plan-features.ts`.
 */
export async function assertFeatureAllowed(
  organizationId: string,
  feature: PremiumFeature,
): Promise<void> {
  // Entitlement first: on self-host the enterprise-keyed features require the
  // license before any plan question. Plan-only features (deny-mode, manual
  // approvals, rate limits) have no enterprise key and stay free there.
  if (isEnterpriseFeature(feature)) {
    assertEntitled(feature);
  }
  const { plan } = await getOrgLimits(organizationId);
  const required = requiredPlanFor(feature);
  if (!isPlanAtLeast(plan, required)) {
    throw new ServiceError(
      "FORBIDDEN",
      `This feature requires the ${getPlanConfig(required).name} plan.`,
    );
  }
}

export async function assertCanUseGranularAccess(
  organizationId: string,
): Promise<void> {
  assertEntitled("granular_access");
  const { plan } = await getOrgLimits(organizationId);
  if (isPlanAtLeast(plan, "team")) return;
  throw new QuotaExceededError("granular access", 0, 0, plan);
}

/**
 * Sharing a workspace with other people (user WorkspaceAccess bindings) is a
 * team-tier capability. Group bindings are a separate, enterprise gate
 * (`assertFeatureAllowed(org, "groups")`).
 */
export async function assertCanShareWorkspace(
  organizationId: string,
): Promise<void> {
  assertEntitled("workspace_sharing");
  const { plan } = await getOrgLimits(organizationId);
  if (isPlanAtLeast(plan, "team")) return;
  throw new ServiceError(
    "FORBIDDEN",
    `Workspace sharing requires the ${getPlanConfig("team").name} plan.`,
  );
}

export async function assertCanInviteMember(
  organizationId: string,
): Promise<void> {
  const { plan, limits } = await getOrgLimits(organizationId);
  if (limits.maxMembers === Infinity) return;

  const count = await countSeatsInUse(organizationId);

  if (count >= limits.maxMembers) {
    throw new QuotaExceededError("members", count, limits.maxMembers, plan);
  }
}

/**
 * Account-level cap on how many FREE organizations a single user may OWN.
 *
 * Unlike the per-org quotas above (which read one org's plan), this is a flat
 * per-user limit not tied to any org's plan: a user can own at most
 * `MAX_FREE_ORGS_PER_USER` orgs whose `subscriptionStatus` is "free". Upgrading
 * an org to a paid plan or deleting one frees a slot.
 *
 * Only the user-initiated "New organization" flow calls this (via
 * `createOrganization`); the first-login auto-provision paths call
 * `bootstrapOrganization` directly and are intentionally exempt, so a user is
 * never blocked from getting their initial org. Users already over the cap are
 * not forced down — they simply can't create another free org until under it.
 *
 * Billing editions only: "free" is a plan, so like every quota this arm is
 * skipped when `!CAPS.billing` (the operator env cap above still applies).
 */
export const MAX_FREE_ORGS_PER_USER = 3;

/**
 * Operator-set flat cap on how many organizations a single user may OWN —
 * `MAX_ORGS_PER_USER` env, read at call time. Accepted range: any integer
 * >= 0. `0` is a real cap (creating ADDITIONAL orgs is denied; existing orgs
 * keep working — the auto-provision paths are exempt, see below); `1` keeps a
 * self-hosted instance single-org-per-user; unset, negative, or non-numeric =
 * unlimited. Cloud leaves it unset (the free-org cap below governs there).
 * Shared code + an env var — no edition branch.
 */
const maxOrgsPerUser = (): number | null => {
  const raw = Number.parseInt(process.env.MAX_ORGS_PER_USER ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
};

export async function assertCanCreateOrganization(
  userId: string,
): Promise<void> {
  // Multi-org is an enterprise feature (#64): without the license the cap is
  // forced to 1 — the operator env may only narrow it further, never raise
  // it. The first org (auto-provision paths) and joining other orgs stay
  // untouched; only user-initiated creation lands here.
  const envCap = maxOrgsPerUser();
  const entitled = isEntitled();
  const cap = entitled ? envCap : Math.min(envCap ?? 1, 1);
  if (cap !== null) {
    const ownedOrgs = await db.organizationMember.count({
      where: { userId, role: "owner" },
    });
    if (ownedOrgs >= cap) {
      throw new ServiceError(
        "FORBIDDEN",
        !entitled && (envCap === null || envCap > cap)
          ? enterpriseLicenseMessage("multi_org")
          : `This deployment allows ${cap} organization${cap === 1 ? "" : "s"} per user (${ownedOrgs}/${cap} used).`,
      );
    }
  }

  // The free-org cap is a BILLING concept ("free" is a plan). Exactly like
  // `getOrgLimits`, non-billing editions never gate on it — this keeps
  // onprem's "unset MAX_ORGS_PER_USER = unlimited" promise true.
  if (!CAPS.billing) return;

  const ownedFreeOrgs = await db.organizationMember.count({
    where: {
      userId,
      role: "owner",
      organization: { subscriptionStatus: "free" },
    },
  });

  if (ownedFreeOrgs >= MAX_FREE_ORGS_PER_USER) {
    throw new QuotaExceededError(
      "free organizations",
      ownedFreeOrgs,
      MAX_FREE_ORGS_PER_USER,
      "free",
    );
  }
}

/** Whether the user may create another organization (the assert as a read). */
export async function canCreateOrganization(userId: string): Promise<boolean> {
  try {
    await assertCanCreateOrganization(userId);
    return true;
  } catch (err) {
    // Only a ServiceError (incl. QuotaExceededError) means "capped" — an
    // infra failure (db down, etc.) must propagate, not read as "not allowed".
    if (err instanceof ServiceError) return false;
    throw err;
  }
}
