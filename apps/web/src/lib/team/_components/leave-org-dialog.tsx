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
import { Checkbox } from "@onecli/ui/components/checkbox";
import { leaveTeam, getWorkspacesDeletedOnLeave } from "@/lib/team/actions";

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
  const [workspaces, setWorkspaces] = useState<
    {
      id: string;
      name: string | null;
      channelApps: { provider: string }[];
    }[]
  >([]);
  const [checkedWorkspaces, setCheckedWorkspaces] = useState(
    () => new Set<string>(),
  );

  useEffect(() => {
    if (!open) return;
    setCheckedWorkspaces(new Set());
    getWorkspacesDeletedOnLeave()
      .then(setWorkspaces)
      .catch(() => {
        toast.error("Failed to load workspaces");
        setWorkspaces([]);
      });
  }, [open]);

  const allChecked =
    workspaces.length === 0 || checkedWorkspaces.size === workspaces.length;

  const totalApps = workspaces.reduce((n, p) => n + p.channelApps.length, 0);

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

  const handleLeave = () => {
    if (!allChecked) return;
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
              {workspaces.length > 0 && (
                <>
                  <p>
                    Acknowledge each workspace that will be permanently deleted:
                  </p>
                  <div className="rounded-md border">
                    {workspaces.map((workspace) => (
                      <label
                        key={workspace.id}
                        className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0"
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
                This will remove you from <strong>{orgName}</strong> and
                permanently delete your workspaces and data in this
                organization.
                {totalApps > 0 &&
                  " Their chat apps are uninstalled from your chat workspace, and anyone talking to them there loses the agent."}
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
            disabled={!allChecked || pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? "Leaving..." : "Leave and delete data"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
