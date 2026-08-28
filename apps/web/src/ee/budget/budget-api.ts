import { apiGet, apiPost, apiDelete } from "@/lib/api/client";
// The API package owns the response/input contracts — import (don't re-declare)
// so the shapes can't drift. Type-only imports are erased, so no runtime/db pull-in.
import type { BudgetView } from "@onecli/api/ee/budget/budget-service";
import type { SetBudgetInput } from "@onecli/api/ee/budget/budget-validations";
import type { BudgetPeriod } from "@onecli/api/ee/budget/budget-pricing";

export type { BudgetView, SetBudgetInput, BudgetPeriod };

/**
 * Typed client for the budget endpoints (cloud-only). DORMANT: the partner
 * router that served these paths was removed, so nothing mounts them today —
 * the URLs are placeholders to re-point when a future budget surface exists;
 * the components/hooks can then be reused unchanged.
 */
export const budgetApi = {
  listForOrg: (orgId: string) =>
    apiGet<BudgetView[]>(`/v1/partner/orgs/${orgId}/budgets`),
  set: (orgId: string, secretId: string, input: SetBudgetInput) =>
    apiPost<BudgetView>(
      `/v1/partner/orgs/${orgId}/secrets/${secretId}/budget`,
      input,
    ),
  clear: (orgId: string, secretId: string) =>
    apiDelete(`/v1/partner/orgs/${orgId}/secrets/${secretId}/budget`),
};
