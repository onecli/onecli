"use client";

import { useState } from "react";
import {
  MoreHorizontal,
  RotateCw,
  Trash2,
  KeyRound,
  Pencil,
  Info,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Checkbox } from "@onecli/ui/components/checkbox";
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
import {
  useDeleteAgent,
  useRegenerateToken,
  useRenameAgent,
} from "@/hooks/use-agents";
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

interface AgentActionsMenuProps {
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
  /** The owner renders the credential-access reflection dialog (the card also
   * opens it from an inline button, so the dialog cannot live in the menu). */
  onCredentialAccess: () => void;
  /** The agent page's "Details" entry: the agent's facts as a dialog. Omitted
   * by the list card, whose row already shows them. */
  onDetails?: () => void;
  /** Detail-page hook: navigate away after a successful delete. */
  onDeleted?: () => void;
}

/** The agent kebab — one implementation shared by the list card and the agent
 * detail page header, so the action set can never drift between them. */
export const AgentActionsMenu = ({
  agent,
  onCredentialAccess,
  onDetails,
  onDeleted,
}: AgentActionsMenuProps) => {
  const deleteMutation = useDeleteAgent();
  const regenerateMutation = useRegenerateToken();
  const renameMutation = useRenameAgent();
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
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

  const handleRegenerate = () => regenerateMutation.mutate(agent.id);

  const handleDelete = () =>
    deleteMutation.mutate(agent.id, { onSuccess: () => onDeleted?.() });

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
          {onDetails && (
            <DropdownMenuItem onSelect={onDetails}>
              <Info className="size-4" />
              Details
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              setNewName(agent.name);
              setRenameDialogOpen(true);
            }}
          >
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCredentialAccess}>
            <KeyRound className="size-4" />
            Credential access
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRotateDialogOpen(true)}>
            <RotateCw className="size-4" />
            Rotate token
          </DropdownMenuItem>
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

      <AlertDialog open={rotateDialogOpen} onOpenChange={setRotateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate token?</AlertDialogTitle>
            <AlertDialogDescription>
              The current token for <strong>{agent.name}</strong> will be
              invalidated immediately. Any agents using the old token will lose
              access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRegenerate}
              disabled={regenerateMutation.isPending}
            >
              {regenerateMutation.isPending ? "Rotating..." : "Rotate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(o) => {
          setDeleteDialogOpen(o);
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
