"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ScrollArea } from "@onecli/ui/components/scroll-area";
import { SidebarInset, SidebarProvider } from "@onecli/ui/components/sidebar";
import { DashboardSidebar } from "@dashboard/dashboard-sidebar";
import { DashboardHeader } from "@dashboard/dashboard-header";
import { useAuth } from "@/providers/auth-provider";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, isLoading, signOut } = useAuth();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  const initSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session");
      if (res.ok) {
        setReady(true);
      } else {
        signOutRef.current();
      }
    } catch {
      signOutRef.current();
    }
  }, []);

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
      className="bg-sidebar h-svh overflow-hidden"
      style={{ "--sidebar-width-icon": "2rem" } as React.CSSProperties}
    >
      <DashboardSidebar />
      <SidebarInset className="bg-background overflow-hidden rounded-none border md:rounded-xl md:peer-data-[variant=inset]:shadow-none md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-1">
        <header className="flex h-12 shrink-0 items-center border-b">
          <DashboardHeader />
        </header>
        <ScrollArea className="h-full min-h-0 flex-1">
          <main className="p-6">{children}</main>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  );
}
