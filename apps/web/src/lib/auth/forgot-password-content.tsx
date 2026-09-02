"use client";

import { useMemo, useState } from "react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { AuthScreen } from "@/lib/auth/_components/auth-screen";
import { AuthFormError } from "@/lib/auth/_components/auth-form-error";
import { createOnpremAuthClient } from "@/lib/auth/auth-client";
import { authErrorMessage } from "@/lib/auth/auth-errors";

/**
 * Asking for a reset link.
 *
 * The answer is deliberately the same whether or not an account exists — the
 * identity layer even equalises the timing — so this form cannot be used to
 * discover who has one. That means the confirmation below is a statement about
 * what WOULD have been sent, not a receipt.
 */
export const ForgotPasswordContent = () => {
  const client = useMemo(() => createOnpremAuthClient(), []);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    const { error: failure } = await client.requestPasswordReset({
      email: email.trim(),
    });
    setSubmitting(false);
    if (failure) {
      setError(authErrorMessage(failure));
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <AuthScreen
        title="Check your email"
        subtitle={
          <>
            If an account exists for that address,
            <br />a reset link is on its way.
          </>
        }
      >
        <Button asChild size="lg" className="w-full text-base">
          <a href="/auth/login">Back to sign in</a>
        </Button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title="Reset your password"
      subtitle={<>We will email you a link to set a new one.</>}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim() && !submitting) submit();
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
        <Button
          size="lg"
          type="submit"
          className="w-full text-base"
          loading={submitting}
          disabled={!email.trim() || submitting}
        >
          {submitting ? "Sending..." : "Send reset link"}
        </Button>
      </form>

      <p className="text-muted-foreground mt-4 text-center text-xs">
        <a href="/auth/login" className="hover:text-foreground underline">
          Back to sign in
        </a>
      </p>

      <AuthFormError message={error} />
    </AuthScreen>
  );
};
