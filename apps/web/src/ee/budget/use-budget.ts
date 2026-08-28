"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { budgetApi, type SetBudgetInput } from "./budget-api";

export const budgetKeys = {
  org: (orgId: string) => ["budget", "org", orgId] as const,
};

/** Budgets (+ current spend) for an org's budgeted secrets. */
export const useOrgBudgets = (orgId: string, enabled = true) =>
  useQuery({
    queryKey: budgetKeys.org(orgId),
    queryFn: () => budgetApi.listForOrg(orgId),
    enabled,
  });

export const useSetBudget = (orgId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { secretId: string } & SetBudgetInput) =>
      budgetApi.set(orgId, input.secretId, {
        limitCents: input.limitCents,
        period: input.period,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: budgetKeys.org(orgId) }),
  });
};

export const useClearBudget = (orgId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (secretId: string) => budgetApi.clear(orgId, secretId),
    onSuccess: () => qc.invalidateQueries({ queryKey: budgetKeys.org(orgId) }),
  });
};
