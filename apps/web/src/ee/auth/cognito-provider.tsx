"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getCurrentUser,
  fetchAuthSession,
  signInWithRedirect,
  signOut as amplifySignOut,
  signUp as amplifySignUp,
  signIn as amplifySignIn,
  confirmSignUp as amplifyConfirmSignUp,
  confirmSignIn as amplifyConfirmSignIn,
  autoSignIn as amplifyAutoSignIn,
} from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { AuthContext } from "@/providers/auth-provider";
import type {
  AuthUser,
  AuthContextValue,
  EmailOtpStep,
} from "@/lib/auth/types";
import { configureAmplify } from "@/ee/auth/amplify-config";
import { clearClientAuthState } from "@/ee/auth/logout-cleanup";
import { AnalyticsProvider } from "@/ee/analytics";

export const AuthProviderImpl = ({ children }: { children: ReactNode }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const checkAuthState = useCallback(async () => {
    try {
      const cognitoUser = await getCurrentUser();
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      setUser({
        id: cognitoUser.userId,
        email: (idToken?.payload?.email as string) ?? "",
        name: idToken?.payload?.name as string | undefined,
      });
      setIsAuthenticated(true);
    } catch {
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    configureAmplify();

    const stopHub = Hub.listen("auth", ({ payload }) => {
      switch (payload.event) {
        case "signedIn":
        case "signInWithRedirect":
          checkAuthState();
          break;
        case "signInWithRedirect_failure": {
          // OAuth exchange failed — fall through to /auth/login instead of
          // leaving the callback stuck on a loader. Surface the message
          // (Cognito passes the IdP's error_description through verbatim —
          // the one signal an org admin gets for a misconfigured IdP),
          // except the abandoned-flow noise Amplify emits when a leftover
          // inflight flag meets a plain page load.
          const message =
            payload.data?.error instanceof Error
              ? payload.data.error.message
              : null;
          if (message && !/cancell?ed/i.test(message)) {
            setAuthError(message);
          }
          // Amplify only cleans the callback URL on success — strip leftover
          // ?error params so reloads don't look broken.
          if (window.location.search.includes("error")) {
            window.history.replaceState(
              window.history.state,
              "",
              window.location.pathname,
            );
          }
          setUser(null);
          setIsAuthenticated(false);
          setIsLoading(false);
          break;
        }
        case "signedOut":
          // Note: isLoading is intentionally left as-is — signOut() keeps the
          // dashboard on its loader and owns the single post-logout navigation.
          setUser(null);
          setIsAuthenticated(false);
          break;
      }
    });

    // On the Cognito OAuth callback the browser lands on "/" with ?code&?state
    // while Amplify is still exchanging the code. Stay in the loading state and
    // let the Hub signInWithRedirect/_failure events above resolve us — running
    // checkAuthState now would briefly report "unauthenticated" and make
    // app/page.tsx bounce to /auth/login mid sign-in (the login flicker).
    // Scope to pathname "/" so app-integration OAuth callbacks (which carry
    // their own ?code on /connections/* routes) are not trapped on a loader.
    const params = new URLSearchParams(window.location.search);
    const isOAuthCallback =
      window.location.pathname === "/" &&
      params.has("code") &&
      params.has("state");
    if (!isOAuthCallback) {
      checkAuthState();
    }

    return () => stopHub();
  }, [checkAuthState]);

  // ── Google OAuth ──

  const signIn = useCallback(async () => {
    await signInWithRedirect({
      provider: "Google",
      options: { prompt: "SELECT_ACCOUNT" },
    });
  }, []);

  // ── Enterprise SSO (per-org SAML/OIDC IdPs registered in the pool) ──

  const signInWithSso = useCallback(async (provider: string) => {
    setAuthError(null);
    const redirect = () =>
      signInWithRedirect({ provider: { custom: provider } });
    try {
      await redirect();
    } catch (err) {
      // signInWithRedirect throws when a session already exists (e.g. a
      // signed-in user opening /auth/login/sso) — clear it and retry once.
      if (
        err instanceof Error &&
        err.name === "UserAlreadyAuthenticatedException"
      ) {
        await amplifySignOut();
        await redirect();
        return;
      }
      throw err;
    }
  }, []);

  const signOut = useCallback(async () => {
    // Keep the dashboard on its loader during sign-out: with isLoading true the
    // layout guard (!isLoading && !isAuthenticated) won't also soft-redirect to
    // /auth/login, so we navigate exactly once below.
    setIsLoading(true);

    // Clear analytics identity + all onecli-* app cookies up front, so the
    // teardown runs regardless of which sign-out path Amplify takes below.
    clearClientAuthState();

    // Federated (Google) sign-out makes Amplify redirect to the Cognito
    // hosted-UI logout endpoint — a full-page navigation we must NOT override,
    // or the Cognito session lingers and re-breaks account switching. Native
    // (email-OTP) sign-out resolves locally with no redirect, so we hard-
    // navigate ourselves to guarantee a clean slate (a full reload wipes the
    // React Query cache + any module state that could leak into the next user).
    let isFederated = false;
    try {
      const { tokens } = await fetchAuthSession();
      isFederated = Boolean(tokens?.idToken?.payload?.identities);
    } catch {
      // No resolvable session — treat as native.
    }

    try {
      await amplifySignOut();
    } finally {
      if (!isFederated) {
        window.location.replace("/auth/login");
      }
    }
  }, []);

  // ── Email OTP ──

  const signUpWithEmail = useCallback(
    async (email: string): Promise<EmailOtpStep> => {
      // Cognito SignUp API requires a password field even for EMAIL_OTP flows.
      // The user never sees or uses it — authentication is via OTP only.
      const password = crypto.randomUUID() + "!Aa1";
      const output = await amplifySignUp({
        username: email,
        password,
        options: {
          autoSignIn: {
            authFlowType: "USER_AUTH",
            preferredChallenge: "EMAIL_OTP",
          },
          userAttributes: { email },
        },
      });
      if (output.nextStep.signUpStep === "CONFIRM_SIGN_UP") {
        return "CONFIRM_SIGN_UP";
      }
      return "DONE";
    },
    [],
  );

  const signInWithEmail = useCallback(
    async (email: string): Promise<EmailOtpStep> => {
      const output = await amplifySignIn({
        username: email,
        options: {
          authFlowType: "USER_AUTH",
          preferredChallenge: "EMAIL_OTP",
        },
      });
      if (output.nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_EMAIL_CODE") {
        return "CONFIRM_SIGN_IN";
      }
      return "DONE";
    },
    [],
  );

  const confirmEmailSignUp = useCallback(
    async (email: string, code: string): Promise<boolean> => {
      const output = await amplifyConfirmSignUp({
        username: email,
        confirmationCode: code,
      });
      if (output.nextStep.signUpStep === "COMPLETE_AUTO_SIGN_IN") {
        const signInOutput = await amplifyAutoSignIn();
        return signInOutput.isSignedIn;
      }
      return false;
    },
    [],
  );

  const confirmEmailSignIn = useCallback(
    async (code: string): Promise<boolean> => {
      const output = await amplifyConfirmSignIn({
        challengeResponse: code,
      });
      return output.isSignedIn;
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
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
    }),
    [
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
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      <AnalyticsProvider>{children}</AnalyticsProvider>
    </AuthContext.Provider>
  );
};
