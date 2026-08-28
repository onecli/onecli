import { z } from "zod";
import { BUDGET_PERIODS } from "./budget-pricing";

/** Upper sanity bound on a budget limit: $1,000,000 (in cents). Not a policy. */
const MAX_LIMIT_CENTS = 100_000_000;

export const setBudgetSchema = z.object({
  limitCents: z.number().int().positive().max(MAX_LIMIT_CENTS),
  period: z.enum(BUDGET_PERIODS),
});

export type SetBudgetInput = z.infer<typeof setBudgetSchema>;
