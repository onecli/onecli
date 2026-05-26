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
import { getDashboardRedirect } from "@/lib/dashboard/session-redirect";
import { apiFetch } from "@/lib/api-fetch";

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

  const isSettings =
    pathname.startsWith("/settings") ||
    /^\/org\/[^/]+\/settings(\/|$)/.test(pathname);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  const initSession = useCallback(async () => {
    let sessionData: Record<string, unknown> | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await apiFetch("/v1/auth/session");
        if (res.status === 401) {
          signOutRef.current();
          return;
        }
        if (res.ok) {
          sessionData = await res.json();
          break;
        }
      } catch {
        // network error — fall through to retry
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    try {
      if (sessionData) {
        const sessionRedirect = getDashboardRedirect(sessionData, pathname);
        if (sessionRedirect) {
          router.replace(sessionRedirect);
          return;
        }
      }

      if (!pathname.startsWith("/account")) {
        const redirectTo = await checkDashboardRedirect();
        if (redirectTo) {
          router.replace(redirectTo);
          return;
        }
      }
    } catch {
      // redirect checks failed (server down during deploy) — render dashboard anyway
    }

    setReady(true);
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
            <main className="mx-auto min-w-0 max-w-6xl p-4 sm:p-6">
              {children}
            </main>
          </ScrollArea>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
