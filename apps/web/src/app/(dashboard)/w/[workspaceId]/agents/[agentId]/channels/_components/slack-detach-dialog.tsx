"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Label } from "@onecli/ui/components/label";
import { useDetachChannel } from "@/hooks/use-channels";

interface SlackDetachDialogProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Remote app deletion needs the org automation credential. */
  canDeleteRemote: boolean;
  /** The bot's handle in the workspace ("moshe"), where known. Names the app
   * a human would recognize instead of leaving "the Slack app" abstract. */
  identityName: string | null;
}

/**
 * Detach confirmation. Conversations already ingested stay; the presence, its
 * tokens, its links and its service key go. Deleting the Slack app itself is
 * an explicit opt-in, offered only when the org credential can actually do it.
 */
export const SlackDetachDialog = ({
  agentId,
  open,
  onOpenChange,
  canDeleteRemote,
  identityName,
}: SlackDetachDialogProps) => {
  const detach = useDetachChannel(agentId, "slack");
  const [deleteRemote, setDeleteRemote] = useState(false);

  const confirm = () =>
    detach.mutate(
      { deleteRemote: canDeleteRemote && deleteRemote },
      {
        onSuccess: () => {
          toast.success("Slack detached");
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      },
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Detach Slack?</DialogTitle>
          <DialogDescription>
            The agent leaves your workspace and stops receiving Slack messages.
            Conversations already brought in stay here.
          </DialogDescription>
        </DialogHeader>
        {canDeleteRemote && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="slack-delete-remote"
              checked={deleteRemote}
              onCheckedChange={(next) => setDeleteRemote(next === true)}
            />
            <Label
              htmlFor="slack-delete-remote"
              className="text-sm font-normal"
            >
              Also delete the Slack app
              {identityName?.trim() ? ` (@${identityName.trim()})` : ""}
            </Label>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={detach.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            loading={detach.isPending}
          >
            {detach.isPending ? "Detaching…" : "Detach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
