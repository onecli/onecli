import { apiFetch } from "@/lib/api-fetch";
import { workspacePath } from "@/lib/navigation";
import { defaultLandingAction } from "@/lib/workspaces/actions";

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

  // The default org's first workspace and agent, resolved here so the home
  // page goes straight there: through the org's workspaces URL the shell
  // would render empty first, then forward. The org is the last-viewed one
  // validated against the user's actual memberships (their first org when
  // the cookie is stale or foreign), so a cookie left over from a previous
  // account can never misroute into an org they don't belong to. A failed
  // lookup takes `/org`, which resolves the same default server-side.
  const home = await defaultLandingAction().catch(() => "/org");
  if (home) return home;

  if (data.workspaceId) return workspacePath(data.workspaceId);

  return "/create-org";
};
