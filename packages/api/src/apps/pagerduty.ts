import type { AppDefinition } from "./types";

// PagerDuty REST API v2 with a REST API key (developer.pagerduty.com,
// Authentication). The key is sent as `Authorization: Token token=<key>`,
// not as a Bearer, so the gateway has its own strategy for it. OAuth exists
// but a Scoped OAuth app only works on the account that registered it until
// PagerDuty publishes it, so the API key is the connection method.
//
// Accounts live in one of two service regions, and a key works only on its
// own region's API host. Nothing in the key says which, so the user names it
// here, the probe below runs against that region, and the gateway rewrites
// the upstream host from the stored `region` (see the gateway host rewrite)
// so agents can keep calling the documented US base URL.

/** PagerDuty's service regions and the REST API host each one is served from. */
export const PAGERDUTY_API_HOSTS = {
  us: "api.pagerduty.com",
  eu: "api.eu.pagerduty.com",
} as const;

export type PagerDutyRegion = keyof typeof PAGERDUTY_API_HOSTS;

const isPagerDutyRegion = (value: string): value is PagerDutyRegion =>
  Object.hasOwn(PAGERDUTY_API_HOSTS, value);

/**
 * The region a submitted value names, or null for anything that is not one.
 * Only a normalized, known region may be stored: the gateway falls back to
 * US for anything else.
 */
export const normalizePagerDutyRegion = (
  raw: string,
): PagerDutyRegion | null => {
  const region = raw.trim().toLowerCase();
  return isPagerDutyRegion(region) ? region : null;
};

/** `GET /users/me`: the user behind a USER token, as read here. */
interface PagerDutyMeResponse {
  user?: { name?: string; email?: string };
}

export const pagerduty: AppDefinition = {
  id: "pagerduty",
  setupGuideUrl: "https://onecli.sh/docs/integrations/pagerduty",
  name: "PagerDuty",
  apiDocsUrl: "https://docs.pagerduty.com/developer/api/reference",
  apiSpecUrl:
    "https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json",
  // The PagerDuty "P" mark in the brand green, which reads on light and dark
  // backgrounds, so no darkIcon.
  icon: "/icons/pagerduty.svg",
  description:
    "Incident response and on-call. Read and manage incidents, services, schedules, and on-call rotations.",
  connectionMethod: {
    type: "api_key",
    // Key first: the connect handler stores fields[0] as `access_token`.
    // Region second: the gateway reads it from the stored credentials to pick
    // the upstream host.
    fields: [
      {
        name: "apiKey",
        label: "API key",
        description:
          "A General Access REST API key from Integrations → API Access Keys (admins only), or a user key from My Profile → User Settings. Choose a read-only key if agents only need to read.",
        placeholder: "<your PagerDuty REST API key>",
        secret: true,
        helpUrl:
          "https://support.pagerduty.com/main/docs/api-access-keys#generate-a-general-access-rest-api-key",
        helpLabel: "How to create an API key",
      },
      {
        name: "region",
        label: "Region",
        // A dropdown, US preselected: a key only works in its own region
        // and the key itself cannot tell us which.
        description:
          "Where your PagerDuty account is hosted. EU accounts sign in at <subdomain>.eu.pagerduty.com.",
        placeholder: "Select a region",
        secret: false,
        options: [
          { value: "us", label: "US (api.pagerduty.com)" },
          { value: "eu", label: "EU (api.eu.pagerduty.com)" },
        ],
        defaultValue: "us",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      const region = normalizePagerDutyRegion(fields.region ?? "");
      if (!region) {
        throw new Error(
          'Region must be "us" or "eu" (where your PagerDuty account is hosted).',
        );
      }
      const regionTag = region.toUpperCase();

      // GET /users/me names the user behind a User Token. A General Access
      // (account) key has no user, so PagerDuty answers 400 there, which is
      // still proof the key authenticated. Only 401 means a bad key (or a key
      // from the other region). Bounded: the connect request awaits it.
      const res = await fetch(
        `https://${PAGERDUTY_API_HOSTS[region]}/users/me`,
        {
          headers: {
            Authorization: `Token token=${apiKey}`,
            Accept: "application/vnd.pagerduty+json;version=2",
          },
          signal: AbortSignal.timeout(5000),
        },
      ).catch(() => null);

      if (res?.status === 401) {
        throw new Error(
          `PagerDuty rejected this API key in the ${regionTag} region. Double-check the key, and that your account is hosted in ${regionTag}.`,
        );
      }

      const fallback: Record<string, unknown> = {
        name: "API Key",
        tags: [regionTag],
      };
      if (!res?.ok) return fallback;

      const me = (await res
        .json()
        .catch(() => null)) as PagerDutyMeResponse | null;
      const email = me?.user?.email;
      if (!email) return fallback;
      return {
        ...fallback,
        name: me.user?.name ?? email,
        email,
        username: email,
      };
    },
  },
  labelHint: 'e.g. "read-only", "sre-team"',
};
