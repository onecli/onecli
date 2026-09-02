import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { assertEntitled } from "../../lib/entitlements-guard";
import {
  currentPeriodKey,
  isMeteredType,
  toBudgetPeriod,
  type BudgetPeriod,
} from "./budget-pricing";
import type { SetBudgetInput } from "./budget-validations";

/**
 * DORMANT: the partner surface that mounted these operations was removed, so
 * nothing calls them over HTTP today. The service is kept (with the gateway
 * engine and the `budgets`/`budget_spends` tables) for a future budget
 * surface — which must bring its own authorization (these functions verify
 * only entitlement and that the secret is meterable, not who may budget it)
 * AND widen the gateway binder's eligibility (`apps/gateway/crates/ee/ee/src/budget/
 * binding.rs`, `BUDGET_ELIGIBLE_SCOPE`) in the same change, or budgets set
 * here would never bind or meter.
 */

/** nano-dollars per cent (spend is stored in nanos; the UI works in cents). */
const NANOS_PER_CENT = 10_000_000n;

/** Convert a nano-dollar BigInt to whole cents (BigInt math avoids `Number` precision loss). */
const nanosToCents = (nanos: bigint): number => Number(nanos / NANOS_PER_CENT);

export interface BudgetView {
  secretId: string;
  organizationId: string;
  limitCents: number;
  period: BudgetPeriod;
  /**
   * Accumulated spend for the current period, in **cents**. Derived (via BigInt
   * math) from the durable Postgres floor (`budget_spends.spentNanos`), which
   * the gateway writes behind the live Redis counter — so it can lag live spend
   * by up to ~5s. Cents keep the value in JS safe-integer range and match the
   * UI's unit.
   */
  spentCents: number;
}

/**
 * Verify the secret exists and is meterable. Throws `ServiceError` so a route
 * can map it to 404/400.
 */
const assertMeteredSecret = async (secretId: string): Promise<void> => {
  const secret = await db.secret.findUnique({
    where: { id: secretId },
    select: { type: true },
  });
  if (!secret) {
    throw new ServiceError("NOT_FOUND", "Secret not found.");
  }
  if (!isMeteredType(secret.type)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Budgets aren't supported for ${secret.type} secrets yet.`,
    );
  }
};

const spentCentsFor = async (
  secretId: string,
  organizationId: string,
  period: BudgetPeriod,
): Promise<number> => {
  const row = await db.budgetSpend.findUnique({
    where: {
      secretId_organizationId_period: {
        secretId,
        organizationId,
        period: currentPeriodKey(period),
      },
    },
    select: { spentNanos: true },
  });
  return row ? nanosToCents(row.spentNanos) : 0;
};

/** Create or replace the budget for a (secret, org) pair. */
export const setBudget = async (
  organizationId: string,
  secretId: string,
  input: SetBudgetInput,
  createdBy: string,
): Promise<BudgetView> => {
  assertEntitled("budget");
  await assertMeteredSecret(secretId);

  const period = toBudgetPeriod(input.period);
  const [, spentCents] = await Promise.all([
    db.budget.upsert({
      where: {
        secretId_organizationId: {
          secretId,
          organizationId,
        },
      },
      create: {
        secretId,
        organizationId,
        limitCents: input.limitCents,
        period: input.period,
        createdBy,
      },
      update: { limitCents: input.limitCents, period: input.period },
      select: { id: true },
    }),
    spentCentsFor(secretId, organizationId, period),
  ]);

  return {
    secretId,
    organizationId,
    limitCents: input.limitCents,
    period,
    spentCents,
  };
};

/** Remove the budget for a (secret, org) pair (no-op if none exists). */
export const clearBudget = async (
  organizationId: string,
  secretId: string,
): Promise<void> => {
  assertEntitled("budget");
  await db.budget.deleteMany({
    where: { secretId, organizationId },
  });
};

/** All budgets configured for an org, with current spend. */
export const listBudgetsForOrg = async (
  organizationId: string,
): Promise<BudgetView[]> => {
  assertEntitled("budget");
  const budgets = await db.budget.findMany({
    where: { organizationId },
    select: { secretId: true, limitCents: true, period: true },
  });
  if (budgets.length === 0) return [];

  const views = budgets.map((b) => {
    const period = toBudgetPeriod(b.period);
    return {
      secretId: b.secretId,
      limitCents: b.limitCents,
      period,
      periodKey: currentPeriodKey(period),
    };
  });

  // One query for every relevant spend row (no N+1).
  const spendRows = await db.budgetSpend.findMany({
    where: {
      organizationId,
      secretId: { in: views.map((v) => v.secretId) },
      period: { in: views.map((v) => v.periodKey) },
    },
    select: { secretId: true, period: true, spentNanos: true },
  });
  const spentByKey = new Map(
    spendRows.map((r) => [`${r.secretId}:${r.period}`, r.spentNanos]),
  );

  return views.map((v) => ({
    secretId: v.secretId,
    organizationId,
    limitCents: v.limitCents,
    period: v.period,
    spentCents: nanosToCents(
      spentByKey.get(`${v.secretId}:${v.periodKey}`) ?? 0n,
    ),
  }));
};
