import type { AppDefinition } from "./types";

// Pylon (usepylon.com) REST API: one organization API token, sent as a
// Bearer (docs.usepylon.com/pylon-docs/developer/api/authentication). Only
// Admins can create tokens, and there is no third-party OAuth on the public
// API, so the token is the only connection method. The hosted MCP server at
// mcp.usepylon.com authenticates with its own OAuth, not this token.
//
// The API is served from two regions, US and EU, and a token works only on
// the region its tenant is hosted in; Pylon publishes no way to discover the
// region from the token. So the user names it here, the identity probe below
// runs against that region, and the gateway rewrites the upstream host from
// the stored `region` (see the gateway host rewrite) so agents can keep
// calling the documented US base URL.

/** Pylon's API regions and the host each one is served from. */
export const PYLON_API_HOSTS = {
  us: "api.usepylon.com",
  eu: "api.eu.usepylon.com",
} as const;

export type PylonRegion = keyof typeof PYLON_API_HOSTS;

const isPylonRegion = (value: string): value is PylonRegion =>
  Object.hasOwn(PYLON_API_HOSTS, value);

/**
 * The region a submitted value names, or null for anything that is not one.
 * The gateway reads the STORED value verbatim and falls back to US for
 * anything unknown, so only a normalized, known region may be stored (see
 * `resolveMetadata`).
 */
export const normalizePylonRegion = (raw: string): PylonRegion | null => {
  const region = raw.trim().toLowerCase();
  return isPylonRegion(region) ? region : null;
};

/** `GET /me`: the organization (and user) behind the token, as read here. */
interface PylonMeResponse {
  data?: {
    name?: string;
    user?: { email?: string };
  };
}

/** Pylon's shared error body. `code` is the stable field to branch on. */
interface PylonErrorResponse {
  code?: string;
}

export const pylon: AppDefinition = {
  id: "pylon",
  name: "Pylon",
  // Pylon's own mark (the symbol from the wordmark on usepylon.com) in the
  // brand purple, which reads on light and dark backgrounds, so no darkIcon.
  icon: "/icons/pylon.svg",
  description:
    "B2B customer support. Manage issues, accounts, contacts, knowledge base articles, and tasks.",
  // No setupGuideUrl yet: onecli.sh/docs/integrations/pylon does not exist.
  apiDocsUrl:
    "https://docs.usepylon.com/pylon-docs/developer/api/api-reference",
  connectionMethod: {
    type: "api_key",
    // Token first: the connect handler stores fields[0] as `access_token`.
    // Region second: the gateway reads it from the stored credentials to pick
    // the upstream host.
    fields: [
      {
        name: "apiKey",
        label: "API token",
        description:
          "Create one in Pylon under Settings → API Tokens. Only Admin users can create API tokens.",
        placeholder: "<your Pylon API token>",
        secret: true,
        helpUrl: "https://app.usepylon.com/settings/api-tokens",
        helpLabel: "Get your API token",
      },
      {
        name: "region",
        label: "Region",
        // Required and visible, not tucked under "Advanced": a token only
        // works in its own region, and Pylon cannot tell us which from the
        // token, so the one fact the user must supply is asked for plainly.
        description:
          'Where your Pylon tenant is hosted: "us" or "eu". A token only works in its own region.',
        placeholder: "us",
        secret: false,
      },
    ],
    resolveMetadata: async (fields) => {
      const apiKey = fields.apiKey?.trim() ?? "";
      const region = normalizePylonRegion(fields.region ?? "");
      // Hard-fail an unknown region: the gateway would fall back to the US
      // host and every call from an EU tenant would then answer 401.
      if (!region) {
        throw new Error(
          'Region must be "us" or "eu" (where your Pylon tenant is hosted).',
        );
      }
      const regionTag = region.toUpperCase();

      // GET /me is the API's "who am I": the organization (and, for a human
      // token, the user's email). Probed on the chosen region, because a
      // token answers 401 wrong_region_token anywhere else. Bounded, because
      // the connect request awaits it; a timeout reads as unreachable below.
      const res = await fetch(`https://${PYLON_API_HOSTS[region]}/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);

      if (res?.status === 401) {
        // `code` is the stable field Pylon documents for branching; the
        // `errors` text is reworded freely and may be localized.
        const body = (await res
          .json()
          .catch(() => null)) as PylonErrorResponse | null;
        throw new Error(
          body?.code === "wrong_region_token"
            ? `This token belongs to Pylon's other region. Pick "${region === "us" ? "eu" : "us"}" and try again.`
            : "Pylon rejected this API token. Double-check the token and try again.",
        );
      }

      // The region is known even when the identity lookup is skipped or
      // fails, so a connection is always tagged with where its token works.
      // The connection label the user may type is applied by the connect
      // route itself and wins over any name returned here.
      const fallback: Record<string, unknown> = {
        name: "API Key",
        tags: [regionTag],
      };

      if (!res?.ok) {
        // Unreachable API, rate limited, or any other status: the connection
        // still succeeds, named by the region alone.
        return fallback;
      }

      const me = (await res.json().catch(() => null)) as PylonMeResponse | null;
      const orgName = me?.data?.name;
      if (!orgName) return fallback;

      // API tokens have no login email, so `email` is set only when present.
      const email = me.data?.user?.email;
      return {
        ...fallback,
        name: orgName,
        username: orgName,
        ...(email ? { email } : {}),
      };
    },
  },
  labelHint: 'e.g. "support", "eu-tenant"',
};
