"use client";

import { useState } from "react";
import {
  MoreHorizontal,
  RefreshCcw,
  Trash2,
  Pencil,
  Info,
  History,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { useRenameAgent, useRestartAgent } from "@/hooks/use-agents";
import { providerLabel } from "@/lib/agents/channel-provider-ui";
import type { AgentKind } from "@/lib/api/types";
import {
  DeleteAgentDialog,
  type DeleteAgentDialogProps,
} from "./delete-agent-dialog";

interface AgentActionsMenuProps {
  agent: DeleteAgentDialogProps["agent"] & {
    /** "hosted" agents get "Restart agent": only they have a computer and
     * conversations to restart. */
    kind: AgentKind;
  };
  /** The agent page's "Details" entry: the agent's facts as a dialog. */
  onDetails: () => void;
  /** Open Activity narrowed to this agent (its runs and requests). */
  onViewActivity: () => void;
  /** Navigate away after a successful delete. */
  onDeleted: () => void;
}

/** The agent kebab in the agent page header. */
export const AgentActionsMenu = ({
  agent,
  onDetails,
  onViewActivity,
  onDeleted,
}: AgentActionsMenuProps) => {
  const renameMutation = useRenameAgent();
  const restartMutation = useRestartAgent();
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  // The restart confirm names the channels a reset reaches.
  const channels = agent.channels ?? [];

  const handleRestart = () =>
    restartMutation.mutate(agent.id, {
      onSuccess: () => setRestartDialogOpen(false),
    });

  const handleRename = () => {
    if (!newName.trim()) return;
    renameMutation.mutate(
      { agentId: agent.id, name: newName },
      { onSuccess: () => setRenameDialogOpen(false) },
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7">
            <MoreHorizontal className="size-4" />
            <span className="sr-only">Agent actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onDetails}>
            <Info className="size-4" />
            Details
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onViewActivity}>
            <History className="size-4" />
            View activity
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setNewName(agent.name);
              setRenameDialogOpen(true);
            }}
          >
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          {agent.kind === "hosted" && (
            <DropdownMenuItem onSelect={() => setRestartDialogOpen(true)}>
              <RefreshCcw className="size-4" />
              Restart agent
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="size-4" />
            Delete agent
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={restartDialogOpen} onOpenChange={setRestartDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart agent?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  <strong>{agent.name}</strong> starts fresh in every
                  conversation, in the dashboard
                  {channels
                    .map((c) => ` and in ${providerLabel(c.provider)}`)
                    .join("")}
                  . The chat history stays visible, but the agent won&apos;t
                  remember it.
                </p>
                <p>
                  Anything it&apos;s working on stops now, including background
                  processes and open SSH sessions. Your next message starts it
                  again.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restartMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Close on success only: a failed restart leaves the dialog
                // up, so the person sees it did not happen.
                e.preventDefault();
                handleRestart();
              }}
              disabled={restartMutation.isPending}
            >
              {restartMutation.isPending ? "Restarting..." : "Restart"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteAgentDialog
        agent={agent}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onDeleted={onDeleted}
      />

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor={`rename-agent-${agent.id}`}>Name</Label>
            <Input
              id={`rename-agent-${agent.id}`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) handleRename();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              loading={renameMutation.isPending}
              disabled={!newName.trim()}
            >
              {renameMutation.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
