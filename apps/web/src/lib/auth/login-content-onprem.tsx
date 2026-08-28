"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { PasswordInput } from "@/components/password-input";
import { useAuth } from "@/providers/auth-provider";
import { AuthScreen } from "@/lib/auth/_components/auth-screen";
import { AuthDivider } from "@/lib/auth/_components/auth-divider";
import { AuthFormError } from "@/lib/auth/_components/auth-form-error";
import { GoogleButton } from "@/lib/auth/_components/google-button";
import { redirectErrorMessage } from "@/lib/auth/auth-errors";
import { usePostAuthRedirect } from "@/lib/auth/use-post-auth-redirect";
import { AuthPending } from "@/lib/auth/_components/auth-pending";

export interface OnpremLoginContentProps {
  /** Whether a "Continue with Google" button should be offered. */
  googleConfigured: boolean;
  /**
   * Whether this deployment can send email. Gates the password-reset offer:
   * without a provider the link would promise a message nobody can receive.
   */
  emailConfigured: boolean;
}

/** The self-hosted sign-in screen: email and password, plus Google if wired. */
export const OnpremLoginContent = ({
  googleConfigured,
  emailConfigured,
}: OnpremLoginContentProps) => {
  const { isAuthenticated, isLoading, signIn, signInWithPassword } = useAuth();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncError = usePostAuthRedirect();

  // A refused social sign-in comes back here as a redirect rather than a
  // response, so its reason arrives in the query string.
  const redirectError = searchParams.get("error");

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithPassword?.(email.trim(), password);
      // Deliberately stays submitting: the session has to propagate and the
      // redirect effect above takes over. Re-enabling the button here would
      // invite a second submit during that gap.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setSubmitting(false);
    }
  };

  if (isLoading || isAuthenticated) {
    // The spinner must never outlive the failure: someone whose sign-in
    // succeeded but whose account could not be resolved would otherwise wait
    // on it indefinitely.
    return (
      <AuthPending
        label={isAuthenticated ? "Signing you in..." : null}
        error={syncError}
      />
    );
  }

  const canSubmit = email.trim() !== "" && password !== "" && !submitting;

  return (
    <AuthScreen
      title="Log in"
      subtitle={
        <>
          Continue with your account to
          <br />
          authenticate connections
        </>
      }
    >
      {googleConfigured && (
        <>
          <GoogleButton
            label="Continue with Google"
            pending={redirecting}
            disabled={submitting}
            onClick={() => {
              setRedirecting(true);
              signIn();
            }}
          />
          <AuthDivider />
        </>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
        className="space-y-4"
      >
        <Input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoFocus
          disabled={submitting}
        />
        <PasswordInput
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={submitting}
        />
        <Button
          size="lg"
          type="submit"
          className="w-full text-base"
          loading={submitting}
          disabled={!canSubmit}
        >
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>

      {emailConfigured && (
        <p className="text-muted-foreground mt-4 text-center text-xs">
          <a
            href="/auth/forgot-password"
            className="hover:text-foreground underline"
          >
            Forgot your password?
          </a>
        </p>
      )}

      <p className="text-muted-foreground mt-4 text-center text-xs">
        New here?{" "}
        <a href="/auth/signup" className="hover:text-foreground underline">
          Create an account
        </a>
      </p>

      <AuthFormError
        message={
          error ?? (redirectError ? redirectErrorMessage(redirectError) : null)
        }
      />
    </AuthScreen>
  );
};
