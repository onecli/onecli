"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import { readExternalAuthId } from "@onecli/api/lib/better-auth-contract";
import { AuthContext } from "@/providers/auth-provider";
import type { AuthUser, AuthContextValue } from "@/lib/auth/types";
import { createOnpremAuthClient } from "@/lib/auth/auth-client";
import { authErrorMessage } from "@/lib/auth/auth-errors";

/**
 * The self-hosted auth provider: one signed-in session, read from the cookie.
 *
 * It owns the single identity-layer client for the page. The sign-in and
 * sign-up forms go through the methods below rather than building a client of
 * their own, because the session store is per-client — a second instance would
 * authenticate successfully and leave this one still reporting "signed out",
 * so the redirect that follows a login would never fire.
 */
export const OnpremAuthProvider = ({ children }: { children: ReactNode }) => {
  // Built here rather than at module scope: the client is pointed at the API
  // origin, which a prebuilt image learns at runtime from the page.
  const client = useMemo(() => createOnpremAuthClient(), []);
  const { data, isPending } = client.useSession();

  const user = useMemo<AuthUser | null>(() => {
    const sessionUser = data?.user;
    if (!sessionUser?.email) return null;
    // Identity is externalAuthId everywhere downstream, never better-auth's
    // own row id.
    const id = readExternalAuthId(sessionUser);
    if (!id) return null;
    return {
      id,
      email: sessionUser.email,
      name: sessionUser.name ?? undefined,
    };
  }, [data]);

  const signIn = useCallback(
    async (options?: { callbackURL?: string }) => {
      await client.signIn.social({
        provider: "google",
        // Absolute, and this origin specifically. The provider redirects back
        // to the API server, which then forwards the browser here — a relative
        // path would resolve against the API origin and land the user on a
        // JSON 404 instead of the dashboard. Callers may pin a page on this
        // origin instead (an invited signup returns to its token-bearing URL).
        callbackURL: options?.callbackURL ?? window.location.origin,
      });
    },
    [client],
  );

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const { error } = await client.signIn.email({ email, password });
      // The client resolves rather than rejects, so a failure is only visible
      // by looking. Throwing here is what lets the forms use one try/catch.
      if (error) throw new Error(authErrorMessage(error));
    },
    [client],
  );

  const signUpWithPassword = useCallback(
    async (input: { name: string; email: string; password: string }) => {
      const { error } = await client.signUp.email(input);
      if (error) throw new Error(authErrorMessage(error));
    },
    [client],
  );

  const signOut = useCallback(async () => {
    await client.signOut();
    // A full navigation, not a router push: every server component below has
    // already rendered for the signed-in user and must be re-fetched.
    window.location.assign("/auth/login");
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: Boolean(user),
      isLoading: isPending,
      user,
      signIn,
      signInWithPassword,
      signUpWithPassword,
      signOut,
    }),
    [user, isPending, signIn, signInWithPassword, signUpWithPassword, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
