// Periodic driver for AWS Marketplace overage metering
// (plans/aws-marketplace-listing.md §6). Started once by the api-server on
// cloud; a no-op when the listing is not configured. Daily cadence: annual
// agent-year overage only ever ADDS records, so a missed run self-heals on
// the next one (idempotency lives in the service's metered-record key).
// Each run also re-syncs entitlements for linked buyers, so a dropped
// EventBridge license event self-heals within a day.

import { db } from "@onecli/db";
import { countOrgAgents, meterOverages, syncEntitlements } from "./service";
import { isAwsMarketplaceConfigured } from "./env";
import { logger } from "../../../lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

async function resyncAllEntitlements() {
  const subs = await db.awsMarketplaceSubscription.findMany({
    where: { status: { in: ["subscribed", "pending"] } },
    select: { customerAwsAccountId: true },
  });
  for (const sub of subs) {
    await syncEntitlements(sub.customerAwsAccountId).catch((err) =>
      logger.error(
        { err, customerAwsAccountId: sub.customerAwsAccountId },
        "aws-marketplace: periodic entitlement re-sync failed",
      ),
    );
  }
}

export function startAwsMarketplaceMeteringJob(): NodeJS.Timeout | null {
  if (!isAwsMarketplaceConfigured()) return null;

  const run = () =>
    resyncAllEntitlements()
      .then(() => meterOverages(countOrgAgents))
      .catch((err) =>
        logger.error({ err }, "aws-marketplace: metering job run failed"),
      );

  // First run shortly after boot (not immediately: let the pool warm up),
  // then daily.
  setTimeout(run, 60_000).unref();
  const interval = setInterval(run, DAY_MS);
  interval.unref();
  logger.info("aws-marketplace: overage metering job scheduled (daily)");
  return interval;
}
