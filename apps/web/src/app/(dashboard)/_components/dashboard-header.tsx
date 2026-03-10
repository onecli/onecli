"use client";

import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { SidebarTrigger } from "@onecli/ui/components/sidebar";
import { Separator } from "@onecli/ui/components/separator";
import { Button } from "@onecli/ui/components/button";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@onecli/ui/components/breadcrumb";
import { navItems } from "@/lib/nav-items";

export const DashboardHeader = () => {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const navItem = navItems.find((item) => pathname.startsWith(item.url));
  const title = navItem?.title ?? "Dashboard";

  // Detect sub-pages (e.g. /settings/profile → ["profile"])
  const subPath = navItem
    ? pathname.slice(navItem.url.length).replace(/^\//, "")
    : "";
  const subSegments = subPath ? subPath.split("/") : [];

  // Build a readable sub-page label from the last segment
  const lastSegment = subSegments[subSegments.length - 1];
  const subPageLabel = lastSegment
    ? lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1)
    : null;

  return (
    <div className="flex w-full items-center gap-2 px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {subPageLabel ? (
            <>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href={navItem!.url}>{title}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{subPageLabel}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : (
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        {typeof window !== "undefined" &&
          window.location.hostname !== "app.onecli.sh" && (
            <span className="rounded-md bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand">
              DEV
            </span>
          )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </div>
    </div>
  );
};
