"use client";

import { useEffect } from "react";

/**
 * Signed-out arm: park this exact page as the post-auth return and run the
 * normal login. After it, the viewer lands back here signed in. Only a
 * same-origin `/preview-auth?` path is ever parked (no open redirect).
 */
export const PreviewAuthSignIn = ({ callbackUrl }: { callbackUrl: string }) => {
  useEffect(() => {
    if (callbackUrl.startsWith("/preview-auth?")) {
      localStorage.setItem("postAuthCallbackUrl", callbackUrl);
    }
    window.location.replace("/auth/login");
  }, [callbackUrl]);
  return (
    <div className="text-muted-foreground flex min-h-svh items-center justify-center text-sm">
      Redirecting to sign in…
    </div>
  );
};
