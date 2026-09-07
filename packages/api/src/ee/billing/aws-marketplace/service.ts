// AWS Marketplace subscription lifecycle (plans/aws-marketplace-listing.md)
// on the Concurrent Agreements standard: a buyer (CustomerAWSAccountId) can
// hold multiple concurrent licenses (LicenseArn) for the product, each with
// its own entitlements; usage is metered against a specific license.
// Registration (fulfillment), entitlement sync, and annual agent-year
// overage metering. All writes here own `subscriptionStatus =
// "aws-marketplace"`; Stripe paths are guarded against touching it.

import { db } from "@onecli/db";
import { getAwsMarketplaceClient } from "./client";
import {
  AWS_MARKETPLACE_CONTRACT_DIMENSION,
  AWS_MARKETPLACE_INCLUDED_AGENTS,
  AWS_MARKETPLACE_OVERAGE_DIMENSION,
} from "./env";
import { logger } from "../../../lib/logger";
import { notifyDiscord } from "../../notifications/discord";

export class AwsMarketplaceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_TOKEN"
      | "ALREADY_LINKED"
      | "ORG_ALREADY_MARKETPLACE"
      | "NOT_SUBSCRIBED",
    message: string,
  ) {
    super(message);
    this.name = "AwsMarketplaceError";
  }
}

/**
 * Complete marketplace registration: resolve the buyer from the fulfillment
 * token, link them to `organizationId`, pull entitlements, and activate the
 * plan. Idempotent for the same buyer+org pair — a repeat redirect (or a
 * second concurrent agreement by the same buyer) just re-syncs entitlements,
 * which picks up the new license.
 */
export async function registerMarketplaceCustomer(params: {
  organizationId: string;
  registrationToken: string;
  /** Email of the org admin completing registration (ops notification). */
  registrantEmail?: string;
}) {
  const client = getAwsMarketplaceClient();

  let resolved;
  try {
    resolved = await client.resolveCustomer(params.registrationToken);
  } catch (err) {
    logger.warn({ err }, "aws-marketplace: ResolveCustomer failed");
    throw new AwsMarketplaceError(
      "INVALID_TOKEN",
      "The AWS Marketplace registration token is invalid or expired. Return to AWS Marketplace and click 'Set up your account' again.",
    );
  }

  const existing = await db.awsMarketplaceSubscription.findUnique({
    where: { customerAwsAccountId: resolved.customerAwsAccountId },
  });
  if (existing && existing.organizationId !== params.organizationId) {
    throw new AwsMarketplaceError(
      "ALREADY_LINKED",
      "This AWS Marketplace subscription is already linked to a different organization. Contact support@onecli.sh to move it.",
    );
  }

  const orgSub = await db.awsMarketplaceSubscription.findUnique({
    where: { organizationId: params.organizationId },
  });
  if (orgSub && orgSub.customerAwsAccountId !== resolved.customerAwsAccountId) {
    throw new AwsMarketplaceError(
      "ORG_ALREADY_MARKETPLACE",
      "This organization is already linked to a different AWS Marketplace subscription.",
    );
  }

  const isNewLink = !existing;
  const subscription = await db.awsMarketplaceSubscription.upsert({
    where: { customerAwsAccountId: resolved.customerAwsAccountId },
    create: {
      organizationId: params.organizationId,
      customerAwsAccountId: resolved.customerAwsAccountId,
      productCode: resolved.productCode,
      status: "pending",
    },
    update: {},
  });

  if (isNewLink) {
    notifyDiscord("payment", {
      email: params.registrantEmail ?? "(aws-marketplace registration)",
      organizationId: params.organizationId,
      plan: "aws-marketplace",
      type: "new_subscription",
    });
  }

  await syncEntitlements(subscription.customerAwsAccountId);
  return db.awsMarketplaceSubscription.findUniqueOrThrow({
    where: { id: subscription.id },
  });
}

/**
 * Pull entitlements for a buyer and converge local state. Entitlements are
 * grouped by LicenseArn (one group per concurrent agreement); each group
 * becomes a license row, absent groups mean the license ended. The
 * subscription aggregates across active licenses: entitled agents, latest
 * expiry, status, and the org's plan. Called on registration and from
 * every marketplace license event.
 */
export async function syncEntitlements(customerAwsAccountId: string) {
  const subscription = await db.awsMarketplaceSubscription.findUnique({
    where: { customerAwsAccountId },
    include: { licenses: true },
  });
  if (!subscription) {
    logger.warn(
      { customerAwsAccountId },
      "aws-marketplace: entitlement sync for unknown buyer (registration not completed yet)",
    );
    return null;
  }

  const client = getAwsMarketplaceClient();
  const entitlements = await client.getEntitlements(customerAwsAccountId);

  const now = new Date();
  const active = entitlements.filter(
    (e) => e.expirationDate === null || e.expirationDate > now,
  );

  // Group by license: each concurrent agreement grants one license with its
  // own entitlement set (same dimensions, independent values/rates).
  const byLicense = new Map<string, typeof active>();
  for (const e of active) {
    if (!e.licenseArn) continue;
    const group = byLicense.get(e.licenseArn) ?? [];
    group.push(e);
    byLicense.set(e.licenseArn, group);
  }

  // Converge license rows: upsert active ones, deprovision the rest.
  for (const [licenseArn, group] of byLicense) {
    const contract = group.find(
      (e) => e.dimension === AWS_MARKETPLACE_CONTRACT_DIMENSION,
    );
    // Committed agents on this license = the base contract (its Value is
    // the included agent count as configured in the listing, normally 10)
    // plus any committed extras on other dimensions from private offers.
    const licenseAgents = contract
      ? Math.max(contract.value, AWS_MARKETPLACE_INCLUDED_AGENTS) +
        group
          .filter((e) => e.dimension !== AWS_MARKETPLACE_CONTRACT_DIMENSION)
          .reduce((sum, e) => sum + e.value, 0)
      : 0;
    const expiries = group
      .map((e) => e.expirationDate)
      .filter((d): d is Date => d !== null);
    const expiresAt =
      expiries.length > 0
        ? new Date(Math.max(...expiries.map((d) => d.getTime())))
        : null;

    await db.awsMarketplaceLicense.upsert({
      where: { licenseArn },
      create: {
        subscriptionId: subscription.id,
        licenseArn,
        status: contract ? "active" : "deprovisioned",
        entitledAgents: licenseAgents,
        expiresAt,
        rawEntitlements: JSON.parse(JSON.stringify(group)),
      },
      update: {
        status: contract ? "active" : "deprovisioned",
        entitledAgents: licenseAgents,
        expiresAt,
        rawEntitlements: JSON.parse(JSON.stringify(group)),
      },
    });
  }
  for (const known of subscription.licenses) {
    if (!byLicense.has(known.licenseArn) && known.status === "active") {
      await db.awsMarketplaceLicense.update({
        where: { licenseArn: known.licenseArn },
        data: { status: "deprovisioned" },
      });
    }
  }

  // Aggregate the subscription from its active licenses.
  const licenses = await db.awsMarketplaceLicense.findMany({
    where: { subscriptionId: subscription.id, status: "active" },
  });
  const entitledAgents = licenses.reduce((s, l) => s + l.entitledAgents, 0);
  const licenseExpiries = licenses
    .map((l) => l.expiresAt)
    .filter((d): d is Date => d !== null);
  const contractExpiresAt =
    licenseExpiries.length > 0
      ? new Date(Math.max(...licenseExpiries.map((d) => d.getTime())))
      : null;
  // No active license: a buyer who never had one is still "pending" (they
  // may have reached registration before AWS confirmed the purchase); a
  // buyer who HAD licenses is "unsubscribed".
  const everHadLicense =
    licenses.length > 0 ||
    subscription.licenses.length > 0 ||
    byLicense.size > 0;
  const status =
    licenses.length > 0
      ? "subscribed"
      : everHadLicense
        ? "unsubscribed"
        : "pending";

  await db.awsMarketplaceSubscription.update({
    where: { customerAwsAccountId },
    data: { status, entitledAgents, contractExpiresAt },
  });

  // Converge the org plan. Activation flips the org onto the marketplace
  // plan; loss of every license downgrades to free (data intact, over-limit
  // agents blocked from new starts by quota checks). The downgrade arm only
  // fires for orgs currently ON the marketplace plan: a buyer can reach
  // registration before their purchase is confirmed (no license yet), and
  // that must never stomp an existing Stripe plan.
  if (status === "subscribed") {
    await db.organization.updateMany({
      where: { id: subscription.organizationId },
      data: { subscriptionStatus: "aws-marketplace" },
    });
  } else {
    await db.organization.updateMany({
      where: {
        id: subscription.organizationId,
        subscriptionStatus: "aws-marketplace",
      },
      data: { subscriptionStatus: "free" },
    });
  }

  logger.info(
    {
      customerAwsAccountId,
      organizationId: subscription.organizationId,
      status,
      entitledAgents,
      activeLicenses: licenses.length,
    },
    "aws-marketplace: entitlements synced",
  );

  return { status, entitledAgents, contractExpiresAt };
}

/**
 * Annual agent-year overage metering. For each subscribed marketplace org,
 * compare the current number of agents against included + committed +
 * already-metered for this contract year, and meter the delta once. Each
 * extra agent slot is billed exactly once per contract year
 * (AwsMarketplaceMeteredRecord's unique key). Usage is billed against the
 * buyer's newest active license (Concurrent Agreements: BatchMeterUsage
 * requires a LicenseArn to pick the rate card).
 *
 * `countAgents` abstracts "agent instances connected to OneCLI" so the
 * caller (api-server job) supplies the live count query.
 */
export async function meterOverages(
  countAgents: (organizationId: string) => Promise<number>,
) {
  const subs = await db.awsMarketplaceSubscription.findMany({
    where: { status: "subscribed" },
    include: { licenses: { where: { status: "active" } } },
  });

  for (const sub of subs) {
    try {
      const billingLicense = pickBillingLicense(sub.licenses);
      if (!billingLicense) {
        logger.warn(
          { organizationId: sub.organizationId },
          "aws-marketplace: subscribed org has no active license to bill against",
        );
        continue;
      }

      const agentCount = await countAgents(sub.organizationId);
      await meterOverageDelta(sub, agentCount, billingLicense.licenseArn);
    } catch (err) {
      logger.error(
        { err, organizationId: sub.organizationId },
        "aws-marketplace: overage metering failed",
      );
    }
  }
}

/**
 * "License Deprovisioned" handling: AWS gives ~1 hour after the event to
 * submit final usage against the ending license before metering closes.
 * Meter any outstanding overage against that license first, then re-sync
 * entitlements (which deprovisions the license row and downgrades the org
 * when no other active license remains).
 */
export async function handleLicenseDeprovisioned(params: {
  customerAwsAccountId: string;
  licenseArn: string;
  countAgents?: (organizationId: string) => Promise<number>;
}) {
  const countAgents = params.countAgents ?? countOrgAgents;
  const sub = await db.awsMarketplaceSubscription.findUnique({
    where: { customerAwsAccountId: params.customerAwsAccountId },
  });
  if (sub && sub.status === "subscribed") {
    try {
      const agentCount = await countAgents(sub.organizationId);
      await meterOverageDelta(sub, agentCount, params.licenseArn);
    } catch (err) {
      logger.error(
        { err, organizationId: sub.organizationId },
        "aws-marketplace: final usage metering on deprovision failed",
      );
    }
  }
  return syncEntitlements(params.customerAwsAccountId);
}

/** Default "agent instances connected to OneCLI" = the org's agents. */
export const countOrgAgents = (organizationId: string) =>
  db.agent.count({ where: { workspace: { organizationId } } });

/**
 * Meter the overage delta for one subscription against `licenseArn`.
 * No-op when current usage is covered by entitlement + already-metered.
 */
async function meterOverageDelta(
  sub: {
    organizationId: string;
    customerAwsAccountId: string;
    entitledAgents: number;
    createdAt: Date;
    contractExpiresAt: Date | null;
  },
  agentCount: number,
  licenseArn: string,
) {
  const contractYearStart = currentContractYearStart(sub);

  const metered = await db.awsMarketplaceMeteredRecord.aggregate({
    where: {
      organizationId: sub.organizationId,
      dimension: AWS_MARKETPLACE_OVERAGE_DIMENSION,
      contractYearStart,
    },
    _sum: { quantity: true },
  });
  const alreadyMetered = metered._sum.quantity ?? 0;
  const coveredThrough = sub.entitledAgents + alreadyMetered;
  const delta = agentCount - coveredThrough;
  if (delta <= 0) return;

  const usageTimestamp = new Date();
  // First agent slot this record bills: everything through
  // entitled + already-metered is covered, so the range starts right
  // after it.
  const quantityOrdinal = coveredThrough + 1;

  // Record first (idempotency), then meter; stamp the AWS record id on
  // success. A crash between the two leaves a record without an id —
  // surfaced by ops tooling rather than double-billed.
  const record = await db.awsMarketplaceMeteredRecord.create({
    data: {
      organizationId: sub.organizationId,
      licenseArn,
      dimension: AWS_MARKETPLACE_OVERAGE_DIMENSION,
      quantity: delta,
      contractYearStart,
      quantityOrdinal,
      usageTimestamp,
    },
  });

  const result = await getAwsMarketplaceClient().meterUsage({
    customerAwsAccountId: sub.customerAwsAccountId,
    licenseArn,
    dimension: AWS_MARKETPLACE_OVERAGE_DIMENSION,
    quantity: delta,
    timestamp: usageTimestamp,
  });

  await db.awsMarketplaceMeteredRecord.update({
    where: { id: record.id },
    data: { meteringRecordId: result.meteringRecordId },
  });

  logger.info(
    {
      organizationId: sub.organizationId,
      licenseArn,
      delta,
      agentCount,
      coveredThrough,
      status: result.status,
    },
    "aws-marketplace: overage metered",
  );
}

/**
 * The license overage bills against: the active license with the latest
 * expiry (null = no explicit expiry = furthest horizon). With one license
 * — the overwhelmingly common case — that is simply the license; with
 * concurrent agreements it is the newest commitment.
 */
export function pickBillingLicense<
  L extends { licenseArn: string; expiresAt: Date | null },
>(licenses: L[]): L | null {
  if (licenses.length === 0) return null;
  return [...licenses].sort((a, b) => {
    const at = a.expiresAt?.getTime() ?? Infinity;
    const bt = b.expiresAt?.getTime() ?? Infinity;
    return bt - at;
  })[0]!;
}

/** Start of the contract year the current moment falls in. */
export function currentContractYearStart(sub: {
  createdAt: Date;
  contractExpiresAt: Date | null;
}): Date {
  // Anchor on contract expiry when known (expiry minus 12 months), else on
  // the registration date.
  if (sub.contractExpiresAt) {
    const start = new Date(sub.contractExpiresAt);
    start.setFullYear(start.getFullYear() - 1);
    // Multi-year private offers: walk forward to the year containing now.
    const now = new Date();
    while (start > now) start.setFullYear(start.getFullYear() - 1);
    const next = new Date(start);
    next.setFullYear(next.getFullYear() + 1);
    while (next <= now) {
      start.setFullYear(start.getFullYear() + 1);
      next.setFullYear(next.getFullYear() + 1);
    }
    return start;
  }
  return sub.createdAt;
}
