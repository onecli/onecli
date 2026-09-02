"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/providers/auth-provider";
import { apiFetch } from "@/lib/api-fetch";

/**
 * The refusal in an accept response, if it carries one a person can read.
 *
 * The accept route answers its own refusals as `{ error: string }`, but a
 * fault reaches the browser as the global envelope `{ error: { message } }` —
 * and only a STRING may reach the screen: rendering an object would crash the
 * signup screen exactly when someone needs to be told what went wrong.
 */
const refusalMessage = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return null;
};

/**
 * Send a freshly authenticated visitor to their dashboard.
 *
 * The `GET /v1/auth/session` call is not just a lookup: it is what provisions
 * a brand-new account's organization, workspace and default agent, and what
 * hands a pre-2.0 deployment's data to the account that just registered. So
 * both the sign-in and the sign-up screens have to go through here — a plain
 * `window.location` jump to the dashboard would skip it and land on an
 * account that owns nothing.
 *
 * Returns a message when it cannot finish, because the screens render a
 * spinner while this runs: a failure that is only logged leaves someone who
 * has just signed in successfully watching it forever with nothing to act on.
 */
export const usePostAuthRedirect = (options?: {
  /** Present when this signup came from a join link — accept it once the
   *  session exists, and suppress the personal-org bootstrap on the way. */
  invitationToken?: string;
}): string | null => {
  const router = useRouter();
  const { isAuthenticated, user, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const syncUser = async () => {
      try {
        // A provision claim in flight (the /claim page stashed the marker
        // before sending them to sign in): suppress the org bootstrap like an
        // invitation and label the signup ping, then return to the claim page
        // — this is the self-host arm of the handoff the cloud login content
        // handles in ee/auth/login-content.tsx.
        const claimCallback = localStorage.getItem("claimCallbackUrl");
        const res = await apiFetch(
          claimCallback
            ? "/v1/auth/session?fromInvitation=1&fromClaim=1"
            : options?.invitationToken
              ? "/v1/auth/session?fromInvitation=1"
              : "/v1/auth/session",
        );
        if (res.ok) {
          if (claimCallback) {
            localStorage.removeItem("claimCallbackUrl");
            router.replace(claimCallback);
            return;
          }
          if (options?.invitationToken) {
            // Redeem it now: they clicked the link and filled the form, so
            // making them press "Join" on the next screen would be asking the
            // same question twice.
            const accepted = await apiFetch("/v1/invitations/accept", {
              method: "POST",
              body: JSON.stringify({ token: options.invitationToken }),
            });
            if (!accepted.ok) {
              // Signed in, but not joined — reachable when the account's
              // email is not the one the invitation was addressed to (a
              // Google signup under a different address). The refusal is
              // written for people; show it rather than navigating into an
              // account that belongs to no organization. Their own org
              // arrives self-healingly on the next plain sign-in.
              const body: unknown = await accepted.json().catch(() => null);
              setError(
                refusalMessage(body) ??
                  "You are signed in, but the invitation could not be redeemed.",
              );
              return;
            }
            // A full navigation: every server component below has already
            // rendered for someone who was not a member yet.
            window.location.assign("/");
            return;
          }
          const data = (await res.json()) as { workspaceId?: string };
          // No workspace context: the /org index server-redirects to the
          // validated /org/<defaultOrgId>/workspaces (the home destination).
          router.replace(
            data.workspaceId ? `/w/${data.workspaceId}/overview` : "/org",
          );
          return;
        }
        if (res.status === 401) {
          await signOut();
          return;
        }
        if (res.status === 429) {
          // Rate limited: retryable and not a setup failure — don't imply the
          // account is broken.
          setError(
            "Too many requests right now. Please wait a moment and reload.",
          );
          return;
        }
        // Signed in, but the account could not be set up — on a self-hosted
        // upgrade this is the deliberately loud failure of handing the old
        // install over, and it is retryable.
        setError(
          "You are signed in, but setting up your account did not finish. Reload to try again.",
        );
      } catch {
        // Transient error (deploy, network) — don't sign out
        setError("Could not reach the server. Reload to try again.");
      }
    };

    syncUser();
  }, [isAuthenticated, user, router, signOut, options?.invitationToken]);

  return error;
};
