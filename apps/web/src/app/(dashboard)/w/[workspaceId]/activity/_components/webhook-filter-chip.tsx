"use client";

import { useWebhooks } from "@/hooks/use-webhooks";
import { ClearFilterChip } from "./clear-filter-chip";

export interface WebhookFilterChipProps {
  agentId: string;
  webhookId: string;
  onClear: () => void;
}

/**
 * Shown while Runs is narrowed to one webhook (its "View runs"): names the
 * webhook and clears back to all of the agent's webhook runs. The name is a
 * label only; until it loads (or if the webhook is gone) the chip still
 * clears.
 */
export const WebhookFilterChip = ({
  agentId,
  webhookId,
  onClear,
}: WebhookFilterChipProps) => {
  const { data } = useWebhooks(agentId);
  const name = data?.webhooks.find((hook) => hook.id === webhookId)?.name;

  return (
    <ClearFilterChip onClick={onClear}>
      {name ? `Webhook: ${name}` : "One webhook"}
    </ClearFilterChip>
  );
};
