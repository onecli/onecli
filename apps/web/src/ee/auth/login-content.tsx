"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@onecli/ui/components/input-otp";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useAuth } from "@/providers/auth-provider";
import { BrandLogo } from "@/lib/components/brand-logo";
import { GoogleIcon } from "@/lib/components/google-icon";
import { apiFetch } from "@/lib/api-fetch";
import {
  lookupSsoProvider,
  isPlausibleEmail,
} from "@/ee/auth/sso-lookup-client";

type Step = "providers" | "verification";
type OtpKind = "sign_up" | "sign_in";

export const LoginContent = () => {
  const router = useRouter();
  const {
    isAuthenticated,
    isLoading,
    user,
    signIn,
    signOut,
    signUpWithEmail,
    signInWithEmail,
    confirmEmailSignUp,
    confirmEmailSignIn,
    signInWithSso,
    authError,
  } = useAuth();

  const [step, setStep] = useState<Step>("providers");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otpKind, setOtpKind] = useState<OtpKind>("sign_in");
  const [signingIn, setSigningIn] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [redirectingSso, setRedirectingSso] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendTimer, setResendTimer] = useState(0);

  const hasEmailAuth = !!signUpWithEmail;
  const isEmailValid = isPlausibleEmail(email);
  const numberOfDigits = otpKind === "sign_in" ? 8 : 6;

  // Redirect on successful auth (existing flow)
  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const syncUser = async () => {
      try {
        const inviteCallback = localStorage.getItem("inviteCallbackUrl");
        // A provision claim rides the same suppression as an invitation (the
        // claimer joins an existing org), plus the marker that labels the
        // signup ping "Via: provision claim". Claim-first on BOTH the sync
        // URL and the redirect, and only the consumed marker is cleared, so
        // an abandoned invite can still resume on a later sign-in.
        const claimCallback = localStorage.getItem("claimCallbackUrl");
        // A parked post-auth return (a Slack-directory install finish):
        // plain return-here, NO invitation semantics — a brand-new user must
        // still get their org bootstrapped by this sync.
        const postAuthCallback = localStorage.getItem("postAuthCallbackUrl");
        const pendingCallback =
          claimCallback ?? inviteCallback ?? postAuthCallback;

        // An invited signup suppresses the org bootstrap: they are joining
        // someone else's organization, not starting their own.
        const res = await apiFetch(
          claimCallback
            ? "/v1/auth/session?fromInvitation=1&fromClaim=1"
            : inviteCallback
              ? "/v1/auth/session?fromInvitation=1"
              : "/v1/auth/session",
        );
        if (res.ok) {
          if (pendingCallback) {
            localStorage.removeItem(
              claimCallback
                ? "claimCallbackUrl"
                : inviteCallback
                  ? "inviteCallbackUrl"
                  : "postAuthCallbackUrl",
            );
            router.replace(pendingCallback);
          } else {
            const data = (await res.json()) as { workspaceId?: string };
            // No workspace context: the /org index server-redirects to the
            // validated /org/<defaultOrgId>/workspaces (the home destination).
            router.replace(
              data.workspaceId ? `/w/${data.workspaceId}/overview` : "/org",
            );
          }
        } else if (res.status === 401) {
          // Session-policy rejection (e.g. "require SSO") carries an explicit
          // reason — show it before signing out, like the 409 branch. Plain
          // unauthenticated 401s keep the silent sign-out.
          const data = (await res.json().catch(() => null)) as {
            error?: string;
            code?: string;
          } | null;
          if (data?.code === "sso_required" && data.error) {
            setError(data.error);
          }
          await signOut();
        } else if (res.status === 409) {
          // Identity conflict: this sign-in method may not take over the
          // existing account (see resolveIdentityConflict). Show the reason
          // and sign out so the user can retry with their original method.
          const data = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          setError(
            data?.error ??
              "This email is already associated with a different sign-in identity.",
          );
          await signOut();
        } else if (res.status === 429) {
          // Rate limited: retryable, so keep the session — signing out would
          // turn a brief throttle into a full re-login.
          setError(
            "Too many requests right now. Please wait a moment and try again.",
          );
        }
      } catch {
        // Transient error (deploy, network) — don't sign out
      }
    };

    syncUser();
  }, [isAuthenticated, user, router, signOut]);

  // Resend countdown timer
  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => setResendTimer((t) => t - 1), 1000);
    return () => clearInterval(interval);
  }, [resendTimer]);

  // Email continue: SSO home-realm discovery first, then try sign-up and
  // fall back to sign-in if the user exists
  const handleEmailContinue = useCallback(async () => {
    if (!email || !signUpWithEmail || !signInWithEmail) return;
    setError(null);
    setSendingCode(true);

    try {
      // Enterprise SSO check — a verified org domain with a live connection
      // sends the user to their IdP instead of the OTP flow. Fail-open by
      // design: a lookup outage must never block email login. EXCEPT when
      // the org REQUIRES SSO — then the OTP fallback would only lead to a
      // server-side rejection, so refuse it here with a clear message (the
      // session endpoint enforces regardless; this is UX, not the gate).
      if (signInWithSso) {
        const lookup = await lookupSsoProvider(email);
        if (lookup?.sso && lookup.provider) {
          setRedirectingSso(true);
          try {
            await signInWithSso(lookup.provider);
            return; // full-page redirect is taking over
          } catch {
            // Redirect failed to even start.
            setRedirectingSso(false);
            if (lookup.enforced) {
              setError(
                "Your organization requires single sign-on. Try again, or contact your administrator.",
              );
              return;
            }
            // Non-enforced org — fall back to the OTP flow.
          }
        }
      }

      try {
        const result = await signUpWithEmail(email);
        if (result === "CONFIRM_SIGN_UP") {
          setOtpKind("sign_up");
        }
      } catch {
        // signUp failed — user likely already exists.
        // Always try signIn as fallback (PreventUserExistenceErrors
        // hides the real error, so we can't check the message).
        try {
          const result = await signInWithEmail(email);
          if (result === "CONFIRM_SIGN_IN") {
            setOtpKind("sign_in");
          }
        } catch {
          // Both failed — silently proceed to verification step
        }
      }

      // Always move to verification step — never reveal if the email
      // was blocked, invalid, or if signup/signin failed
      setStep("verification");
      setResendTimer(60);
    } catch {
      // Even on unexpected errors, move to verification to avoid leaking info
      setStep("verification");
      setResendTimer(60);
    } finally {
      setSendingCode(false);
    }
  }, [email, signUpWithEmail, signInWithEmail, signInWithSso]);

  // Verify the OTP code
  const handleVerify = useCallback(async () => {
    if (!code || !confirmEmailSignUp || !confirmEmailSignIn) return;
    setError(null);
    setVerifying(true);

    try {
      const isSignedIn =
        otpKind === "sign_up"
          ? await confirmEmailSignUp(email, code)
          : await confirmEmailSignIn(code);

      if (!isSignedIn) {
        setError("Something went wrong. Please contact support@onecli.sh");
      }
      // On success, the Hub 'signedIn' event fires → checkAuthState →
      // isAuthenticated becomes true → useEffect above syncs & redirects
    } catch {
      setError("Something went wrong. Please contact support@onecli.sh");
    } finally {
      setVerifying(false);
    }
  }, [code, otpKind, email, confirmEmailSignUp, confirmEmailSignIn]);

  // Resend OTP code
  const handleResend = useCallback(async () => {
    if (resendTimer > 0 || !signInWithEmail) return;
    setError(null);
    try {
      await signInWithEmail(email);
      setOtpKind("sign_in");
      setResendTimer(60);
    } catch {
      setError("Something went wrong. Please contact support@onecli.sh");
    }
  }, [email, resendTimer, signInWithEmail]);

  const handleBack = useCallback(() => {
    setStep("providers");
    setCode("");
    setError(null);
  }, []);

  // ── Render ──

  const logo = <BrandLogo />;

  if (isLoading || isAuthenticated) {
    return (
      <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
        {logo}
        <div className="flex flex-col items-center gap-4 py-20">
          <div className="text-brand h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <p className="text-muted-foreground text-sm">
            {isAuthenticated ? "Signing you in..." : "Loading..."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
      {logo}

      <div className="mb-8 text-center">
        {step === "providers" ? (
          <>
            <h1 className="font-[family-name:var(--font-serif)] text-4xl font-semibold tracking-tight sm:text-5xl">
              Log in
            </h1>
            <p className="text-muted-foreground mt-3 text-lg">
              Continue with your account to
              <br />
              authenticate connections
            </p>
          </>
        ) : (
          <>
            <h1 className="font-[family-name:var(--font-serif)] text-4xl font-semibold tracking-tight sm:text-5xl">
              You&apos;re almost signed up
            </h1>
          </>
        )}
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-border/50 bg-card p-8">
        {step === "providers" ? (
          <>
            <Button
              size="lg"
              variant="outline"
              className="w-full gap-2 text-base bg-white text-black hover:bg-gray-100 dark:bg-white dark:text-black dark:hover:bg-gray-100"
              loading={signingIn}
              onClick={() => {
                setSigningIn(true);
                signIn();
              }}
            >
              <GoogleIcon />
              {signingIn ? "Redirecting..." : "Continue with Google"}
            </Button>

            {/* Email section */}
            {hasEmailAuth && (
              <>
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card text-muted-foreground px-2">
                      or
                    </span>
                  </div>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleEmailContinue();
                  }}
                  className="space-y-3"
                >
                  <Input
                    type="email"
                    placeholder="name@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    disabled={sendingCode}
                  />
                  <Button
                    size="lg"
                    type="submit"
                    className="w-full text-base"
                    loading={sendingCode || redirectingSso}
                    disabled={!isEmailValid}
                  >
                    {redirectingSso
                      ? "Redirecting to SSO..."
                      : sendingCode
                        ? "Sending code..."
                        : "Continue with email"}
                  </Button>
                </form>
              </>
            )}

            {(error ?? authError) && (
              <p
                aria-live="polite"
                className="text-destructive mt-4 text-center text-sm"
              >
                {error ?? authError}
              </p>
            )}

            {/* The reciprocal of the SSO page's "Not using SSO?" footer —
                the discoverable path for users told by IT to "use SSO",
                and the self-service way in if the email auto-detect ever
                fails open while their org enforces SSO. */}
            {signInWithSso && (
              <p className="text-muted-foreground mt-6 text-center text-sm">
                Using single sign-on?{" "}
                <Link
                  href="/auth/login/sso"
                  className="underline hover:text-foreground"
                >
                  Log in with SSO
                </Link>
              </p>
            )}

            <p className="text-muted-foreground mt-4 text-center text-xs">
              By continuing, you acknowledge OneCLI&apos;s{" "}
              <a
                href="https://onecli.sh/privacy"
                className="underline hover:text-foreground"
              >
                Privacy Policy
              </a>
              .
            </p>
          </>
        ) : (
          <div className="flex flex-col space-y-4">
            <p className="text-muted-foreground text-center text-sm">
              Enter the code we sent to{" "}
              <span className="text-foreground font-medium">{email}</span> to
              finish signing up.
            </p>

            <div className="grid w-full items-center gap-2.5">
              <InputOTP
                maxLength={numberOfDigits}
                pattern={REGEXP_ONLY_DIGITS}
                value={code}
                onChange={(value) => {
                  setCode(value);
                  if (error) setError(null);
                }}
                containerClassName="mx-auto"
                onComplete={handleVerify}
                autoFocus
                disabled={verifying}
              >
                <InputOTPGroup>
                  {Array.from({ length: numberOfDigits }).map((_, index) => (
                    <InputOTPSlot
                      key={index}
                      index={index}
                      className={error ? "border-red-500" : ""}
                    />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              {error && (
                <p className="text-center text-xs text-red-500">{error}</p>
              )}
            </div>

            <Button
              size="lg"
              className="w-full text-base"
              loading={verifying}
              disabled={code.length < numberOfDigits}
              onClick={handleVerify}
            >
              {verifying ? "Verifying..." : "Continue"}
            </Button>

            <div className="flex flex-col items-center space-y-1">
              {resendTimer > 0 ? (
                <p className="text-muted-foreground text-center text-sm">
                  Didn&apos;t get the code? Resend in {resendTimer}s
                </p>
              ) : (
                <p className="text-muted-foreground text-center text-sm">
                  Didn&apos;t get the code?{" "}
                  <Button
                    variant="link"
                    onClick={handleResend}
                    className="h-fit p-0"
                  >
                    Resend code
                  </Button>
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={handleBack}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 text-sm"
            >
              <span>&larr;</span> Use a different method
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
