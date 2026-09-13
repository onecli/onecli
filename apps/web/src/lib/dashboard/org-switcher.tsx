"use client";

import { ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useActiveOrg } from "@/lib/dashboard/use-active-org";
import { OrgSwitcherItems } from "@/lib/dashboard/org-switcher-items";

export const OrgSwitcher = () => {
  const { orgs, activeOrg, activeOrgId, setActiveOrgId, isLoading } =
    useActiveOrg();

  if (isLoading) {
    return <Skeleton className="h-7 w-24 shrink-0 rounded-md" />;
  }

  if (!activeOrg) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${activeOrg.name}, switch organization`}
          className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-ring data-[state=open]:bg-sidebar-accent flex h-7 min-w-0 shrink items-center gap-1 rounded-md pr-1.5 pl-2 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50"
        >
          <span className="min-w-0 truncate">{activeOrg.name}</span>
          <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-56 rounded-lg"
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <OrgSwitcherItems
          orgs={orgs}
          activeOrgId={activeOrgId}
          setActiveOrgId={setActiveOrgId}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
