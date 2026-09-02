import { apiFetch } from "@/lib/api-fetch";
import { getUserDefaultOrgId } from "@/lib/auth/default-org";

export const resolveHomeRedirect = async (): Promise<string> => {
  // A provision claim in flight: same bootstrap suppression as an invitation
  // (they are joining an existing org), plus the claim marker that labels the
  // signup ping "Via: provision claim". Claim-first, matching the login
  // page's consumer; the marker is cleared only after the sync lands so a
  // transient failure doesn't drop the claim on the floor.
  const claimCallback = localStorage.getItem("claimCallbackUrl");
  if (claimCallback) {
    await apiFetch("/v1/auth/session?fromInvitation=1&fromClaim=1");
    localStorage.removeItem("claimCallbackUrl");
    return claimCallback;
  }

  const inviteCallback = localStorage.getItem("inviteCallbackUrl");
  if (inviteCallback) {
    localStorage.removeItem("inviteCallbackUrl");
    await apiFetch("/v1/auth/session?fromInvitation=1");
    return inviteCallback;
  }

  // A parked post-auth return (a Slack-directory install finish): a plain
  // return-here with NO invitation semantics — a brand-new user must still
  // get their org bootstrapped by this very sync, or they land back on the
  // finish page org-less. Cleared only after the sync succeeds, like the
  // claim marker.
  const postAuthCallback = localStorage.getItem("postAuthCallbackUrl");

  const res = await apiFetch("/v1/auth/session");
  // Identity conflict (relink rejected) or a session-policy 401 (require
  // SSO): the login page owns the error UX — its own session sync hits the
  // same status, shows the reason, and signs out.
  if (res.status === 409 || res.status === 401) return "/auth/login";
  // Rate limited: the login page owns the error UX here too — its own sync
  // hits the same 429 and shows the retry message. Falling through would
  // misroute an existing user to org creation.
  if (res.status === 429) return "/auth/login";
  if (!res.ok) return "/create-org";
  if (postAuthCallback) {
    localStorage.removeItem("postAuthCallbackUrl");
    return postAuthCallback;
  }
  const data = (await res.json()) as { workspaceId?: string };

  // Validate the last-viewed-org cookie against the user's actual memberships
  // (falls back to their first org if it's stale/foreign), so a cookie left
  // over from a previous account can never misroute into an org they don't
  // belong to.
  const defaultOrgId = await getUserDefaultOrgId();
  if (defaultOrgId) return `/org/${defaultOrgId}/workspaces`;

  if (data.workspaceId) return `/w/${data.workspaceId}/overview`;

  return "/create-org";
};
