"use client";

import { Check, ChevronsUpDown, Layers } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { useActiveOrg } from "@/lib/dashboard/use-active-org";
import { OrgSwitcherItems } from "@/lib/dashboard/org-switcher-items";
import { useWorkspacesList } from "@/hooks/use-workspaces";
import { useGoToLanding } from "@/lib/dashboard/use-go-to-landing";
import { ScopeHeaderSkeleton } from "./scope-header-skeleton";
import { SIDEBAR_SCOPE_BOX, SIDEBAR_SCOPE_LABEL } from "./shell-geometry";

/**
 * The sidebar's bottom block: the org's name, and under it the workspace's
 * name only when the viewer can open more than one (with one workspace the
 * word never appears). The
 * whole block is a menu: the org list (every edition's org switcher), and
 * above it the workspaces of this org when there are several. Picking a
 * workspace opens its first agent, in one hop.
 */
export const ScopeHeader = ({
  workspaceId,
  orgId,
}: {
  workspaceId: string | undefined;
  /** The org the URL is in, when known (a `/w/` URL learns it from the
   *  workspace layout's broadcast; null until then). */
  orgId: string | null;
}) => {
  const { goToWorkspace } = useGoToLanding();
  const { orgs, activeOrg, activeOrgId, setActiveOrgId, isLoading } =
    useActiveOrg();
  // Workspaces of the current org, for the switcher. Scoped by the URL's
  // org (the api reads `X-Organization-Id` off `/org/` paths, the
  // workspace's org off `/w/` paths) so no explicit id is needed.
  const { data: workspaces = [] } = useWorkspacesList({
    enabled: Boolean(workspaceId || orgId),
  });
  const current = workspaces.find((w) => w.id === workspaceId);
  const several = workspaces.length > 1;

  if (isLoading) return <ScopeHeaderSkeleton />;

  const orgName = activeOrg?.name ?? null;
  // The label: the org, and the workspace when several exist (the
  // workspace's own name, or its id when it has none).
  const workspaceLabel = several
    ? (current?.name ?? (workspaceId ? "Workspace" : null))
    : null;

  return (
    <div>
      <p className={SIDEBAR_SCOPE_LABEL}>Organization</p>
      <div className={SIDEBAR_SCOPE_BOX}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                workspaceLabel
                  ? `${orgName ?? "Organization"}, ${workspaceLabel}. Switch organization or workspace`
                  : `${orgName ?? "Organization"}. Switch organization`
              }
              className="hover:bg-foreground/[0.05] focus-visible:ring-ring data-[state=open]:bg-foreground/[0.05] flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {orgName ?? "Organization"}
                </span>
                {workspaceLabel && (
                  <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
                    <Layers className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{workspaceLabel}</span>
                  </span>
                )}
              </span>
              <ChevronsUpDown
                className="text-muted-foreground size-3.5 shrink-0"
                aria-hidden
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="top"
            sideOffset={4}
            className="w-64 rounded-lg"
          >
            {several && (
              <>
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                  Workspaces
                </DropdownMenuLabel>
                {workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    aria-current={
                      workspace.id === workspaceId ? "true" : undefined
                    }
                    onSelect={() => {
                      if (workspace.id === workspaceId) return;
                      goToWorkspace(workspace.id);
                    }}
                    className="gap-2.5 p-2"
                  >
                    <span className="flex-1 truncate">
                      {workspace.name ?? "Workspace"}
                    </span>
                    {workspace.id === workspaceId && (
                      <Check className="text-muted-foreground ml-auto size-4" />
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <OrgSwitcherItems
              orgs={orgs}
              activeOrgId={activeOrgId}
              setActiveOrgId={setActiveOrgId}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
