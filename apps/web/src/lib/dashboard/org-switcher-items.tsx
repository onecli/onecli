"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Plus } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@onecli/ui/components/dropdown-menu";
import { OrgIcon } from "@/lib/dashboard/org-icon";
import type { UseActiveOrgResult } from "@/lib/dashboard/use-active-org";

export const OrgSwitcherItems = ({
  orgs,
  activeOrgId,
  setActiveOrgId,
}: Pick<UseActiveOrgResult, "orgs" | "activeOrgId" | "setActiveOrgId">) => {
  const router = useRouter();
  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
        Organizations
      </DropdownMenuLabel>
      {orgs.map((org) => (
        <DropdownMenuItem
          key={org.id}
          aria-current={org.id === activeOrgId ? "true" : undefined}
          onSelect={() => {
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
    </>
  );
};
