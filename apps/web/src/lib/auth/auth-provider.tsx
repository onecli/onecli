"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import { IS_CLOUD } from "@/lib/env";
import { OnpremAuthProvider } from "@/lib/auth/auth-provider-onprem";
import { AuthProviderFallback } from "@/lib/auth/auth-provider-fallback";

/**
 * Cloud arm loaded lazily so the Cognito/Amplify (+ analytics) graph stays out
 * of the shared client bundle on non-cloud editions; while it loads, the
 * page's own waiting look shows (`AuthProviderFallback`), the same one the
 * dashboard or the login page shows until auth resolves anyway.
 */
const CognitoAuthProvider = dynamic(
  () => import("@/ee/auth/cognito-provider").then((m) => m.AuthProviderImpl),
  { ssr: false, loading: AuthProviderFallback },
);

/**
 * Edition dispatcher for the auth provider: cloud renders the Cognito/Amplify
 * provider; other editions read the self-hosted session cookie. The cloud arm
 * loads as a lazy chunk — the edition flag picks one at runtime.
 */
export const AuthProviderImpl = ({ children }: { children: ReactNode }) =>
  IS_CLOUD ? (
    <CognitoAuthProvider>{children}</CognitoAuthProvider>
  ) : (
    <OnpremAuthProvider>{children}</OnpremAuthProvider>
  );
