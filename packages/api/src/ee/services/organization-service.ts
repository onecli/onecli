import { db, Prisma } from "@onecli/db";
import {
  slugify,
  bootstrapOrganization,
  validateOrgName,
} from "../../services/organization-service";
import { ServiceError } from "../../services/errors";
import { isEntitled } from "../../lib/entitlements";
import { enterpriseLicenseMessage } from "../../lib/entitlements-guard";
import { getStripe } from "../billing/stripe";
import { deleteWorkspace } from "./workspace-service";
import { assertCanCreateOrganization } from "./quota-service";
import { logger } from "../../lib/logger";
import { invalidateGatewayCacheForKeys } from "../../lib/gateway-invalidate";

export { slugify, validateOrgName };

const log = logger.child({ component: "organization" });

/**
 * User-initiated org creation (the "New organization" flow). Enforces the
 * per-user free-org cap, then delegates to the shared bootstrap. The first-login
 * auto-provision paths call `bootstrapOrganization` directly and stay exempt, so
 * a user is never blocked from getting their initial org.
 */
export const createOrganization = async (
  userId: string,
  userEmail: string,
  displayName?: string,
) => {
  await assertCanCreateOrganization(userId);
  try {
    return await bootstrapOrganization(userId, userEmail, displayName);
  } catch (err) {
    // The org slug is `slugify(name)-<userId prefix>`, so a unique-constraint
    // violation on a freshly-created org can only be the `slug` — i.e. this user
    // already owns an org whose name derives the same slug. Translate it into a
    // friendly 409 instead of leaking the raw Prisma error to the toast.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        displayName
          ? `You already have an organization named "${displayName}". Please choose a different name.`
          : "You already have an organization with this name. Please choose a different name.",
      );
    }
    throw err;
  }
};

/**
 * Delete an organization's non-workspace children and the org row, inside an
 * existing transaction. Precondition: the org's WORKSPACES are already deleted (the
 * workspace-deletion strategy differs per caller, so it stays with the caller).
 * Idempotent — every step is a `deleteMany`; the final `organization.delete` runs
 * on a still-present org.
 *
 * Single source of truth for "what is an org's children", used by
 * `deleteOrganization` (dashboard). `budget`/`budgetSpend` are orphan cleanup
 * (`budget_spends` has no FK).
 */
export const deleteOrganizationContent = async (
  organizationId: string,
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
) => {
  await tx.auditLog.deleteMany({ where: { organizationId } });
  // Org-tier skills: Restrict FK — the explicit line IS the deletion path
  // (workspaces are precondition-deleted, so only org-tier rows remain here).
  await tx.skill.deleteMany({ where: { organizationId } });
  await tx.secret.deleteMany({ where: { organizationId } });
  await tx.apiKey.deleteMany({ where: { organizationId } });
  await tx.appConfig.deleteMany({ where: { organizationId } });
  await tx.appConnection.deleteMany({ where: { organizationId } });
  await tx.invitation.deleteMany({ where: { organizationId } });
  await tx.userProvision.deleteMany({ where: { organizationId } });
  await tx.budget.deleteMany({ where: { organizationId } });
  await tx.budgetSpend.deleteMany({ where: { organizationId } });
  await tx.organizationMember.deleteMany({ where: { organizationId } });
  await tx.organization.delete({ where: { id: organizationId } });
};

export const deleteOrganization = async (
  organizationId: string,
  userId: string,
) => {
  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    select: { role: true, status: true },
  });
  if (
    !membership ||
    membership.status === "suspended" ||
    membership.role !== "owner"
  ) {
    throw new Error("Only the organization owner can delete it");
  }

  // Freeze posture (#64): owning several orgs is enterprise state, and without
  // the license that state is immutable — deletes included. Owning exactly one
  // org is the free single-org lifecycle, which keeps its delete.
  if (!isEntitled()) {
    const ownedOrgs = await db.organizationMember.count({
      where: { userId, role: "owner" },
    });
    if (ownedOrgs > 1) {
      throw new ServiceError(
        "FORBIDDEN",
        enterpriseLicenseMessage("multi_org"),
      );
    }
  }

  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      stripeCustomerId: true,
      workspaces: { select: { id: true } },
    },
  });

  if (org.stripeCustomerId) {
    const stripe = getStripe();
    const subs = await stripe.subscriptions.list({
      customer: org.stripeCustomerId,
      status: "active",
    });
    for (const sub of subs.data) {
      await stripe.subscriptions.cancel(sub.id);
    }
  }

  // Workspaces first, each in its own bounded transaction (request_logs aren't
  // pruned, so a single org-wide tx could be huge). Re-querying org.workspaces on
  // every call makes this loop idempotent on retry.
  for (const workspace of org.workspaces) {
    await deleteWorkspace(workspace.id);
  }

  // The workspace loop above already flushed each workspace's keys. The org-scoped
  // keys (scope: "organization") are removed by deleteOrganizationContent, so
  // capture them inside that transaction and flush after it commits — otherwise
  // a deleted org key keeps being served from the gateway cache until its TTL.
  const orgKeys = await db.$transaction(async (tx) => {
    const apiKeys = await tx.apiKey.findMany({
      where: { organizationId },
      select: { key: true },
    });
    await deleteOrganizationContent(organizationId, tx);
    return apiKeys;
  });
  invalidateGatewayCacheForKeys(orgKeys.map((k) => k.key));

  log.info(
    { organizationId, orgName: org.name, userId },
    "organization deleted",
  );
};
