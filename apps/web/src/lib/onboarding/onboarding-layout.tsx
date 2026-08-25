"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, Sun, LogOut, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useAuth } from "@/providers/auth-provider";
import { CAPS } from "@/lib/env";
import {
  checkOnboardingComplete,
  getOnboardingProgress,
} from "@/lib/onboarding/actions";
import { getActiveWorkspacePath } from "@/lib/workspaces/actions";
import { WORKSPACE_PATH_RE } from "@/lib/navigation";
import { OnboardingProvider } from "@/lib/onboarding/onboarding-context";
import { type OnboardingProgress } from "@/lib/onboarding/steps";
import { FlowChrome } from "@/lib/onboarding/_components/flow-chrome";
import { OnboardingFooter } from "@/lib/onboarding/_components/onboarding-footer";
import { OnboardingEscapeHatch } from "@/lib/onboarding/_components/onboarding-escape-hatch";

interface OnboardingBoot {
  progress: OnboardingProgress;
  /** The default workspace the flow creates into — resolved once at boot so
   * the API calls can target a workspace the URL doesn't carry. */
  workspaceId: string;
}

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const { signOut, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [boot, setBoot] = useState<OnboardingBoot | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace("/auth/login");
      return;
    }

    const bootFlow = async () => {
      // Onboarding is the billing editions' install walkthrough — nothing
      // routes here without billing, so a direct visit bounces home before
      // any billing action runs.
      if (!CAPS.billing) {
        router.replace(await getActiveWorkspacePath());
        return;
      }
      // Imported after the capability check so the billing actions (and the
      // Stripe graph behind them) never load in non-billing processes.
      const { getSubscriptionStatus } = await import("@/ee/billing/actions");
      const [{ status }, complete, path, progress] = await Promise.all([
        getSubscriptionStatus({ fallbackToDefault: true }),
        checkOnboardingComplete(),
        getActiveWorkspacePath(),
        getOnboardingProgress(),
      ]);
      // Completed means done: the flow stamps completion only on its final
      // click, which navigates away — so a completed user landing anywhere in
      // onboarding is a returning visitor, and the dashboard is their home.
      // A path without a workspace ("/create-org": the lazy default-workspace
      // creation found nothing) also bounces — the flow can't create an agent
      // with nowhere to put it, and that page is the way to get one.
      const workspaceId = path.match(WORKSPACE_PATH_RE)?.[1];
      if (status !== "free" || complete || !workspaceId) {
        router.replace(path);
      } else {
        setBoot({ progress, workspaceId });
      }
    };
    // Fail OPEN: a broken boot must never strand the user on the spinner.
    // The home page's own redirect resolves a working destination for any
    // member, so it is the safe harbor when a boot action rejects.
    bootFlow().catch(() => router.replace("/"));
  }, [isLoading, isAuthenticated, router]);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
  };

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
          <Image
            src="/onecli-full-logo.png"
            alt="OneCLI"
            width={110}
            height={32}
            priority
            className="dark:hidden"
          />
          <Image
            src="/onecli-full-logo-dark.png"
            alt="OneCLI"
            width={110}
            height={32}
            priority
            className="hidden dark:block"
          />
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">Toggle theme</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSignOut}
              disabled={signingOut}
            >
              {signingOut ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              {signingOut ? "Signing out..." : "Sign out"}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pb-4 md:px-8">
        {boot ? (
          <OnboardingProvider
            initialProgress={boot.progress}
            initialWorkspaceId={boot.workspaceId}
          >
            <FlowChrome>{children}</FlowChrome>
            <OnboardingFooter>
              <OnboardingEscapeHatch />
            </OnboardingFooter>
          </OnboardingProvider>
        ) : (
          <>
            <div className="my-auto flex items-center justify-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
            <OnboardingFooter />
          </>
        )}
      </div>
    </div>
  );
}
