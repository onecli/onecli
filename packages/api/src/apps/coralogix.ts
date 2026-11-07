import type { AppDefinition } from "./types";

// Coralogix with an API key sent as a standard Bearer (coralogix.com/docs,
// API reference). Coralogix has no third-party OAuth, so the key is the only
// connection method.
//
// Every account lives in one Coralogix domain (region) and a key works only
// on its own region's API host. Nothing in the key says which, so the user
// names it here, the probe below runs against that region, and the gateway
// rewrites the upstream host from the stored `region` (see the gateway host
// rewrite) so an agent calling another region's host still lands on its own.

/** Coralogix domains (regions) whose API answers on `api.<region>.coralogix.com`. */
export const CORALOGIX_REGIONS = [
  "us1",
  "us2",
  "us3",
  "eu1",
  "eu2",
  "ap1",
  "ap2",
  "ap3",
] as const;

export type CoralogixRegion = (typeof CORALOGIX_REGIONS)[number];

/** Where each region's users sign in (coralogix.com/docs, Coralogix domain),
 *  shown in the region dropdown because it is what a user can recognize. */
const CORALOGIX_LOGIN_HOSTS: Record<CoralogixRegion, string> = {
  us1: "<team>.app.coralogix.us",
  us2: "<team>.app.cx498.coralogix.com",
  us3: "<team>.app.us3.coralogix.com",
  eu1: "<team>.coralogix.com",
  eu2: "<team>.app.eu2.coralogix.com",
  ap1: "<team>.app.coralogix.in",
  ap2: "<team>.app.coralogixsg.com",
  ap3: "<team>.app.ap3.coralogix.com",
};

const isCoralogixRegion = (value: string): value is CoralogixRegion =>
  (CORALOGIX_REGIONS as readonly string[]).includes(value);

/**
 * The region a submitted value names, or null for anything that is not one.
 * Accepts the bare code (`us2`) or the full domain (`us2.coralogix.com`),
 * case- and whitespace-insensitively. Only a normalized, known region may be
 * stored: the gateway declines to rewrite anything else.
 */
export const normalizeCoralogixRegion = (
  raw: string,
): CoralogixRegion | null => {
  const region = raw
    .trim()
    .toLowerCase()
    .replace(/\.coralogix\.com$/, "");
  return isCoralogixRegion(region) ? region : null;
};

export const coralogixApiHost = (region: CoralogixRegion): string =>
  `api.${region}.coralogix.com`;

/** `GET /aaa/identity/v1/whoami`: the team behind the key, as read here. */
interface CoralogixWhoAmIResponse {
  teamName?: string;
  teamUrl?: string;
  username?: string;
}

/** The team's web-app URL from whoami, stored only when it is an https URL
 *  on a Coralogix-owned domain: it comes from a response, not from us. */
const CORALOGIX_WEB_DOMAINS = [
  "coralogix.com",
  "coralogix.us",
  "coralogix.in",
  "coralogixsg.com",
];
const isCoralogixTeamUrl = (raw: string | undefined): raw is string => {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      CORALOGIX_WEB_DOMAINS.some((d) => url.hostname.endsWith(`.${d}`))
    );
  } catch {
    return false;
  }
};

export const coralogix: AppDefinition = {
  id: "coralogix",
  setupGuideUrl: "https://onecli.sh/docs/integrations/coralogix",
  name: "Coralogix",
  apiDocsUrl: "https://coralogix.com/docs/api-reference/introduction-v5/",
  apiSpecUrl: "https://api.us2.coralogix.com/mgmt/openapi/5/openapi.yaml",
  // Coralogix's own mark (the two-tone green circle from the brand kit),
  // which reads on light and dark backgrounds, so no darkIcon.
  icon: "/icons/coralogix.svg",
  description:
    "Observability for logs, metrics, and traces. Query data, and read alerts, incidents, and dashboards.",
  connectionMethod: {
    type: "api_key",
    // Key first: the connect handler stores fields[0] as `access_token`.
    // Region second: the gateway reads it to pick the upstream host.
    fields: [
      {
        name: "apiKey",
        label: "API key",
        description:
          "A personal or team API key from Settings → API Keys. Pick the DataQuerying preset for read-only querying.",
        placeholder: "<your Coralogix API key>",
        secret: true,
        helpUrl:
          "https://coralogix.com/docs/user-guides/account-management/api-keys/api-keys/",
        helpLabel: "How to create an API key",
      },
      {
        name: "region",
        label: "Region",
        // A dropdown labelled with the sign-in host, because that is the
        // one thing a user can read off their browser. US2 preselected.
        description: "Match the address you sign in to Coralogix at.",
        placeholder: "Select a region",
        secret: false,
        helpUrl:
          "https://coralogix.com/docs/user-guides/account-management/account-settings/coralogix-domain/",
        helpLabel: "Find your region",
        options: CORALOGIX_REGIONS.map((value) => ({
          value,
          label: `${value.toUpperCase()} (${CORALOGIX_LOGIN_HOSTS[value]})`,
        })),
        defaultValue: "us2",
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      const region = normalizeCoralogixRegion(fields.region ?? "");
      if (!region) {
        throw new Error(
          "Region must be one of us1, us2, us3, eu1, eu2, ap1, ap2, ap3 (your Coralogix domain).",
        );
      }
      const regionTag = region.toUpperCase();

      // whoami names the team behind the key. A key with no permission to
      // read it answers 403, which is still proof it authenticated; only a
      // 401 means a bad key (or a key from another region). Bounded: the
      // connect request awaits it.
      const res = await fetch(
        `https://${coralogixApiHost(region)}/mgmt/openapi/5/aaa/identity/v1/whoami`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        },
      ).catch(() => null);

      if (res?.status === 401) {
        throw new Error(
          `Coralogix rejected this API key in ${regionTag}. Double-check the key, and that your account is hosted in ${regionTag}.`,
        );
      }

      const fallback: Record<string, unknown> = {
        name: "API Key",
        tags: [regionTag],
      };
      if (!res?.ok) return fallback;

      const me = (await res
        .json()
        .catch(() => null)) as CoralogixWhoAmIResponse | null;
      const teamName = me?.teamName;
      if (!teamName) return fallback;
      return {
        ...fallback,
        name: teamName,
        username: teamName,
        ...(me.username ? { email: me.username } : {}),
        ...(isCoralogixTeamUrl(me.teamUrl) ? { url: me.teamUrl } : {}),
      };
    },
  },
  labelHint: 'e.g. "dataquerying", "prod-team"',
};
