"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/providers/auth-provider";
import { resolveHomeRedirect } from "@/lib/home-redirect";
import { PendingDashboard } from "@/lib/dashboard/shell/pending-dashboard";

/**
 * The front door: works out where a visitor lands (sign-in, a parked
 * invitation or claim, or their default org's first agent) and goes there.
 * The dashboard's skeleton holds the screen meanwhile, so the wait reads
 * as the dashboard arriving, not a separate loading page.
 */
export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated) {
      router.replace("/auth/login");
      return;
    }

    resolveHomeRedirect()
      .then((url) => router.replace(url))
      .catch(() => router.replace("/auth/login"));
  }, [isLoading, isAuthenticated, router]);

  return <PendingDashboard />;
}
