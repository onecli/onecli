"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { crons } from "@/lib/api";
import type { AgentCron, CronInput, CronUpdate } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import {
  installItem,
  listItem,
  patchItem,
  throughField,
} from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";
import { toast } from "sonner";

// Cron mutations are headless (the use-channels convention): the Schedules
// section owns the toasts — a pause toggle and a create dialog want different
// copy. No `invalidateGatewayCache()` anywhere — deliberate: the gateway
// reads no cron table, so a flush would be pure noise.

export const useCrons = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.crons.agent(agentId),
    queryFn: () => crons.list(agentId),
  });

const refreshCrons = (qc: QueryClient) =>
  qc.invalidateQueries({ queryKey: queryKeys.crons.all() });

const cronRow = (cronId: string) =>
  throughField<{ crons: AgentCron[] }, "crons", AgentCron>(
    "crons",
    listItem((c) => c.id === cronId),
  );

const cronName = (qc: QueryClient, agentId: string, cronId: string) =>
  qc
    .getQueryData<{ crons: AgentCron[] }>(queryKeys.crons.agent(agentId))
    ?.crons.find((c) => c.id === cronId)?.name;

export const useCreateCron = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CronInput) => crons.create(agentId, input),
    // Returned, so the dialog's Saving… lasts until the new row is on screen
    // (no close-then-pop-in).
    onSuccess: () => refreshCrons(qc),
  });
};

export const useUpdateCron = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ cronId, input }: { cronId: string; input: CronUpdate }) =>
      crons.update(agentId, cronId, input),
    onSuccess: (updated, { cronId }) => {
      // The PATCH returns the row: show it before the list refetch lands, so
      // the dialog closes onto the saved values, not the old ones.
      installItem(qc, queryKeys.crons.agent(agentId), cronRow(cronId), updated);
      return refreshCrons(qc);
    },
  });
};

/**
 * Pause / resume from the row's switch: instant (see `useOptimisticMutation`).
 * Resuming is a human decision that supersedes an auto-disable, as on the
 * server: the reason clears with the click. The server also re-plans the
 * next run, so the row's "Next:" reads the PATCH's answer once it lands.
 */
export const useSetCronEnabled = (agentId: string) =>
  useOptimisticMutation<AgentCron, { cronId: string; enabled: boolean }>({
    family: "crons",
    itemKey: ({ cronId }) => `cron:${cronId}`,
    write: ({ cronId, enabled }) => crons.update(agentId, cronId, { enabled }),
    apply: (qc, { cronId, enabled }) =>
      patchItem(qc, queryKeys.crons.agent(agentId), cronRow(cronId), (c) =>
        c
          ? {
              ...c,
              enabled,
              ...(enabled && !c.enabled && { disabledReason: null }),
            }
          : c,
      ),
    confirm: (qc, updated, { cronId }) =>
      installItem(qc, queryKeys.crons.agent(agentId), cronRow(cronId), updated),
    refresh: refreshCrons,
    failure: (qc, { cronId, enabled }) =>
      `Couldn't ${enabled ? "resume" : "pause"} "${cronName(qc, agentId, cronId) ?? "the schedule"}"`,
  });

export const useRunCronNow = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cronId: string) => crons.runNow(agentId, cronId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.crons.all() });
    },
  });
};

/** Delete a schedule, instantly: it leaves the list (and its dialog closes)
 * on click; the confirmation is said once the server agrees, and a failure
 * puts the row back where it was. */
export const useDeleteCron = (agentId: string) =>
  useOptimisticMutation<void, string>({
    family: "crons",
    itemKey: (cronId) => `cron:${cronId}`,
    write: (cronId) => crons.remove(agentId, cronId),
    apply: (qc, cronId) =>
      patchItem(
        qc,
        queryKeys.crons.agent(agentId),
        cronRow(cronId),
        () => undefined,
      ),
    succeeded: () => toast.success("Schedule deleted"),
    refresh: refreshCrons,
    failure: (qc, cronId) =>
      `Couldn't delete "${cronName(qc, agentId, cronId) ?? "the schedule"}"`,
  });
