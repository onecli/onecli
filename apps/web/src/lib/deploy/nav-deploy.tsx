"use client";

import Link from "next/link";
import { Rocket } from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@onecli/ui/components/sidebar";

export const NavDeploy = () => {
  return (
    <SidebarGroup className="mt-auto p-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Launch Agent">
            <Link href="/deploy" className="gap-2.5 group/deploy">
              <Rocket className="size-4 text-brand shrink-0 transition-transform duration-200 group-hover/deploy:-rotate-12" />
              <span className="truncate text-sm">Launch Agent</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
};
