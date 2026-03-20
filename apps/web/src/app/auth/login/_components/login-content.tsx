"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@onecli/ui/components/button";
import { useAuth } from "@/providers/auth-provider";

export const LoginContent = () => {
  const router = useRouter();
  const { isAuthenticated, isLoading, user, signIn, signOut } = useAuth();

  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const syncUser = async () => {
      try {
        const res = await fetch("/api/auth/session");
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
              className="w-full gap-2 text-base bg-white text-black hover:bg-gray-100 dark:bg-white dark:text-black dark:hover:bg-gray-100"
              onClick={() => signIn()}
            >
              <GoogleIcon />
              Continue with Google
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

const GoogleIcon = () => (
  <svg
    className="h-4 w-4"
    viewBox="-3 0 262 262"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622 38.755 30.023 2.685.268c24.659-22.774 38.875-56.282 38.875-96.027"
      fill="#4285F4"
    />
    <path
      d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055-34.523 0-63.824-22.773-74.269-54.25l-1.531.13-40.298 31.187-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1"
      fill="#34A853"
    />
    <path
      d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82 0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602l42.356-32.782"
      fill="#FBBC05"
    />
    <path
      d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0 79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251"
      fill="#EB4335"
    />
  </svg>
);
