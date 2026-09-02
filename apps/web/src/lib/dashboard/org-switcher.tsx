"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useActiveOrg } from "@/lib/dashboard/use-active-org";
import { OrgIcon } from "@/lib/dashboard/org-icon";

export const OrgSwitcher = () => {
  const router = useRouter();
  const { orgs, activeOrg, activeOrgId, setActiveOrgId, isLoading } =
    useActiveOrg();

  if (isLoading) {
    return <Skeleton className="size-7 shrink-0 rounded-md" />;
  }

  if (!activeOrg) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="hover:bg-sidebar-accent focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:opacity-50">
          <ChevronsUpDown className="text-muted-foreground size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-56 rounded-lg"
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Organizations
        </DropdownMenuLabel>
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => {
              if (org.id === activeOrgId) return;
              setActiveOrgId(org.id);
              router.push(`/org/${org.id}/workspaces`);
            }}
            className="gap-2.5 p-2"
          >
            <OrgIcon name={org.name} />
            <span className="flex-1 truncate">{org.name}</span>
            {org.id === activeOrgId && (
              <Check className="text-muted-foreground ml-auto size-4" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2.5 p-2">
          <Link href="/create-org">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed">
              <Plus className="text-muted-foreground size-3.5" />
            </div>
            <span className="text-muted-foreground">Create organization</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
