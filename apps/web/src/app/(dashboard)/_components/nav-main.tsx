"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type LucideIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@onecli/ui/components/sidebar";
import { cn } from "@onecli/ui/lib/utils";

const sidebarMenuButtonActiveStyles =
  "font-normal data-[active=true]:bg-brand/10 data-[active=true]:font-medium data-[active=true]:text-brand data-[active=true]:hover:bg-brand/15 dark:data-[active=true]:bg-brand/10 dark:data-[active=true]:text-brand dark:data-[active=true]:hover:bg-brand/15";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
}

interface NavMainProps {
  items: NavItem[] | NavItem[][];
}

export const NavMain = ({ items }: NavMainProps) => {
  const pathname = usePathname();

  const isActive = (url: string) => {
    if (url === "/") return pathname === "/";
    return pathname.startsWith(url);
  };

  const groups: NavItem[][] =
    items.length > 0 && Array.isArray(items[0])
      ? (items as NavItem[][])
      : [items as NavItem[]];

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
      {groups.map((group, i) => (
        <div key={i}>
          {i > 0 && <SidebarSeparator className="my-2" />}
          <SidebarMenu>
            {group.map((item) => (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive(item.url)}
                  tooltip={item.title}
                  className={cn(sidebarMenuButtonActiveStyles)}
                >
                  <Link href={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </div>
      ))}
    </SidebarGroup>
  );
};
