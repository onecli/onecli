"use client";

import { useCallback, useState } from "react";
import { Checkbox } from "@onecli/ui/components/checkbox";

/** A personal workspace that leaving the org deletes, with the chat apps that
 * deleting it uninstalls. */
export interface DeletedWorkspace {
  id: string;
  name: string | null;
  channelApps: { provider: string }[];
}

/** Closes the dialog's warning paragraph when any listed workspace has a chat
 * app (see `hasChatApps`). */
export const CHAT_APPS_UNINSTALLED_NOTE =
  " Their chat apps are uninstalled from your chat workspace, and anyone talking to them there loses the agent.";

/**
 * Acknowledgement state for the workspaces that removing a member or leaving
 * the org deletes: the action stays locked until every listed workspace is
 * ticked.
 */
export const useWorkspaceAcknowledgements = (
  workspaces: DeletedWorkspace[],
) => {
  const [acknowledged, setAcknowledged] = useState(() => new Set<string>());

  const toggle = (workspaceId: string) =>
    setAcknowledged((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });

  const reset = useCallback(() => setAcknowledged(new Set()), []);

  return {
    acknowledged,
    toggle,
    reset,
    allAcknowledged:
      workspaces.length === 0 || acknowledged.size === workspaces.length,
    hasChatApps: workspaces.some((w) => w.channelApps.length > 0),
  };
};

interface WorkspaceDeletionChecklistProps {
  workspaces: DeletedWorkspace[];
  acknowledged: Set<string>;
  onToggle: (workspaceId: string) => void;
}

/** One checkbox row per workspace to delete, naming the chat apps it
 * uninstalls. Renders nothing when there are none. */
export const WorkspaceDeletionChecklist = ({
  workspaces,
  acknowledged,
  onToggle,
}: WorkspaceDeletionChecklistProps) => {
  if (workspaces.length === 0) return null;
  return (
    <>
      <p>Acknowledge each workspace that will be permanently deleted:</p>
      <div className="rounded-md border">
        {workspaces.map((workspace) => (
          <label
            key={workspace.id}
            className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0"
          >
            <Checkbox
              checked={acknowledged.has(workspace.id)}
              onCheckedChange={() => onToggle(workspace.id)}
            />
            <span className="text-foreground text-sm font-medium">
              {workspace.name ?? "Untitled"}
              {workspace.channelApps.length > 0 && (
                <span className="text-muted-foreground ml-2 font-normal">
                  · uninstalls{" "}
                  {workspace.channelApps.length === 1
                    ? "1 chat app"
                    : `${workspace.channelApps.length} chat apps`}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </>
  );
};
