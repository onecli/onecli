"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
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
import { Checkbox } from "@onecli/ui/components/checkbox";
import { deleteOrganizationAction } from "../actions";

interface Props {
  orgId: string;
  orgName: string;
  role: string;
  workspaces: {
    id: string;
    name: string | null;
    channelApps: { provider: string }[];
  }[];
}

export const DeleteOrgCard = ({ orgId, orgName, role, workspaces }: Props) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [checkedWorkspaces, setCheckedWorkspaces] = useState(
    () => new Set<string>(),
  );
  const [pending, startTransition] = useTransition();

  const allChecked =
    workspaces.length === 0 || checkedWorkspaces.size === workspaces.length;
  const totalApps = workspaces.reduce((n, p) => n + p.channelApps.length, 0);
  const canConfirm = allChecked && confirmText.trim() === orgId && !pending;

  const isOwner = role === "owner";

  const handleToggleWorkspace = (workspaceId: string) => {
    setCheckedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  const handleDelete = () => {
    if (!canConfirm) return;
    startTransition(async () => {
      const result = await deleteOrganizationAction(orgId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(result.data.redirectTo);
    });
  };

  return (
    <Card className="border-destructive/40 p-6">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold">Delete organization</h3>
          <p className="text-muted-foreground text-sm">
            Permanently delete this organization and all of its workspaces. Make
            sure you have a backup if you want to keep your data.
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            variant="destructive"
            disabled={!isOwner || pending}
            onClick={() => {
              setConfirmText("");
              setCheckedWorkspaces(new Set());
              setOpen(true);
            }}
          >
            Delete organization
          </Button>
        </div>
      </div>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setConfirmText("");
            setCheckedWorkspaces(new Set());
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete organization</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {workspaces.length > 0 && (
                  <>
                    <p>Acknowledge each workspace that will be deleted:</p>
                    <div className="rounded-md border">
                      {workspaces.map((workspace) => (
                        <label
                          key={workspace.id}
                          className="flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={checkedWorkspaces.has(workspace.id)}
                            onCheckedChange={() =>
                              handleToggleWorkspace(workspace.id)
                            }
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
                )}
                <p>
                  This action <strong>cannot</strong> be undone. This will
                  permanently delete the <strong>{orgName}</strong> organization
                  and remove all of its workspaces.
                  {totalApps > 0 &&
                    " Their chat apps are uninstalled from your chat workspace, and anyone talking to them there loses the agent."}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2 py-2">
            <p className="text-sm font-medium">
              Type{" "}
              <code className="bg-muted cursor-text select-text rounded px-1.5 py-0.5 font-mono">
                {orgId}
              </code>{" "}
              to confirm.
            </p>
            <Input
              id="confirm-org-delete"
              placeholder="Enter the organization ID"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={!canConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending
                ? "Deleting..."
                : "I understand, delete this organization"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
