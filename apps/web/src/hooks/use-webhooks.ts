"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { webhooks } from "@/lib/api";
import type { WebhookInput, WebhookUpdate } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Headless mutations (the use-crons convention): the section owns the toasts.
// No `invalidateGatewayCache()`: the gateway reads no webhook table.

export const useWebhooks = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.webhooks.agent(agentId),
    queryFn: () => webhooks.list(agentId),
  });

const useInvalidate = (agentId: string) => {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({ queryKey: queryKeys.webhooks.agent(agentId) });
};

export const useCreateWebhook = (agentId: string) => {
  const invalidate = useInvalidate(agentId);
  return useMutation({
    mutationFn: (input: WebhookInput) => webhooks.create(agentId, input),
    onSuccess: invalidate,
  });
};

export const useUpdateWebhook = (agentId: string) => {
  const invalidate = useInvalidate(agentId);
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: WebhookUpdate }) =>
      webhooks.update(agentId, id, input),
    onSuccess: invalidate,
  });
};

export const useDeleteWebhook = (agentId: string) => {
  const invalidate = useInvalidate(agentId);
  return useMutation({
    mutationFn: (id: string) => webhooks.remove(agentId, id),
    onSuccess: invalidate,
  });
};
