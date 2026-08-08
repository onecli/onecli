"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  SessionProvider,
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
} from "next-auth/react";
import { AuthContext } from "@/providers/auth-provider";
import { apiFetch } from "@/lib/api-fetch";
import type { AuthUser, AuthContextValue } from "@/lib/auth/types";
import type { AuthMode } from "@/lib/auth/auth-mode";

const LOCAL_USER: AuthUser = {
  id: "local-admin",
  email: "admin@localhost",
  name: "Admin",
};

const LocalAuthProvider = ({ children }: { children: ReactNode }) => {
  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: true,
      isLoading: false,
      user: LOCAL_USER,
      signIn: async () => {},
      signOut: async () => {},
    }),
    [],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

const OAuthInner = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Read the signed-in user from /v1/auth/session — the same endpoint the
  // dashboard layout uses. It returns the OneCLI profile directly
  // (flat { id, email, name }), not NextAuth's { user } wrapper, so the
  // identity must be read off the response root.
  useEffect(() => {
    let active = true;
    apiFetch("/v1/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { id?: string; email?: string; name?: string } | null) => {
        if (!active) return;
        setUser(
          data?.id && data.email
            ? { id: data.id, email: data.email, name: data.name ?? undefined }
            : null,
        );
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async () => {
    await nextAuthSignIn("google");
  }, []);

  const signOut = useCallback(async () => {
    await nextAuthSignOut({ callbackUrl: "/auth/login" });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: user !== null,
      isLoading: loading,
      user,
      signIn,
      signOut,
    }),
    [user, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const AuthProviderImpl = ({
  children,
  authMode,
}: {
  children: ReactNode;
  authMode: AuthMode;
}) => {
  if (authMode === "local") {
    return <LocalAuthProvider>{children}</LocalAuthProvider>;
  }

  return (
    <SessionProvider>
      <OAuthInner>{children}</OAuthInner>
    </SessionProvider>
  );
};
