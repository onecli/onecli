import { orgHomePath, workspacePath } from "@/lib/navigation";
import {
  orgLandingAction,
  workspaceLandingAction,
} from "@/lib/workspaces/actions";

/**
 * The page a workspace or an org opens on (its first agent), looked up so
 * a navigation goes there in one hop instead of through the forwarding URL
 * (`/w/<id>`, `/org/<id>/workspaces`), whose page renders around its
 * redirect first. A failed lookup (a network blip, a deploy) answers the
 * forwarding URL, which lands in the same place one hop later: arriving a
 * little slower beats a navigation that errors out.
 */
export const workspaceLanding = (workspaceId: string): Promise<string> =>
  workspaceLandingAction(workspaceId).catch(() => workspacePath(workspaceId));

export const orgLanding = (orgId: string): Promise<string> =>
  orgLandingAction(orgId).catch(() => orgHomePath(orgId));
