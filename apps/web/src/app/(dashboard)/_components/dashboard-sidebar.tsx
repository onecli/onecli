"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";
import { navItems } from "@/lib/nav-items";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@onecli/ui/components/sidebar";

export const DashboardSidebar = ({
  ...props
}: React.ComponentProps<typeof Sidebar>) => {
  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader className="h-12 justify-center group-data-[collapsible=icon]:px-0">
        <Link
          href="https://onecli.sh"
          target="_blank"
          className="flex items-center px-2"
        >
          <Image
            src="/logo.svg"
            alt="OneCLI"
            width={100}
            height={28}
            priority
            className="group-data-[collapsible=icon]:hidden dark:hidden"
          />
          <Image
            src="/logo-dark.svg"
            alt="OneCLI"
            width={100}
            height={28}
            priority
            className="hidden dark:group-data-[collapsible=icon]:!hidden dark:block"
          />
          <Image
            src="/logo-icon.svg"
            alt="OneCLI"
            width={20}
            height={20}
            className="hidden group-data-[collapsible=icon]:block"
          />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} />
      </SidebarContent>
      <SidebarFooter className="justify-center group-data-[collapsible=icon]:px-0">
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};
