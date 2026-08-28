"use client";

import posthog from "posthog-js";

const ONECLI_COOKIE_PREFIX = "onecli-";

/**
 * Tears down all client-side per-account state on logout: resets the analytics
 * identity and expires every `onecli-*` app cookie.
 *
 * Deliberately does NOT touch `CognitoIdentityServiceProvider.*` cookies —
 * `amplifySignOut()` owns those, and clearing them here would break the
 * federated (Google) logout redirect, which needs the live session to build the
 * Cognito hosted-UI logout URL.
 */
export const clearClientAuthState = (): void => {
  // PostHog persists `distinct_id` in its own storage and survives a reload, so
  // it must be reset explicitly to disassociate the next user's events.
  try {
    posthog.reset();
  } catch {
    // PostHog not initialised — nothing to reset.
  }

  // Expire every `onecli-*` cookie (e.g. `onecli-default-org`). The cookies are
  // host-only with `path=/`, so the same name + path + an expired max-age clears
  // them regardless of which writer set them (client or server). A prefix sweep
  // means any future app cookie is covered without extra wiring.
  for (const cookie of document.cookie.split("; ")) {
    const name = cookie.split("=")[0];
    if (name?.startsWith(ONECLI_COOKIE_PREFIX)) {
      document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
    }
  }
};
