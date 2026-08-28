"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import { IS_CLOUD } from "@/lib/env";
import { OnpremAuthProvider } from "@/lib/auth/auth-provider-onprem";

/**
 * Cloud arm loaded lazily so the Cognito/Amplify (+ analytics) graph stays out
 * of the shared client bundle on non-cloud editions; the full-page spinner
 * matches the dashboard/login loading state shown until auth resolves anyway.
 */
const CognitoAuthProvider = dynamic(
  () => import("@/ee/auth/cognito-provider").then((m) => m.AuthProviderImpl),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-svh items-center justify-center">
        <div className="text-brand h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </div>
    ),
  },
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
