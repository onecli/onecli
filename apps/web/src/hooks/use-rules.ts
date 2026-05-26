"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { rules } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { updateRule, deleteRule } from "@/lib/actions/rules";
import { invalidateGatewayCache } from "@/lib/actions/gateway-cache";

export const useRules = () =>
  useQuery({ queryKey: queryKeys.rules.list(), queryFn: rules.list });

export const useCreateRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: rules.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.rules.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      invalidateGatewayCache();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to create rule"),
  });
};

export const useUpdateRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ruleId,
      input,
    }: {
      ruleId: string;
      input: Parameters<typeof updateRule>[1];
    }) => updateRule(ruleId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.rules.all() });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to update rule"),
  });
};

export const useDeleteRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteRule,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.rules.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      invalidateGatewayCache();
      toast.success("Rule deleted");
    },
    onError: () => toast.error("Failed to delete rule"),
  });
};
