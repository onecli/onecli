"use client";

import { usePathname } from "next/navigation";
import { isDashboardPath } from "@/lib/navigation";
import { PendingDashboard } from "@/lib/dashboard/shell/pending-dashboard";

/**
 * What shows while the cloud sign-in code loads. It wraps every page, so it
 * takes the page's look: the dashboard's skeleton on a dashboard URL (the
 * same picture the dashboard draws next, so a first visit reads as one page
 * filling in), and the sign-in screens' spinner anywhere else.
 */
export const AuthProviderFallback = () =>
  isDashboardPath(usePathname()) ? (
    <PendingDashboard />
  ) : (
    <div className="flex h-svh items-center justify-center">
      <div className="text-brand h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
    </div>
  );
