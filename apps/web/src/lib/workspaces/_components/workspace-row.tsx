"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { MoreVertical, Users, Pencil, Trash2 } from "lucide-react";
import { agentHue, agentInitials } from "@/lib/dashboard/shell/agent-square";
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
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { UpgradeToTeamButton } from "@/ee/billing/_components/upgrade-to-team-button";
import { isPlanAtLeast, type Plan } from "@onecli/api/ee/billing/plans";
import type { WorkspaceOwner } from "@onecli/api/ee/services/workspace-service";
import { useRenameWorkspace } from "@/hooks/use-workspaces";
import { usePlanGate } from "@/lib/plan-gate";
import { WorkspaceAccessDialog } from "@/ee/workspaces/_components/workspace-access-dialog";
import { useDeleteWorkspaceDialog } from "./delete-workspace-dialog";

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

/**
 * One workspace in the Workspaces list: its initials on a soft colour
 * picked from the name (the agents' squares, a shade lighter), the name,
 * and one quiet line of facts under it. A list, not a switcher (that lives
 * in the sidebar and the Settings header); the one you're in now is tagged
 * Current. The menu (rename, share, delete) sits at the row's end.
 */
export const WorkspaceRow = ({
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
  const current = useParams<{ workspaceId?: string }>().workspaceId === id;
  const [shareOpen, setShareOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(name ?? "");
  const renameWorkspace = useRenameWorkspace();
  const deleteDialog = useDeleteWorkspaceDialog({
    workspaceId: id,
    workspaceName: name,
    organizationId,
  });

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

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          aria-hidden
          style={{ "--hue": agentHue(name ?? id) }}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[oklch(0.94_0.04_var(--hue))] text-xs font-medium text-[oklch(0.38_0.09_var(--hue))] dark:bg-[oklch(0.33_0.05_var(--hue))] dark:text-[oklch(0.9_0.05_var(--hue))]"
        >
          {agentInitials(name ?? "Workspace")}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">
              {name ?? "Untitled workspace"}
            </span>
            {current && (
              <span className="bg-brand-wash text-brand-ink shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                Current
              </span>
            )}
          </span>
          {/* Fixed-width facts, sized to fit two-digit counts snugly, so
              each one starts at the same spot on every row. */}
          <span className="text-muted-foreground flex min-w-0 items-center text-xs whitespace-nowrap">
            <span className="w-[3.6rem] shrink-0 tabular-nums">
              {agentCount} agent{agentCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden className="px-1.5">
              ·
            </span>
            <span className="w-[5.5rem] shrink-0 tabular-nums">
              {resourceCount} connection{resourceCount === 1 ? "" : "s"}
            </span>
            {owner && (
              <>
                <span aria-hidden className="px-1.5">
                  ·
                </span>
                <span className="min-w-0 truncate">
                  Owned by{" "}
                  {owner.isCurrentUser
                    ? "you"
                    : (owner.name ?? owner.email ?? "Unknown")}
                </span>
              </>
            )}
          </span>
        </span>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger
              onClick={(e) => e.stopPropagation()}
              aria-label="Workspace actions"
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] flex size-7 shrink-0 items-center justify-center rounded-md"
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
                  deleteDialog.open();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
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
              {renameWorkspace.isPending ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {deleteDialog.dialog}
    </>
  );
};
