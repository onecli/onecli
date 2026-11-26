"use client";

import { useRef, useState } from "react";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { useDeleteAgent } from "@/hooks/use-agents";
import { providerLabel } from "@/lib/agents/channel-provider-ui";

/**
 * "Slack app (@donna)" — the handle a human sees in the workspace, so the
 * acknowledgement names the thing they'd recognize. Falls back to the app id
 * where we never learned the handle (the OAuth arm, and presences that
 * predate it), which is still verifiable in Slack's app settings.
 */
const channelAppLabel = (channel: {
  provider: string;
  identityName?: string | null;
  externalId?: string;
}) => {
  const name = channel.identityName?.trim();
  const suffix = name ? `@${name}` : channel.externalId;
  return `${providerLabel(channel.provider)} app${suffix ? ` (${suffix})` : ""}`;
};

export interface DeleteAgentDialogProps {
  agent: {
    id: string;
    name: string;
    /** Attached channel presences — deletion removes these from the
     * customer's workspace, so the confirmation names them. */
    channels?: {
      provider: string;
      identityName?: string | null;
      externalId?: string;
    }[];
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Navigate away after a successful delete. */
  onDeleted: () => void;
}

/**
 * The one "Delete agent?" confirmation, shared by the top bar's kebab and
 * the Danger zone at the end of Agent settings, so the two doors can never
 * drift apart on what they ask before deleting.
 */
export const DeleteAgentDialog = ({
  agent,
  open,
  onOpenChange,
  onDeleted,
}: DeleteAgentDialogProps) => {
  const deleteMutation = useDeleteAgent();
  const [acknowledged, setAcknowledged] = useState(() => new Set<string>());

  const channels = agent.channels ?? [];
  // Same shape as the org-deletion confirm: every attached app has to be
  // ticked before the destructive action unlocks, so the provider-side
  // consequence cannot be missed.
  const canDelete =
    acknowledged.size === channels.length && !deleteMutation.isPending;

  const toggleAcknowledged = (provider: string) =>
    setAcknowledged((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });

  // `mutateAsync`, not a per-call `onSuccess`: the delete invalidates the
  // agent list, the agent page swaps to its not-found state and unmounts
  // this dialog, and React Query drops per-call callbacks of an unmounted
  // observer, which left the user stranded on "Agent not found". The
  // promise settles regardless. Errors are already toasted by the hook.
  // The ref guards a double click landing before `isPending` re-renders the
  // button disabled: the second call would 404 and toast a false failure.
  const deleting = useRef(false);
  const handleDelete = () => {
    if (deleting.current) return;
    deleting.current = true;
    deleteMutation
      .mutateAsync(agent.id)
      .then(() => onDeleted())
      .catch(() => undefined)
      .finally(() => {
        deleting.current = false;
      });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setAcknowledged(new Set());
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete agent?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {channels.length > 0 && (
                <>
                  <p>Acknowledge each app that leaves your workspace:</p>
                  <div className="rounded-md border">
                    {channels.map((channel) => (
                      <label
                        key={channel.provider}
                        className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0"
                      >
                        <Checkbox
                          checked={acknowledged.has(channel.provider)}
                          onCheckedChange={() =>
                            toggleAcknowledged(channel.provider)
                          }
                        />
                        <span className="text-foreground text-sm font-medium">
                          {channelAppLabel(channel)}
                        </span>
                      </label>
                    ))}
                  </div>
                  <p>
                    Its{" "}
                    {channels
                      .map((c) => providerLabel(c.provider))
                      .join(" and ")}{" "}
                    app is uninstalled from your workspace, and anyone talking
                    to it there loses the agent.
                  </p>
                </>
              )}
              <p>
                This will permanently delete <strong>{agent.name}</strong> and
                its access token. This action cannot be undone.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              handleDelete();
            }}
            disabled={!canDelete}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
