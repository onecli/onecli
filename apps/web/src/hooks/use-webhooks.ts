"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { webhooks } from "@/lib/api";
import type { AgentWebhook, WebhookInput, WebhookUpdate } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import {
  installItem,
  listItem,
  patchItem,
  throughField,
} from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";
import { toast } from "sonner";

// Headless mutations (the use-crons convention): the section owns the toasts.
// No `invalidateGatewayCache()`: the gateway reads no webhook table.

export const useWebhooks = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.webhooks.agent(agentId),
    queryFn: () => webhooks.list(agentId),
  });

const refreshFor = (agentId: string) => (qc: QueryClient) =>
  qc.invalidateQueries({ queryKey: queryKeys.webhooks.agent(agentId) });

const webhookRow = (id: string) =>
  throughField<{ webhooks: AgentWebhook[] }, "webhooks", AgentWebhook>(
    "webhooks",
    listItem((w) => w.id === id),
  );

const webhookName = (qc: QueryClient, agentId: string, id: string) =>
  qc
    .getQueryData<{
      webhooks: AgentWebhook[];
    }>(queryKeys.webhooks.agent(agentId))
    ?.webhooks.find((w) => w.id === id)?.name;

export const useCreateWebhook = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WebhookInput) => webhooks.create(agentId, input),
    // Returned: the dialog's Saving… lasts until the new row is listed.
    onSuccess: () => refreshFor(agentId)(qc),
  });
};

export const useUpdateWebhook = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: WebhookUpdate }) =>
      webhooks.update(agentId, id, input),
    onSuccess: (updated, { id }) => {
      // The PATCH returns the row: the dialog closes onto the saved values.
      installItem(
        qc,
        queryKeys.webhooks.agent(agentId),
        webhookRow(id),
        updated,
      );
      return refreshFor(agentId)(qc);
    },
  });
};

/**
 * Pause / resume from the row's switch, instantly. Resuming supersedes an
 * auto-disable on the server, so its reason clears with the click.
 */
export const useSetWebhookEnabled = (agentId: string) =>
  useOptimisticMutation<AgentWebhook, { id: string; enabled: boolean }>({
    family: "webhooks",
    itemKey: ({ id }) => `webhook:${id}`,
    write: ({ id, enabled }) => webhooks.update(agentId, id, { enabled }),
    apply: (qc, { id, enabled }) =>
      patchItem(qc, queryKeys.webhooks.agent(agentId), webhookRow(id), (w) =>
        w
          ? {
              ...w,
              enabled,
              ...(enabled && !w.enabled && { disabledReason: null }),
            }
          : w,
      ),
    confirm: (qc, updated, { id }) =>
      installItem(
        qc,
        queryKeys.webhooks.agent(agentId),
        webhookRow(id),
        updated,
      ),
    refresh: refreshFor(agentId),
    failure: (qc, { id, enabled }) =>
      `Couldn't ${enabled ? "resume" : "pause"} "${webhookName(qc, agentId, id) ?? "the webhook"}"`,
  });

/** Delete a webhook, instantly: it leaves the list (and its dialog closes)
 * on click; the confirmation follows the server, and a failure puts the
 * row back. */
export const useDeleteWebhook = (agentId: string) =>
  useOptimisticMutation<void, string>({
    family: "webhooks",
    itemKey: (id) => `webhook:${id}`,
    write: (id) => webhooks.remove(agentId, id),
    apply: (qc, id) =>
      patchItem(
        qc,
        queryKeys.webhooks.agent(agentId),
        webhookRow(id),
        () => undefined,
      ),
    succeeded: () => toast.success("Webhook deleted"),
    refresh: refreshFor(agentId),
    failure: (qc, id) =>
      `Couldn't delete "${webhookName(qc, agentId, id) ?? "the webhook"}"`,
  });
