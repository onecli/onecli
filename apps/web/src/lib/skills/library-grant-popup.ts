import { GITHUB_POPUP, openCenteredPopup } from "@/lib/connect-popup";
import { API_ORIGIN, getAuthToken } from "@/lib/api-fetch";

/** The message the skills-only GitHub install popup posts to its opener. */
export const LIBRARY_GRANT_MESSAGE = "skill-library-github-granted";

/**
 * "Install GitHub for skills only": the org GitHub App install in a popup,
 * started with `purpose=skills` so the callback stores NO connection and
 * hands back a signed grant instead. The window opens synchronously inside
 * the click (popup blockers), then is pointed at the authorize door once the
 * (async, cloud-only) auth token is known. Returns a cleanup, or null when a
 * blocker ate the window or there is no org to grant for (callers check the
 * org first, so null reads as blocked).
 */
export const openLibraryGrantPopup = (
  orgId: string,
  onGrant: (grant: string) => void,
): (() => void) | null => {
  // A grant names its org: never start one for no org.
  if (orgId === "") return null;
  // GitHub's install page is a desktop layout: the GitHub popup size.
  const popup = openCenteredPopup(
    "",
    "skill-library-github",
    GITHUB_POPUP.height,
    GITHUB_POPUP.width,
  );
  if (!popup) return null;
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== popup) return;
    const data = event.data as { type?: unknown; grant?: unknown };
    if (data?.type !== LIBRARY_GRANT_MESSAGE) return;
    if (typeof data.grant !== "string") return;
    window.removeEventListener("message", listener);
    onGrant(data.grant);
  };
  window.addEventListener("message", listener);
  void (async () => {
    // The same org authorize door the connect popup uses (`_org`).
    const params = new URLSearchParams({ purpose: "skills", _org: orgId });
    const token = await getAuthToken();
    if (token) params.set("_token", token);
    popup.location.href = `${API_ORIGIN}/v1/apps/github-app/authorize?${params}`;
  })();
  return () => window.removeEventListener("message", listener);
};
