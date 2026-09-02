"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";
import { PasswordInput } from "@/components/password-input";
import { useAuth } from "@/providers/auth-provider";
import { AuthScreen } from "@/lib/auth/_components/auth-screen";
import { AuthDivider } from "@/lib/auth/_components/auth-divider";
import { AuthFormError } from "@/lib/auth/_components/auth-form-error";
import { AuthPending } from "@/lib/auth/_components/auth-pending";
import { GoogleButton } from "@/lib/auth/_components/google-button";
import { redirectErrorMessage } from "@/lib/auth/auth-errors";
import { usePostAuthRedirect } from "@/lib/auth/use-post-auth-redirect";

/** Matches the identity layer's own floor, so the form refuses before the API does. */
const MIN_PASSWORD_LENGTH = 8;

const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export interface OnpremSignupContentProps {
  /** Whether a "Sign up with Google" button should be offered. */
  googleConfigured: boolean;
  /** Whether this account is the deployment's first. */
  firstAccount: boolean;
  /** Whether this registration takes over an existing pre-2.0 install. */
  adoptsExistingInstall: boolean;
  /**
   * Present when the visitor arrived from a join link. Resolved server-side
   * from the token, never from the URL — the email is what the invitation was
   * addressed to, so the field is fixed rather than merely pre-filled.
   */
  invitation?: {
    token: string;
    email: string;
    organizationName: string;
  };
}

/**
 * Create an account. Registration is open — the route serves this screen to
 * anyone — and the server-resolved props pick the framing: the deployment's
 * first account, a pre-2.0 takeover, an invited teammate, or an ordinary
 * signup that starts an organization of its own.
 */
export const OnpremSignupContent = ({
  googleConfigured,
  firstAccount,
  adoptsExistingInstall,
  invitation,
}: OnpremSignupContentProps) => {
  const { isAuthenticated, isLoading, signIn, signUpWithPassword } = useAuth();
  const searchParams = useSearchParams();

  const [name, setName] = useState("");
  const [email, setEmail] = useState(invitation?.email ?? "");
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncError = usePostAuthRedirect({
    invitationToken: invitation?.token,
  });

  const redirectError = searchParams.get("error");

  const passwordError = useMemo(
    () =>
      password.length > 0 && password.length < MIN_PASSWORD_LENGTH
        ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
        : null,
    [password],
  );
  // Only after they have left the field: complaining mid-typing about a
  // password that is simply not finished yet is noise.
  const showPasswordError = passwordTouched && passwordError !== null;

  const canSubmit =
    name.trim() !== "" &&
    isValidEmail(email.trim()) &&
    password.length >= MIN_PASSWORD_LENGTH &&
    !submitting;

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signUpWithPassword?.({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      // Stays submitting on purpose — the redirect effect takes it from here.
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create account.",
      );
      setSubmitting(false);
    }
  };

  if (isLoading || isAuthenticated) {
    // On an upgrading deployment this is where handing the old install over
    // happens, and it is the one step here that can fail after the account
    // already exists — so its message has to reach the screen.
    return (
      <AuthPending
        label={isAuthenticated ? "Setting things up..." : null}
        error={syncError}
      />
    );
  }

  return (
    <AuthScreen
      title={invitation ? "Join the team" : "Create your account"}
      subtitle={
        invitation ? (
          <>
            You have been invited to
            <br />
            {invitation.organizationName}.
          </>
        ) : adoptsExistingInstall ? (
          <>
            This account becomes the owner of this
            <br />
            OneCLI instance.
          </>
        ) : firstAccount ? (
          <>
            You are the first here. Set up
            <br />
            this OneCLI instance.
          </>
        ) : (
          <>
            Your account starts with an
            <br />
            organization of its own.
          </>
        )
      }
    >
      {adoptsExistingInstall && (
        <p className="border-border/60 bg-muted/40 text-muted-foreground mb-6 rounded-lg border px-4 py-3 text-sm">
          Your existing organization, workspaces, agents and API keys move to
          this account. There is nothing to migrate by hand.
        </p>
      )}

      {googleConfigured && (
        <>
          <GoogleButton
            label="Sign up with Google"
            pending={redirecting}
            disabled={submitting}
            onClick={() => {
              setRedirecting(true);
              // An invited signup must come back to THIS URL: the invitation
              // token only lives in it, and the post-auth accept (and the
              // personal-org suppression it rides on) needs it. The default
              // callback — the dashboard origin — would drop the token on
              // the floor across the OAuth round-trip.
              signIn(
                invitation ? { callbackURL: window.location.href } : undefined,
              );
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
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          autoFocus
          disabled={submitting}
        />
        <Input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          // Fixed by the invitation: an account under a different address
          // could not accept it, so editing it can only produce a dead end.
          readOnly={Boolean(invitation)}
          aria-readonly={invitation ? true : undefined}
          disabled={submitting}
          className={cn(invitation && "text-muted-foreground")}
        />
        <div className="space-y-2">
          <PasswordInput
            id="signup-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setPasswordTouched(true)}
            autoComplete="new-password"
            disabled={submitting}
            aria-invalid={showPasswordError || undefined}
            // Named, not just flagged: `aria-invalid` alone tells a screen
            // reader the field is wrong without ever saying why.
            aria-describedby={
              showPasswordError ? "signup-password-error" : undefined
            }
            className={cn(showPasswordError && "border-destructive")}
          />
          {showPasswordError && (
            <p id="signup-password-error" className="text-destructive text-xs">
              {passwordError}
            </p>
          )}
        </div>
        <Button
          size="lg"
          type="submit"
          className="w-full text-base"
          loading={submitting}
          disabled={!canSubmit}
        >
          {submitting ? "Creating account..." : "Create account"}
        </Button>
      </form>

      {!invitation && !firstAccount && (
        // Two variants go without the link: the invited screen stays
        // single-purpose (its visitor was asked for by email, and a plain
        // login would lose the token), and while the deployment awaits its
        // first account — adoption included — the login page redirects right
        // back here, so the link would be a silent dead end.
        <p className="text-muted-foreground mt-4 text-center text-xs">
          Already have an account?{" "}
          <a href="/auth/login" className="hover:text-foreground underline">
            Log in
          </a>
        </p>
      )}

      <AuthFormError
        message={
          error ?? (redirectError ? redirectErrorMessage(redirectError) : null)
        }
      />
    </AuthScreen>
  );
};
