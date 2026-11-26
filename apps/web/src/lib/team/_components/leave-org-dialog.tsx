"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

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
import { leaveTeam, getWorkspacesDeletedOnLeave } from "@/lib/team/actions";
import {
  CHAT_APPS_UNINSTALLED_NOTE,
  WorkspaceDeletionChecklist,
  useWorkspaceAcknowledgements,
  type DeletedWorkspace,
} from "./workspace-deletion-checklist";

interface LeaveOrgDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
}

export const LeaveOrgDialog = ({
  open,
  onOpenChange,
  orgName,
}: LeaveOrgDialogProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [workspaces, setWorkspaces] = useState<DeletedWorkspace[]>([]);
  const acks = useWorkspaceAcknowledgements(workspaces);
  const { reset: resetAcks } = acks;

  useEffect(() => {
    if (!open) return;
    resetAcks();
    getWorkspacesDeletedOnLeave()
      .then(setWorkspaces)
      .catch(() => {
        toast.error("Failed to load workspaces");
        setWorkspaces([]);
      });
  }, [open, resetAcks]);

  const handleLeave = () => {
    if (!acks.allAcknowledged) return;
    startTransition(async () => {
      const result = await leaveTeam();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("You have left the organization");
      router.push("/");
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave organization</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <WorkspaceDeletionChecklist
                workspaces={workspaces}
                acknowledged={acks.acknowledged}
                onToggle={acks.toggle}
              />
              <p>
                This will remove you from <strong>{orgName}</strong> and
                permanently delete your workspaces and data in this
                organization.
                {acks.hasChatApps && CHAT_APPS_UNINSTALLED_NOTE}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleLeave();
            }}
            disabled={!acks.allAcknowledged || pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? "Leaving..." : "Leave and delete data"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
