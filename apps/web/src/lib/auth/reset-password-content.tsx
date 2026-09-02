"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { PasswordInput } from "@/components/password-input";
import { AuthScreen } from "@/lib/auth/_components/auth-screen";
import { AuthFormError } from "@/lib/auth/_components/auth-form-error";
import { createOnpremAuthClient } from "@/lib/auth/auth-client";
import { authErrorMessage } from "@/lib/auth/auth-errors";

/** Matches the identity layer's own floor, so the form refuses before the API does. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Setting a new password from an emailed link.
 *
 * The token in the URL is the whole credential, and it is single-use — so a
 * failure here means asking for a fresh link rather than retrying this one,
 * and the copy says so.
 */
export const ResetPasswordContent = () => {
  const client = useMemo(() => createOnpremAuthClient(), []);
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = password.length >= MIN_PASSWORD_LENGTH && !submitting;

  const submit = async () => {
    if (!token) return;
    setError(null);
    setSubmitting(true);
    const { error: failure } = await client.resetPassword({
      newPassword: password,
      token,
    });
    setSubmitting(false);
    if (failure) {
      setError(authErrorMessage(failure));
      return;
    }
    setDone(true);
  };

  if (!token) {
    return (
      <AuthScreen
        title="Link incomplete"
        subtitle={<>That reset link is missing its token.</>}
      >
        <Button asChild size="lg" className="w-full text-base">
          <a href="/auth/login">Back to sign in</a>
        </Button>
      </AuthScreen>
    );
  }

  if (done) {
    return (
      <AuthScreen
        title="Password changed"
        subtitle={<>You can sign in with your new password.</>}
      >
        <Button asChild size="lg" className="w-full text-base">
          <a href="/auth/login">Sign in</a>
        </Button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title="Choose a new password"
      subtitle={
        <>
          This link works once, and
          <br />
          expires an hour after it was sent.
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit();
        }}
        className="space-y-4"
      >
        <PasswordInput
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
          disabled={submitting}
        />
        <p className="text-muted-foreground text-xs">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
        <Button
          size="lg"
          type="submit"
          className="w-full text-base"
          loading={submitting}
          disabled={!canSubmit}
        >
          {submitting ? "Saving..." : "Set new password"}
        </Button>
      </form>

      <AuthFormError message={error} />
    </AuthScreen>
  );
};
