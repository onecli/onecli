"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { useAgentsForWorkspace } from "@/hooks/use-agents";
import { useWorkspacesList } from "@/hooks/use-workspaces";
import { getStartedPath } from "@/lib/agents/get-started-target";

interface GetStartedPickerProps {
  /** The org to pick a workspace from; null keeps the dialog closed. */
  organizationId: string | null;
  onOpenChange: (open: boolean) => void;
}

// The org/account-scope front door to your agent: pick a workspace of THIS org
// (explicit header override, server-fenced against the caller's memberships),
// then land wherever `getStartedPath` says — that workspace's existing agent,
// or the create flow when it has none. Only asks what the URL cannot answer —
// the workspace — and a single visible workspace skips even that. A router,
// not a content surface: the create form itself lives on the roster.
export const GetStartedPicker = ({
  organizationId,
  onOpenChange,
}: GetStartedPickerProps) => {
  const router = useRouter();
  const open = organizationId !== null;

  // Only the EXPLICIT pick is state; whether it was decided for you is derived
  // below, never stored alongside it.
  const [picked, setPicked] = useState<string>("");

  const { data: workspaces = [], isPending: workspacesPending } =
    useWorkspacesList({
      organizationId: organizationId ?? undefined,
      enabled: open,
    });
  // One workspace answers the only question this dialog asks, so it answers
  // itself and never renders the Select. Derived during render, not copied
  // into state by an effect that would flash the question for a frame.
  const onlyWorkspace = workspaces.length === 1 ? workspaces[0] : undefined;
  const workspaceId = picked || (onlyWorkspace?.id ?? "");
  const autoSkip = picked === "" && onlyWorkspace !== undefined;

  // The chosen workspace's agents decide create-vs-chat — only the chosen one
  // is read, never one request per listed workspace.
  const { data: agents = [], isPending: agentsPending } =
    useAgentsForWorkspace(workspaceId);

  // Reset on every close so the next open starts clean.
  useEffect(() => {
    if (!open) setPicked("");
  }, [open]);

  // Navigating IS a side effect, so this one stays an effect. It waits until
  // the destination is known: routing on a half-loaded agent list would send
  // someone who HAS an agent to the create form.
  useEffect(() => {
    if (!open || !autoSkip || !workspaceId || agentsPending) return;
    onOpenChange(false);
    router.push(getStartedPath(workspaceId, agents));
  }, [
    open,
    autoSkip,
    workspaceId,
    agentsPending,
    agents,
    onOpenChange,
    router,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          {/* Names the QUESTION, not the destination — create-vs-chat isn't
              known until a workspace is picked. */}
          <DialogTitle>Choose a workspace</DialogTitle>
          <DialogDescription>
            Your agents live in a workspace. Pick the one to open.
          </DialogDescription>
        </DialogHeader>

        {workspacesPending || autoSkip ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : workspaces.length === 0 ? (
          <p className="text-muted-foreground py-2 text-sm">
            You don&apos;t have access to any workspaces in this organization
            yet.{" "}
            <Link
              href={`/org/${organizationId}/workspaces`}
              className="text-foreground font-medium underline underline-offset-2"
              onClick={() => onOpenChange(false)}
            >
              Go to workspaces
            </Link>
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" id="gsp-workspace-label">
                Workspace
              </label>
              <Select value={workspaceId} onValueChange={setPicked}>
                <SelectTrigger
                  className="w-full"
                  aria-labelledby="gsp-workspace-label"
                >
                  <SelectValue placeholder="Select a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name ?? workspace.slug ?? workspace.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              variant="brand"
              onClick={() => {
                if (!workspaceId) return;
                onOpenChange(false);
                router.push(getStartedPath(workspaceId, agents));
              }}
              disabled={!workspaceId || agentsPending}
            >
              Continue
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
