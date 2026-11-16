"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/providers/auth-provider";
import { checkDashboardRedirect } from "@/lib/user-plan";
import {
  getDashboardRedirect,
  isOrgless,
} from "@/lib/dashboard/session-redirect";
import { apiFetch } from "@/lib/api-fetch";
import { matchAgentPage } from "@/lib/navigation";
import { isTheaterAgentSection } from "@/lib/agents/agent-sections";
import { PlanGateProvider } from "@/lib/plan-gate";
import { DashboardShell } from "@/lib/dashboard/shell/dashboard-shell";
import { PendingDashboard } from "@/lib/dashboard/shell/pending-dashboard";
import { PendingLanding } from "@/lib/dashboard/shell/pending-landing";
import {
  isAccountPath,
  isRedirectOnlyPath,
} from "@/lib/dashboard/redirect-only-routes";
import { THEATER_FRAME } from "@/lib/dashboard/shell/shell-geometry";

export default function DashboardLayout({
  children,
  settings,
}: {
  children: React.ReactNode;
  /** The `@settings` slot: the Settings modal over the page, from
   *  `?settings=<page>`. Null whenever the param is absent. */
  settings?: React.ReactNode;
}) {
  const { isAuthenticated, isLoading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  // The session said this viewer belongs to no org: the account's
  // addresses render the profile for them instead of forwarding.
  const [orgless, setOrgless] = useState(false);
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

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
        if (res.status === 409) {
          // Identity conflict (relink rejected) — not transient, don't retry.
          // Sign out; the login page re-derives and shows the reason on the
          // next attempt.
          signOutRef.current();
          return;
        }
        if (res.ok) {
          sessionData = await res.json();
          break;
        }
        if (res.status === 429) {
          // Rate limited: retrying inside the window only feeds the limiter.
          // Fall through with no session data — the dashboard renders anyway
          // (the same graceful arm as a deploy-time outage).
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
        setOrgless(isOrgless(sessionData));
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

  if (isLoading || (isAuthenticated && !ready)) return <PendingDashboard />;

  if (!isAuthenticated) {
    return null;
  }

  // An old address only forwards: its page renders nothing and the server's
  // answer lands once this layout has mounted. Until it does, the landing
  // skeleton stays up (the same one as the wait above, so nothing moves),
  // instead of drawing the old page's scope around an empty panel. The page
  // mounts in the skeleton's panel, so its redirect goes through and an
  // error shows where the page would be. The account's addresses forward
  // the same way, unless the viewer has no org: then they are the page.
  if (isRedirectOnlyPath(pathname) || (isAccountPath(pathname) && !orgless)) {
    return <PendingLanding>{children}</PendingLanding>;
  }

  // The theater (the agent's full-page desktop) owns the whole viewport:
  // no rail, sidebar or top bar around it.
  if (isTheaterAgentSection(matchAgentPage(pathname)?.section ?? "")) {
    return (
      <PlanGateProvider>
        <main className={THEATER_FRAME}>{children}</main>
        {settings}
      </PlanGateProvider>
    );
  }

  return (
    <PlanGateProvider>
      {settings}
      <DashboardShell>{children}</DashboardShell>
    </PlanGateProvider>
  );
}
