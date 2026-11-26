"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sheet, SheetContent, SheetTitle } from "@onecli/ui/components/sheet";
import { useSidebarScope } from "@/lib/dashboard/use-sidebar-scope";
import { isAgentPagePath } from "@/lib/navigation";
import { DashboardRail } from "./dashboard-rail";
import { DashboardSidebar } from "./dashboard-sidebar";
import { DashboardTopBar } from "./dashboard-top-bar";
import {
  SHELL_BODY,
  SHELL_FRAME,
  SHELL_PAGE,
  SHELL_PAGE_SCROLL,
  SHELL_PANEL,
} from "./shell-geometry";

/**
 * The dashboard shell (plans/flatten-ui.md): rail, sidebar, top bar, page.
 * Settings is not a place in it: the gear opens the Settings modal over
 * whichever page is open (`?settings=<page>`, the `@settings` slot).
 *
 * Below `md` the rail and sidebar live in a sheet the top bar's menu
 * button opens.
 */
export const DashboardShell = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  const { workspaceId, orgId, workspacesUrl, navItems } = useSidebarScope();
  const [menuOpen, setMenuOpen] = useState(false);
  const isAgentPage = isAgentPagePath(pathname);

  const chrome = (
    <>
      <DashboardRail
        workspaceId={workspaceId ?? null}
        orgHref={workspacesUrl}
      />
      <DashboardSidebar
        workspaceId={workspaceId}
        orgId={orgId}
        navItems={navItems}
      />
    </>
  );

  return (
    <div className={SHELL_FRAME}>
      <div className="hidden shrink-0 md:flex">{chrome}</div>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[18.5rem] max-w-[90vw] flex-row gap-0 p-0 sm:max-w-[90vw]"
          onClick={(event) => {
            // A tap on a link closes the sheet; the page it opened is now
            // on screen behind it.
            if (event.target instanceof Element && event.target.closest("a"))
              setMenuOpen(false);
          }}
        >
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {chrome}
        </SheetContent>
      </Sheet>
      <div className={SHELL_PANEL}>
        <DashboardTopBar
          workspaceId={workspaceId}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <div className={SHELL_BODY}>
          {isAgentPage ? (
            children
          ) : (
            <div className={SHELL_PAGE_SCROLL}>
              <main className={SHELL_PAGE}>{children}</main>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
