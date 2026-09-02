/**
 * Pure, DB-free budget helpers shared by the API and the web app (the web
 * re-exports this module). The actual per-token pricing lives in the gateway —
 * it's the only place that prices usage. Here we only need: which secret types
 * are meterable, the period-key format (which MUST match the gateway's), and
 * unit conversions for display.
 */

/** Secret types the gateway can meter today. Mirrors the gateway `has_meter`. */
export const METERED_SECRET_TYPES = ["anthropic"] as const;
export type MeteredSecretType = (typeof METERED_SECRET_TYPES)[number];

/** A budget can only be set on a secret whose usage the gateway can meter. */
export const isMeteredType = (type: string): boolean =>
  (METERED_SECRET_TYPES as readonly string[]).includes(type);

export const BUDGET_PERIODS = ["monthly", "total"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const isBudgetPeriod = (value: string): value is BudgetPeriod =>
  (BUDGET_PERIODS as readonly string[]).includes(value);

/**
 * Narrow a DB `period` string to `BudgetPeriod` without an unchecked assertion.
 * Falls back to `monthly` for any unexpected value (the column is only ever
 * written validated, so the fallback is defensive, not a real code path).
 */
export const toBudgetPeriod = (value: string): BudgetPeriod =>
  isBudgetPeriod(value) ? value : "monthly";

/**
 * The spend-window key for the *current* period. MUST match the gateway's
 * `ee/budget/spend.rs::period_key`: `m:YYYY-MM` (UTC) for monthly, `total`
 * for lifetime — both sides read/write the same `budget_spends.period` rows.
 */
export const currentPeriodKey = (period: BudgetPeriod): string => {
  if (period === "total") return "total";
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `m:${year}-${month}`;
};

/** Limits are stored in cents, spend in nano-dollars (1e-9). Display helpers. */
export const centsToUsd = (cents: number): number => cents / 100;
export const nanosToUsd = (nanos: number): number => nanos / 1e9;
