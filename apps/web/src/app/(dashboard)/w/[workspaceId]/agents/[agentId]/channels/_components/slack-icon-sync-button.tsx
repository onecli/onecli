"use client";

import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { useSyncAgentIcon } from "@/hooks/use-channels";

/**
 * Pull the Slack app's icon NOW and copy it onto the agent's image. Slack
 * sends apps no event when their icon changes, so this press is how a change
 * made on Slack's settings page reaches OneCLI.
 */
export const SlackIconSyncButton = ({ agentId }: { agentId: string }) => {
  const sync = useSyncAgentIcon(agentId, "slack");
  return (
    <Button
      variant="outline"
      size="sm"
      loading={sync.isPending}
      onClick={() =>
        sync.mutate(undefined, {
          onSuccess: ({ changed }) =>
            toast.success(
              changed
                ? "Synced the image from Slack."
                : "Already up to date with Slack.",
            ),
          onError: (err) => toast.error(err.message),
        })
      }
    >
      {!sync.isPending && <RefreshCw className="size-3.5" aria-hidden />}
      {sync.isPending ? "Syncing…" : "Sync image"}
    </Button>
  );
};
