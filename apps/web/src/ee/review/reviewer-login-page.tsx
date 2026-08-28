"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  getCurrentUser,
  fetchAuthSession,
} from "aws-amplify/auth";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { configureAmplify } from "@/ee/auth/amplify-config";
import { clearClientAuthState } from "@/ee/auth/logout-cleanup";
import { apiFetch } from "@/lib/api-fetch";
import { BrandLogo } from "@/lib/components/brand-logo";

const ALLOWED_EMAIL = "test@onecli.sh";

const ReviewerLoginPage = () => {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    configureAmplify();
  }, []);

  const handleLogin = useCallback(async () => {
    setError(null);
    setLoading(true);

    if (email.toLowerCase() !== ALLOWED_EMAIL) {
      setError("This login is restricted to the test account.");
      setLoading(false);
      return;
    }

    try {
      clearClientAuthState();
      await amplifySignOut().catch(() => {});

      const output = await amplifySignIn({
        username: ALLOWED_EMAIL,
        password,
      });

      if (!output.isSignedIn) {
        setError("Sign-in failed. Check your credentials.");
        setLoading(false);
        return;
      }

      await getCurrentUser();
      await fetchAuthSession();

      const res = await apiFetch("/v1/auth/session");
      if (res.ok) {
        apiFetch("/v1/reviewer/login-notify", { method: "POST" }).catch(
          () => {},
        );
        const data = (await res.json()) as { workspaceId?: string };
        router.replace(
          data.workspaceId ? `/w/${data.workspaceId}/overview` : "/workspaces",
        );
      } else {
        setError("Session sync failed.");
        setLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid credentials.");
      setLoading(false);
    }
  }, [email, password, router]);

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
      <BrandLogo />

      <div className="mb-8 text-center">
        <h1 className="font-[family-name:var(--font-serif)] text-4xl font-semibold tracking-tight sm:text-5xl">
          Reviewer Login
        </h1>
        <p className="text-muted-foreground mt-3 text-lg">
          Sign in with test credentials
        </p>
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-border/50 bg-card p-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleLogin();
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
            disabled={loading}
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={loading}
          />
          <Button
            size="lg"
            type="submit"
            className="w-full text-base"
            loading={loading}
            disabled={!email || !password}
          >
            {loading ? "Signing in..." : "Sign in"}
          </Button>
        </form>

        {error && (
          <div className="mt-4 text-center text-sm">
            <p className="text-destructive">{error}</p>
            <p className="text-muted-foreground mt-1">
              Need help? Reach out via{" "}
              <a
                href="mailto:support@onecli.sh"
                className="underline hover:text-foreground"
              >
                support@onecli.sh
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReviewerLoginPage;
