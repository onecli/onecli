"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronsUpDown, Loader2, LogOut, Settings } from "lucide-react";

import { useAuth } from "@/providers/auth-provider";
import { useActiveOrg } from "@/lib/dashboard/use-active-org";
import { Avatar, AvatarFallback } from "@onecli/ui/components/avatar";
import { Badge } from "@onecli/ui/components/badge";
import { OrgSwitcherItems } from "@/lib/dashboard/org-switcher-items";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@onecli/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@onecli/ui/components/sidebar";

export const NavUser = () => {
  const { isMobile } = useSidebar();
  const { user, signOut } = useAuth();
  const { orgs, activeOrg, activeOrgId, setActiveOrgId } = useActiveOrg();
  const [signingOut, setSigningOut] = useState(false);

  const displayName = user?.name ?? user?.email ?? "User";
  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="size-8">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{displayName}</span>
                <span className="truncate text-xs">{user?.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "top"}
            align="end"
            sideOffset={4}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
          >
            {activeOrg && (
              <>
                {/* The whole organization block is the submenu trigger: it
                    reads like the old read-only label (eyebrow, name, role)
                    but the trailing chevron opens the org list. */}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="group">
                    <div className="grid min-w-0 flex-1 gap-1">
                      <span className="text-muted-foreground group-focus:text-accent-foreground/80 group-data-[state=open]:text-accent-foreground/80 text-xs">
                        Organization
                      </span>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {activeOrg.name}
                        </span>
                        <Badge
                          variant="outline"
                          className="shrink-0 px-1.5 py-0 text-[10px] capitalize"
                        >
                          {activeOrg.role}
                        </Badge>
                      </div>
                    </div>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg">
                      <OrgSwitcherItems
                        orgs={orgs}
                        activeOrgId={activeOrgId}
                        setActiveOrgId={setActiveOrgId}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuLabel className="font-normal">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="truncate text-sm leading-none font-medium">
                  {displayName}
                </p>
                <p className="text-muted-foreground truncate text-xs leading-none">
                  {user?.email}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account/preferences">
                <Settings />
                Account preferences
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                try {
                  await signOut();
                } catch {
                  setSigningOut(false);
                }
              }}
            >
              {signingOut ? <Loader2 className="animate-spin" /> : <LogOut />}
              {signingOut ? "Signing out..." : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
