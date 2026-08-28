"use client";

import dynamic from "next/dynamic";
import { IS_CLOUD } from "@/lib/env";
import {
  OnpremLoginContent,
  type OnpremLoginContentProps,
} from "@/lib/auth/login-content-onprem";

/**
 * Cloud arm loaded lazily so the Cognito login flow (Amplify graph) stays out
 * of the shared client bundle on non-cloud editions; the full-page spinner
 * matches the login page's own loading state.
 */
const CloudLoginContent = dynamic(
  () => import("@/ee/auth/login-content").then((m) => m.LoginContent),
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
 * Edition dispatcher for the login page: cloud renders the Cognito flow
 * (Google, email OTP, enterprise SSO); other editions render the self-hosted
 * email/password form. The cloud arm loads as a lazy chunk — the edition flag
 * picks one at runtime, and it has no use for the server-resolved props.
 */
export const LoginContent = (props: OnpremLoginContentProps) =>
  IS_CLOUD ? <CloudLoginContent /> : <OnpremLoginContent {...props} />;
