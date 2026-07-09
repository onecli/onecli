"use client";

// Headless on the gateway cache: every rules mutation route audits, and the
// audit auto-flushes the gateway server-side — no client-side flush needed.
// (Create lives in the rule forms, which own their dialog/toast sequencing.)

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { rules, type PageScope, type UpdateRuleInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useRules = (scope: PageScope = "project") =>
  useQuery({
    queryKey: queryKeys.rules.list(scope),
    queryFn: () => rules.list(scope),
  });

export const useUpdateRule = (scope: PageScope = "project") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ruleId,
      input,
    }: {
      ruleId: string;
      input: UpdateRuleInput;
    }) => rules.update(ruleId, input, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.rules.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
    },
    onError: () => toast.error("Failed to update rule"),
  });
};

export const useDeleteRule = (scope: PageScope = "project") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) => rules.remove(ruleId, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.rules.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      toast.success("Rule deleted");
    },
    onError: () => toast.error("Failed to delete rule"),
  });
};
