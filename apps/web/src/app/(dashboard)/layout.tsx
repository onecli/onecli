"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { SidebarInset, SidebarProvider } from "@onecli/ui/components/sidebar";
import { DashboardSidebar } from "@dashboard/dashboard-sidebar";
import { DashboardHeader } from "@dashboard/dashboard-header";
import { SettingsNav } from "@/app/(dashboard)/settings/_components/settings-nav";
import { SettingsMobileNav } from "@/app/(dashboard)/settings/_components/settings-mobile-nav";
import { useAuth } from "@/providers/auth-provider";
import { checkDashboardRedirect } from "@/lib/user-plan";
import { getDashboardRedirect } from "@/lib/dashboard/validate-session";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, isLoading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

  const isSettings = pathname.startsWith("/settings");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  const initSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session");
      if (!res.ok) {
        signOutRef.current();
        return;
      }

      const data = await res.json();

      const sessionRedirect = getDashboardRedirect(data, pathname);
      if (sessionRedirect) {
        router.replace(sessionRedirect);
        return;
      }

      // Account pages are always accessible (e.g. from create-org to delete account)
      if (!pathname.startsWith("/account")) {
        const redirectTo = await checkDashboardRedirect();
        if (redirectTo) {
          router.replace(redirectTo);
          return;
        }
      }

      setReady(true);
    } catch {
      signOutRef.current();
    }
  }, [router, pathname]);

  useEffect(() => {
    if (isAuthenticated) {
      initSession();
    }
  }, [isAuthenticated, initSession]);

  if (isLoading || (isAuthenticated && !ready)) {
    return (
      <div className="flex h-svh items-center justify-center">
        <div className="text-brand h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SidebarProvider
      className="bg-background h-svh overflow-hidden"
      style={{ "--sidebar-width-icon": "2rem" } as React.CSSProperties}
    >
      <DashboardSidebar />
      <SidebarInset className="bg-background min-w-0 overflow-hidden rounded-none md:border md:rounded-xl md:peer-data-[variant=inset]:shadow-none md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-1">
        <header className="flex h-12 shrink-0 items-center border-b">
          <DashboardHeader />
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {isSettings && (
            <aside className="hidden w-56 shrink-0 overflow-y-auto border-r px-6 pt-6 md:block">
              <SettingsNav />
            </aside>
          )}
          <ScrollArea className="h-full min-h-0 min-w-0 flex-1 [&>[data-radix-scroll-area-viewport]]:!overflow-x-hidden">
            {isSettings && <SettingsMobileNav />}
            <main className="min-w-0 p-4 sm:p-6">{children}</main>
          </ScrollArea>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
