"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  FolderOpen,
  ArrowRight,
  MoreVertical,
  Users,
  Pencil,
  Trash2,
} from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { Avatar, AvatarFallback } from "@onecli/ui/components/avatar";
import { cn } from "@onecli/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { UpgradeDialogShell } from "@/lib/components/upgrade-dialog-shell";
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
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { UpgradeToTeamButton } from "@/ee/billing/_components/upgrade-to-team-button";
import { switchWorkspaceAction } from "../actions";
import { getInitials } from "@/lib/user-display";
import { isPlanAtLeast, type Plan } from "@onecli/api/ee/billing/plans";
import type { WorkspaceOwner } from "@onecli/api/ee/services/workspace-service";
import { useRenameWorkspace, useDeleteWorkspace } from "@/hooks/use-workspaces";
import { setDefaultOrgCookie } from "@/lib/auth/set-active-scope";
import { usePlanGate } from "@/lib/plan-gate";
import { WorkspaceAccessDialog } from "@/ee/workspaces/_components/workspace-access-dialog";

interface Props {
  id: string;
  name: string | null;
  agentCount: number;
  resourceCount: number;
  owner: WorkspaceOwner | null;
  canManage: boolean;
  isLastWorkspace: boolean;
  organizationId: string;
  plan: Plan;
}

export const WorkspaceCard = ({
  id,
  name,
  agentCount,
  resourceCount,
  owner,
  canManage,
  isLastWorkspace,
  organizationId,
  plan,
}: Props) => {
  const isTeam = isPlanAtLeast(plan, "team");
  const planGate = usePlanGate();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shareOpen, setShareOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(name ?? "");
  const renameWorkspace = useRenameWorkspace();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const deleteWorkspace = useDeleteWorkspace();

  const canConfirmDelete =
    confirmText.trim() === id && !deleteWorkspace.isPending;

  const handleRename = async () => {
    if (renameWorkspace.isPending) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === name) return;
    try {
      await renameWorkspace.mutateAsync({ id, name: trimmed });
      setRenameOpen(false);
      router.refresh();
    } catch {
      // the hook already toasts the server reason
    }
  };

  const handleDelete = async () => {
    if (!canConfirmDelete) return;
    try {
      await deleteWorkspace.mutateAsync(id);
      // Close the confirm dialog at once so a second click during the async
      // cookie write + redirect below can't fire a duplicate delete.
      setDeleteOpen(false);
      // Deleting the active workspace leaves its cookie dangling; pin the org and
      // go to its workspace list.
      await setDefaultOrgCookie(organizationId);
      router.push(`/org/${organizationId}/workspaces`);
      router.refresh();
    } catch {
      // the hook already toasts the server reason
    }
  };

  const handleClick = () => {
    startTransition(async () => {
      const result = await switchWorkspaceAction(id);
      if (!result.ok) toast.error(result.error);
    });
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        className={cn(
          "group text-left",
          pending ? "pointer-events-none opacity-60" : "cursor-pointer",
        )}
      >
        <Card className="hover:border-foreground/20 p-4 transition-colors">
          <div className="flex items-center gap-3">
            <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center self-start rounded-lg">
              <FolderOpen className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium">
                {name ?? "Untitled workspace"}
              </h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {agentCount}&nbsp;agent{agentCount === 1 ? "" : "s"} ·{" "}
                {resourceCount}&nbsp;resource{resourceCount === 1 ? "" : "s"}
              </p>
              {owner && (
                <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
                  <Avatar aria-hidden className="size-5">
                    <AvatarFallback className="text-[10px]">
                      {getInitials(owner.name, owner.email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-muted-foreground min-w-0 truncate text-xs">
                    Owned by{" "}
                    {owner.isCurrentUser
                      ? "you"
                      : (owner.name ?? owner.email ?? "Unknown")}
                  </span>
                </div>
              )}
            </div>
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md"
                >
                  <MoreVertical className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameValue(name ?? "");
                      setRenameOpen(true);
                    }}
                  >
                    <Pencil className="size-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      // Sharing is enterprise-licensed on self-host: an
                      // unlicensed deployment reports the top plan (no billing),
                      // so without this guard the dialog would open and its
                      // /access + /members fetches would 403 off the API's
                      // requireEnterprise gate. Open the license dialog instead.
                      if (planGate.guard("workspace_sharing")) return;
                      setShareOpen(true);
                    }}
                  >
                    <Users className="size-4" />
                    Share workspace
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isLastWorkspace}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmText("");
                      setDeleteOpen(true);
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <ArrowRight className="text-muted-foreground/0 size-4 shrink-0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
        </Card>
      </div>

      {isTeam ? (
        <WorkspaceAccessDialog
          workspaceId={id}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : (
        <UpgradeDialogShell
          open={shareOpen}
          onOpenChange={setShareOpen}
          icon={<Users className="text-muted-foreground size-6" />}
          title="Share workspace"
          pill="Team"
          description="Invite team members to collaborate on workspaces with shared agents, secrets, and connections."
          footer={
            <UpgradeToTeamButton
              label="Upgrade now"
              size="default"
              className="w-full"
            />
          }
        />
      )}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              Enter a new name for this workspace.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Workspace name"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameOpen(false)}
              disabled={renameWorkspace.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              disabled={
                renameWorkspace.isPending ||
                !renameValue.trim() ||
                renameValue.trim() === name
              }
            >
              {renameWorkspace.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          setDeleteOpen(o);
          if (!o) setConfirmText("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <b>{name ?? "this workspace"}</b> and all
              data in it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2 py-2">
            <p className="text-sm font-medium">
              Type{" "}
              <code className="bg-muted cursor-text select-text rounded px-1.5 py-0.5 font-mono">
                {id}
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
              disabled={!canConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteWorkspace.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
