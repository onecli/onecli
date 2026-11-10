import { workspaceLanding } from "@/lib/dashboard/landing";
import { defaultLandingAction } from "@/lib/workspaces/actions";

/**
 * Where a visitor goes the moment sign-in finishes: the page the dashboard
 * opens on (the session's workspace's first agent, or the default org's),
 * looked up now, so they land in one navigation. A failed lookup answers a
 * forwarding URL (`/w/<id>`, or `/org`, which sorts out an org-less
 * account) that still lands, one hop later: sign-in must never strand
 * someone on an error over a convenience.
 */
export const postAuthLanding = async (
  workspaceId: string | undefined,
): Promise<string> => {
  if (workspaceId) return workspaceLanding(workspaceId);
  const home = await defaultLandingAction().catch(() => "/org");
  return home ?? "/create-org";
};
