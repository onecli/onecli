"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { LogIn } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useAuth } from "@/providers/auth-provider";

export const LoginContent = () => {
  const router = useRouter();
  const { isAuthenticated, isLoading, user, signIn, signOut } = useAuth();
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const syncUser = async () => {
      try {
        const res = await fetch("/api/auth/sync");
        if (res.ok) {
          router.replace("/overview");
        } else {
          console.error("Session sync failed:", res.status);
          await signOut();
        }
      } catch (err) {
        console.error("Session sync error:", err);
        await signOut();
      }
    };

    syncUser();
  }, [isAuthenticated, user, router, signOut]);

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
      <div className="mb-8">
        <Image
          src="/onecli-full-logo.png"
          alt="onecli"
          width={140}
          height={40}
          priority
          className="dark:hidden"
        />
        <Image
          src="/onecli-full-logo-dark.png"
          alt="onecli"
          width={140}
          height={40}
          priority
          className="hidden dark:block"
        />
      </div>

      {isLoading || isAuthenticated ? (
        <div className="flex flex-col items-center gap-4 py-20">
          <div className="text-brand h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <p className="text-muted-foreground text-sm">
            {isAuthenticated ? "Signing you in..." : "Loading..."}
          </p>
        </div>
      ) : (
        <>
          <div className="mb-8 text-center">
            <h1 className="font-[family-name:var(--font-serif)] text-4xl font-semibold tracking-tight sm:text-5xl">
              Log in
            </h1>
            <p className="text-muted-foreground mt-3 text-lg">
              Continue with your account to
              <br />
              authenticate connections
            </p>
          </div>

          <div className="w-full max-w-sm rounded-2xl border border-border/50 bg-card p-8">
            <Button
              size="lg"
              variant="outline"
              className="w-full gap-2 text-base"
              loading={signingIn}
              onClick={() => {
                setSigningIn(true);
                signIn();
              }}
            >
              <LogIn className="h-4 w-4" />
              {signingIn ? "Redirecting..." : "Sign in"}
            </Button>
            <p className="text-muted-foreground mt-4 text-center text-xs whitespace-nowrap">
              By continuing, you acknowledge OneCLI&apos;s{" "}
              <a
                href="https://onecli.sh/privacy"
                className="underline hover:text-foreground"
              >
                Privacy Policy
              </a>
              .
            </p>
          </div>
        </>
      )}
    </div>
  );
};
