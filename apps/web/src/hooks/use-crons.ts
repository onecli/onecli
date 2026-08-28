"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { crons } from "@/lib/api";
import type { CronInput, CronUpdate } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Cron mutations are headless (the use-channels convention): the Schedules
// section owns the toasts — a pause toggle and a create dialog want different
// copy. No `invalidateGatewayCache()` anywhere — deliberate: the gateway
// reads no cron table, so a flush would be pure noise.

export const useCrons = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.crons.agent(agentId),
    queryFn: () => crons.list(agentId),
  });

export const useCreateCron = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CronInput) => crons.create(agentId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.crons.all() });
    },
  });
};

export const useUpdateCron = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ cronId, input }: { cronId: string; input: CronUpdate }) =>
      crons.update(agentId, cronId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.crons.all() });
    },
  });
};

export const useRunCronNow = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cronId: string) => crons.runNow(agentId, cronId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.crons.all() });
    },
  });
};

export const useDeleteCron = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cronId: string) => crons.remove(agentId, cronId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.crons.all() });
    },
  });
};
