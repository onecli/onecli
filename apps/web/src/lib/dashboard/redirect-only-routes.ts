/**
 * The dashboard URLs that are only redirects now (plans/flatten-ui.md, the
 * route map): every old address of a page that became a Settings modal page,
 * a block on a merged agent page, or the agent itself. Their page renders
 * nothing; the server answers with the new address.
 *
 * Next streams that answer to the browser inside the page, so it is applied
 * only once the dashboard has mounted, which on cloud waits for sign-in to
 * resolve. Until it lands, the dashboard shows the landing skeleton for these
 * URLs instead of drawing the old page's scope around an empty panel
 * (`PendingDashboard`, and the dashboard layout).
 *
 * One pattern per page template, segments as the URL spells them (route
 * groups dropped, `*` for one dynamic segment). `redirect-only-routes.test.ts`
 * checks this list against the `page.tsx` files on disk, both ways: a page
 * that stops redirecting, or a new redirect page, fails it.
 */
export const REDIRECT_ONLY_ROUTES = [
  "/org",
  "/org/*",
  "/org/*/app-availability",
  "/org/*/billing",
  "/org/*/channels",
  "/org/*/groups",
  "/org/*/settings",
  "/org/*/settings/app-availability",
  "/org/*/settings/channels",
  "/org/*/settings/general",
  "/org/*/settings/global-connections",
  "/org/*/settings/global-connections/apps",
  "/org/*/settings/global-connections/apps/*",
  "/org/*/settings/global-connections/connected",
  "/org/*/settings/global-connections/custom",
  "/org/*/settings/global-connections/llms",
  "/org/*/settings/org-api-keys",
  "/org/*/settings/policy",
  "/org/*/settings/sso",
  "/org/*/team",
  "/org/*/usage",
  "/w/*",
  "/w/*/activity",
  "/w/*/agents/*/apps",
  "/w/*/agents/*/channels",
  "/w/*/agents/*/instructions",
  "/w/*/agents/*/memory",
  "/w/*/agents/*/models",
  "/w/*/agents/*/secrets",
  "/w/*/agents/*/skills",
  "/w/*/agents/*/ssh",
  "/w/*/connections",
  "/w/*/connections/apps",
  "/w/*/connections/apps/*",
  "/w/*/connections/connected",
  "/w/*/connections/custom",
  "/w/*/connections/llms",
  "/w/*/connections/secrets",
  "/w/*/connections/vaults",
  "/w/*/connections/vaults/bitwarden",
  "/w/*/connections/vaults/onepassword",
  "/w/*/files",
  "/w/*/overview",
  "/w/*/settings",
  "/w/*/settings/api-key",
  "/w/*/settings/general",
  "/w/*/skills",
] as const;

const SEGMENT = "[^/]+";

const PATTERN = new RegExp(
  `^(?:${REDIRECT_ONLY_ROUTES.map((route) =>
    route
      .split("/")
      .map((part) => (part === "*" ? SEGMENT : part))
      .join("/"),
  ).join("|")})/?$`,
);

/** Whether `pathname` is one of the dashboard's old addresses, a page that
 *  only forwards to its new one. */
export const isRedirectOnlyPath = (pathname: string): boolean =>
  PATTERN.test(pathname);

/**
 * The account's addresses (`lib/account/account-page`, every page under
 * `/account`). They forward into Settings > Profile like the old addresses
 * above, except for a viewer with no org, who has no landing to forward to
 * and gets the profile there as a page. So they render, and only the
 * session can tell which of the two a visit is.
 */
export const isAccountPath = (pathname: string): boolean =>
  /^\/account(?:\/|$)/.test(pathname);
