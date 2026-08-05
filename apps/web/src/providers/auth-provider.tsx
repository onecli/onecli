"use client";

import "@/lib/init/client";
import { createContext, useContext, type ReactNode } from "react";
import type { AuthContextValue } from "@/lib/auth/types";
import type { AuthMode, AuthProviderInfo } from "@/lib/auth/auth-mode";
import { AuthProviderImpl } from "@/lib/auth/auth-provider";

export type { AuthUser, AuthContextValue } from "@/lib/auth/types";

const AuthContext = createContext<AuthContextValue | null>(null);

export { AuthContext };

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

export const AuthProvider = ({
  children,
  authMode,
  authProvider,
}: {
  children: ReactNode;
  authMode: AuthMode;
  authProvider: AuthProviderInfo;
}) => (
  <AuthProviderImpl authMode={authMode} authProvider={authProvider}>
    {children}
  </AuthProviderImpl>
);
