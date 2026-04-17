"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import {
  SessionProvider,
  useSession,
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
} from "next-auth/react";
import { AuthContext } from "@/providers/auth-provider";
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
  const { data: session, status } = useSession();

  const user = useMemo<AuthUser | null>(() => {
    if (!session?.user?.id || !session.user.email) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? undefined,
    };
  }, [session]);

  const signIn = useCallback(async () => {
    await nextAuthSignIn("oidc");
  }, []);

  const signOut = useCallback(async () => {
    await nextAuthSignOut({ callbackUrl: "/auth/login" });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: status === "authenticated",
      isLoading: status === "loading",
      user,
      signIn,
      signOut,
    }),
    [status, user, signIn, signOut],
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
