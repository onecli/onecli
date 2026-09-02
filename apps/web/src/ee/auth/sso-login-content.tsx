"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { useAuth } from "@/providers/auth-provider";
import {
  lookupSsoProvider,
  isPlausibleEmail,
} from "@/ee/auth/sso-lookup-client";
import { BrandLogo } from "@/lib/components/brand-logo";

/**
 * Direct enterprise-SSO entry (/auth/login/sso) for users who know their org
 * signs in through an IdP — same chassis as the login page, minus the
 * OTP/Google surface. Unknown domains get an inline answer instead of the
 * main page's deliberately-opaque OTP fallback.
 */
export const SsoLoginContent = () => {
  const { signInWithSso, authError } = useAuth();

  const [email, setEmail] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isEmailValid = isPlausibleEmail(email);

  const handleContinue = useCallback(async () => {
    if (!email || !signInWithSso) return;
    setNotice(null);
    setRedirecting(true);
    try {
      const lookup = await lookupSsoProvider(email);
      if (lookup?.sso && lookup.provider) {
        await signInWithSso(lookup.provider);
        return; // full-page redirect is taking over
      }
      setNotice(
        lookup
          ? "Single sign-on isn't configured for this email domain."
          : "Something went wrong. Try again, or use the regular login.",
      );
    } finally {
      setRedirecting(false);
    }
  }, [email, signInWithSso]);

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
      <BrandLogo />

      <div className="mb-8 text-center">
        <h1 className="font-[family-name:var(--font-serif)] text-4xl font-semibold tracking-tight sm:text-5xl">
          Single sign-on
        </h1>
        <p className="text-muted-foreground mt-3 text-lg">
          Sign in with your organization&apos;s
          <br />
          identity provider
        </p>
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-border/50 bg-card p-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleContinue();
          }}
          className="flex flex-col gap-3"
        >
          <Input
            type="email"
            placeholder="name@company.com"
            aria-label="Work email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={redirecting}
          />
          <Button
            size="lg"
            type="submit"
            className="w-full text-base"
            loading={redirecting}
            disabled={!isEmailValid}
          >
            {redirecting ? "Redirecting to SSO..." : "Continue with SSO"}
          </Button>
        </form>

        {(notice ?? authError) && (
          <p
            aria-live="polite"
            className="text-destructive mt-4 text-center text-sm"
          >
            {notice ?? authError}
          </p>
        )}

        <p className="text-muted-foreground mt-6 text-center text-sm">
          Not using SSO?{" "}
          <Link href="/auth/login" className="underline hover:text-foreground">
            Log in another way
          </Link>
        </p>
      </div>
    </div>
  );
};
