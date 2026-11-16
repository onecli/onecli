import { redirect } from "next/navigation";
import { resolveOrgHome } from "@/lib/dashboard/home-landing";
import { resolveWorkspaceLanding } from "@/lib/workspaces/workspace-landing";
import { SETTINGS_PARAM, type SettingsPageId } from "./pages";

/**
 * An old settings route forwards to the Settings modal open on the
 * matching page over the scope's landing: the workspace's first agent, or
 * for an org the first visible workspace's. Server side, so no page body
 * runs behind it.
 *
 * Page-local params (`?tab=`) travel along: a bookmarked Global
 * Connections tab lands on the same tab inside the modal. 307, never 308:
 * a cached permanent redirect would outlive a second move.
 *
 * The modal decides what the viewer may see: a member who follows an
 * admin link lands on the page with the modal closed (the slot renders
 * nothing for a page the viewer cannot open), the same as the old admin
 * layout sending them home. With no workspace to land in (an org with
 * none) the landing is the org's workspaces page, and the modal opens
 * there. The account's addresses name no org: `lib/account/account-page`
 * picks the viewer's default one before calling this.
 */
export const redirectToSettingsModal = async (
  scope: { workspaceId: string } | { organizationId: string },
  page: SettingsPageId,
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<never> => {
  const landing =
    "workspaceId" in scope
      ? await resolveWorkspaceLanding(scope.workspaceId)
      : await resolveOrgHome(scope.organizationId);
  // Re-encoded through URLSearchParams, so a crafted value cannot steer the
  // path (the house rule for every value read off the URL). Not through
  // withSettingsParam: that clears page-local params like `tab` (stale ones
  // from the page under the modal), while here they come from the old page
  // itself and mean the same thing to its modal page.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === SETTINGS_PARAM) continue;
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value)) for (const v of value) query.append(key, v);
  }
  query.set(SETTINGS_PARAM, page);
  redirect(`${landing}?${query.toString()}`);
};
