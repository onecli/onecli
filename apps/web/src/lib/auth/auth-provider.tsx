"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
} from "next-auth/react";
import { AuthContext } from "@/providers/auth-provider";
import type { AuthUser, AuthContextValue } from "@/lib/auth/types";
import type { AuthMode } from "@/lib/auth/auth-mode";
import { apiFetch } from "@/lib/api-fetch";

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
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadSession = async () => {
      try {
        const res = await apiFetch("/v1/auth/session");
        if (!res.ok) return;
        const session = (await res.json()) as Partial<AuthUser>;
        if (!session.id || !session.email) return;
        if (!cancelled) setUser(session as AuthUser);
      } catch {
        // Treat a failed session probe as signed out; route guards handle redirect.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void loadSession();

    return () => {
      cancelled = true;
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
      isLoading,
      user,
      signIn,
      signOut,
    }),
    [user, isLoading, signIn, signOut],
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

  return <OAuthInner>{children}</OAuthInner>;
};
