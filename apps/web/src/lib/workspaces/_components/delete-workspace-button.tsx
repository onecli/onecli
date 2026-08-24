"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
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

interface Props {
  workspaceId: string;
  workspaceName: string | null;
  organizationId: string;
  isLastWorkspace: boolean;
}

export const DeleteWorkspaceButton = ({
  workspaceId,
  workspaceName,
  organizationId,
  isLastWorkspace,
}: Props) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const deleteWorkspace = useDeleteWorkspace();

  const expected = workspaceId;
  const canConfirm =
    confirmText.trim() === expected && !deleteWorkspace.isPending;

  const handleDelete = async () => {
    if (!canConfirm) return;
    try {
      await deleteWorkspace.mutateAsync(workspaceId);
      // Close the confirm dialog at once so a second click during the async
      // cookie write + redirect below can't fire a duplicate delete (mirrors
      // the workspace-card twin).
      setOpen(false);
      // Deleting the workspace leaves the active-workspace cookie dangling; pin the
      // org and send the user to its workspace list.
      await setDefaultOrgCookie(organizationId);
      router.push(`/org/${organizationId}/workspaces`);
      router.refresh();
    } catch {
      // the hook already toasts the server reason
    }
  };

  return (
    <Card className="border-destructive/40 p-6">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold">Delete workspace</h3>
          <p className="text-muted-foreground text-sm">
            Permanently removes this workspace and all of its agents, secrets,
            connections, rules, and audit logs.
            {isLastWorkspace && (
              <>
                {" "}
                You can&apos;t delete the only workspace in the organization.
              </>
            )}
          </p>
        </div>
        <div className="flex justify-end">
          {isLastWorkspace ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-not-allowed">
                  <Button variant="destructive" disabled>
                    Delete workspace
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                You can&apos;t delete the only workspace in the organization
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="destructive"
              disabled={deleteWorkspace.isPending}
              onClick={() => {
                setConfirmText("");
                setOpen(true);
              }}
            >
              Delete workspace
            </Button>
          )}
        </div>
      </div>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setConfirmText("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes{" "}
              <b>{workspaceName ?? "this workspace"}</b> and all data in it.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2 py-2">
            <p className="text-sm font-medium">
              Type{" "}
              <code className="bg-muted cursor-text select-text rounded px-1.5 py-0.5 font-mono">
                {expected}
              </code>{" "}
              to confirm
            </p>
            <Input
              id="confirm-delete"
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
    </Card>
  );
};
