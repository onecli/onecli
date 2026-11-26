"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Input } from "@onecli/ui/components/input";
import { useDeleteWorkspace } from "@/hooks/use-workspaces";
import { setDefaultOrgCookie } from "@/lib/auth/set-active-scope";
import { orgLanding } from "@/lib/dashboard/landing";

interface DeleteWorkspaceTarget {
  workspaceId: string;
  workspaceName: string | null;
  organizationId: string;
}

interface DeleteWorkspaceDialog {
  /** Opens the dialog with an empty confirmation. */
  open: () => void;
  isPending: boolean;
  /** The confirm dialog. Render it once, wherever the caller's tree allows. */
  dialog: React.ReactNode;
}

/**
 * The type-the-id confirm dialog for deleting a workspace, shared by the
 * settings page's danger card and the workspace list's card menu. A delete
 * lands the user on the org's workspace list.
 */
export const useDeleteWorkspaceDialog = ({
  workspaceId,
  workspaceName,
  organizationId,
}: DeleteWorkspaceTarget): DeleteWorkspaceDialog => {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const deleteWorkspace = useDeleteWorkspace();

  const canConfirm =
    confirmText.trim() === workspaceId && !deleteWorkspace.isPending;

  const handleDelete = async () => {
    if (!canConfirm) return;
    try {
      await deleteWorkspace.mutateAsync(workspaceId);
      // Close the confirm dialog at once so a second click during the async
      // cookie write + redirect below can't fire a duplicate delete.
      setIsOpen(false);
      // Pin this org as the default and leave the deleted workspace's pages
      // for the org's home (its first remaining workspace's first agent),
      // in one hop.
      await setDefaultOrgCookie(organizationId);
      router.push(await orgLanding(organizationId));
      router.refresh();
    } catch {
      // the hook already toasts the server reason
    }
  };

  const dialog = (
    <AlertDialog
      open={isOpen}
      onOpenChange={(o) => {
        setIsOpen(o);
        if (!o) setConfirmText("");
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes <b>{workspaceName ?? "this workspace"}</b>{" "}
            and all data in it. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2 py-2">
          <p className="text-sm font-medium">
            Type{" "}
            <code className="bg-muted cursor-text select-text rounded px-1.5 py-0.5 font-mono">
              {workspaceId}
            </code>{" "}
            to confirm
          </p>
          <Input
            placeholder="Enter the workspace ID"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoFocus
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteWorkspace.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleDelete();
            }}
            disabled={!canConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteWorkspace.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return {
    open: () => {
      setConfirmText("");
      setIsOpen(true);
    },
    isPending: deleteWorkspace.isPending,
    dialog,
  };
};
