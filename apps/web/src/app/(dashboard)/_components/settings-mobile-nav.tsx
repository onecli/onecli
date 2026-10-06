"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@onecli/ui/lib/utils";
import {
  activeSettingsItem,
  getSettingsSections,
  getWorkspaceSettingsSections,
} from "@/lib/nav-config";
import { ORG_PATH_RE, WORKSPACE_PATH_RE } from "@/lib/navigation";

export const SettingsMobileNav = () => {
  const pathname = usePathname();
  const orgId = pathname.match(ORG_PATH_RE)?.[1];
  const workspaceId = pathname.match(WORKSPACE_PATH_RE)?.[1];
  const sections = workspaceId
    ? getWorkspaceSettingsSections(workspaceId)
    : getSettingsSections(orgId);
  const items = sections.flatMap((s) => s.items);
  const activeUrl = activeSettingsItem(sections, pathname)?.url;
  const activeRef = useRef<HTMLAnchorElement>(null);
  const stripRef = useRef<HTMLElement>(null);

  // The strip scrolls sideways and the org list no longer fits a phone, so
  // an entry past the fold (Global Policy, API Keys) would be highlighted
  // off-screen. Center it by scrolling the STRIP only: scrollIntoView would
  // also move the page.
  useEffect(() => {
    const strip = stripRef.current;
    const active = activeRef.current;
    if (!strip || !active) return;
    const stripBox = strip.getBoundingClientRect();
    const activeBox = active.getBoundingClientRect();
    strip.scrollLeft +=
      activeBox.left - stripBox.left - (stripBox.width - activeBox.width) / 2;
  }, [activeUrl]);

  return (
    <nav
      ref={stripRef}
      aria-label="Settings"
      className="flex gap-1 overflow-x-auto border-b px-4 py-2 scrollbar-hide md:hidden"
    >
      {items.map((item) => {
        const isActive = item.url === activeUrl;
        return (
          <Link
            key={item.url}
            ref={isActive ? activeRef : undefined}
            href={item.url}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-brand/10 font-medium text-brand"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
};
