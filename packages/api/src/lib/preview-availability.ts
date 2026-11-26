import { parse } from "tldts";
import { PREVIEW_DOMAIN, PREVIEW_RELAY_SECRET } from "./env";
import { logger } from "./logger";
import { configuredApiUrl, configuredAppUrl } from "./public-origins";

/**
 * Whether sandbox previews are live on this deployment, and why not.
 *
 * Dark unless PREVIEW_DOMAIN and a strong PREVIEW_RELAY_SECRET are both set.
 * Also dark when the preview domain shares a registrable domain with the
 * dashboard or api: then the browser could send the OneCLI login cookie
 * (shared-parent cookie domains, or a future change to them) to hosts that
 * run agent-written code, and that code could read the viewer's session.
 * Previews belong on a domain of their own.
 */

export const MIN_PREVIEW_RELAY_SECRET_LENGTH = 32;

export type PreviewAvailability =
  | { enabled: true; domain: string }
  | {
      enabled: false;
      reason:
        | "unconfigured"
        | "weak_secret"
        | "no_dashboard_url"
        | "shares_site_with_dashboard";
    };

const hostOf = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const siteOf = (host: string) =>
  parse(host, { allowPrivateDomains: true }).domain ?? host;

export const evaluatePreviewAvailability = (input: {
  domain: string;
  secret: string;
  appUrl?: string;
  apiUrl?: string;
}): PreviewAvailability => {
  const domain = input.domain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!domain || !input.secret)
    return { enabled: false, reason: "unconfigured" };
  if (input.secret.length < MIN_PREVIEW_RELAY_SECRET_LENGTH)
    return { enabled: false, reason: "weak_secret" };
  // The shared-site check below needs the dashboard's real address; without
  // it the check would silently pass. No address, no previews.
  if (!hostOf(input.appUrl))
    return { enabled: false, reason: "no_dashboard_url" };
  const previewSite = siteOf(domain);
  for (const url of [input.appUrl, input.apiUrl]) {
    const host = hostOf(url);
    if (!host) continue;
    if (
      siteOf(host) === previewSite ||
      host === domain ||
      host.endsWith(`.${domain}`)
    )
      return { enabled: false, reason: "shares_site_with_dashboard" };
  }
  return { enabled: true, domain };
};

let cached: PreviewAvailability | undefined;

/** Evaluated once per process (env is frozen at boot), logged once when dark
 * for a reason an operator must fix. */
export const previewAvailability = (): PreviewAvailability => {
  if (!cached) {
    cached = evaluatePreviewAvailability({
      domain: PREVIEW_DOMAIN,
      secret: PREVIEW_RELAY_SECRET,
      appUrl: configuredAppUrl(),
      apiUrl: configuredApiUrl(),
    });
    if (!cached.enabled && cached.reason !== "unconfigured") {
      logger.error(
        { reason: cached.reason },
        cached.reason === "weak_secret"
          ? `previews are OFF: PREVIEW_RELAY_SECRET must be at least ${MIN_PREVIEW_RELAY_SECRET_LENGTH} characters`
          : cached.reason === "no_dashboard_url"
            ? "previews are OFF: set APP_URL so the preview domain can be checked against the dashboard's"
            : "previews are OFF: PREVIEW_DOMAIN must be a separate registrable domain from APP_URL/API_URL, or a preview could read the dashboard login",
      );
    }
  }
  return cached;
};

export const previewsEnabled = () => previewAvailability().enabled;

/** Test seam: env-driven caches reset between suites. */
export const resetPreviewAvailability = () => {
  cached = undefined;
};
