import type { AppDefinition, OAuthExchangeResult } from "./types";
import {
  ClientCredentialsExchangeError,
  exchangeClientCredentials,
  type ClientCredentialsResult,
} from "./oauth/client-credentials";

/**
 * Navan (travel + expense). Machine-to-machine OAuth 2.0 client_credentials:
 * a company admin creates a Client ID / Secret Key under Admin > Travel >
 * Settings > Integrations > Navan API credentials, and we exchange it for a
 * 12-hour bearer token the gateway re-mints on expiry.
 *
 * Every region serves the API from `api.navan.com`, but EU companies use a
 * separate token host AND must send `X-ta-region: EU` on every API call
 * (without it Navan answers 500). The region is picked from a closed set, so
 * a user value never becomes a URL or a header verbatim.
 */
const NAVAN_REGIONS = {
  us: {
    label: "US",
    tokenUrl: "https://app.navan.com/ta-auth/oauth/token",
    taRegion: undefined,
  },
  eu: {
    label: "EU",
    tokenUrl: "https://app-fra.navan.com/ta-auth/oauth/token",
    taRegion: "EU",
  },
} as const;

type NavanRegion = keyof typeof NAVAN_REGIONS;

const isNavanRegion = (value: string): value is NavanRegion =>
  Object.hasOwn(NAVAN_REGIONS, value);

export const parseNavanRegion = (raw: string | undefined): NavanRegion => {
  const value = (raw ?? "").trim().toLowerCase() || "us";
  if (!isNavanRegion(value)) {
    throw new Error('Region must be "us" or "eu"');
  }
  return value;
};

/** Navan Client IDs are UUIDs and Secret Keys are 32 hex characters. */
const CLIENT_ID_PATTERN =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi;
const SECRET_KEY_PATTERN = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;

/** Labels Navan's admin page shows next to the values, which come along
 *  when a user copies the whole row ("Secret Key: 873c..."). */
const LABEL_PREFIX = /^(?:client\s*id|secret\s*key|secret|key)\s*[:=]\s*/i;

const QUOTES = new Set(['"', "'", "`", "“", "”", "‘", "’"]);

/** Strip surrounding quotes with index scans: a `["']+$` regex is quadratic
 *  on a long run of quotes, and this input is user-supplied. */
const stripQuotes = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && QUOTES.has(s[start] ?? "")) start++;
  while (end > start && QUOTES.has(s[end - 1] ?? "")) end--;
  return s.slice(start, end);
};

/**
 * Reduce a pasted Navan value to the credential itself. Copying from Navan's
 * admin page can bring along the field label, quotes, "Copy key" or
 * invisible characters, and Navan then answers 401 for a valid credential.
 * When exactly one value of the expected shape is present it is used as is;
 * otherwise the label, quotes and whitespace are stripped and Navan judges
 * what remains, so a future format change is never rejected locally.
 */
export const cleanNavanValue = (
  raw: string | undefined,
  pattern: RegExp,
): string => {
  // Zero-width and BOM characters survive .trim() and break Basic auth.
  const text = (raw ?? "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  const matches = [...new Set(text.match(pattern) ?? [])];
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  return stripQuotes(text.replace(LABEL_PREFIX, "").trim()).trim();
};

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const clientId = cleanNavanValue(fields.clientId, CLIENT_ID_PATTERN);
  const clientSecret = cleanNavanValue(fields.clientSecret, SECRET_KEY_PATTERN);
  if (!clientId || !clientSecret) {
    throw new Error("Client ID and Secret Key are required");
  }

  const region = NAVAN_REGIONS[parseNavanRegion(fields.region)];

  let exchanged: ClientCredentialsResult;
  try {
    exchanged = await exchangeClientCredentials({
      tokenUrl: region.tokenUrl,
      clientId,
      clientSecret,
    });
  } catch (e) {
    // Navan answers a bare 401 for a wrong id/secret, a deleted credential,
    // or a credential from the other region.
    if (
      e instanceof ClientCredentialsExchangeError &&
      (e.status === 401 || e.status === 403)
    ) {
      throw new Error(
        `Navan rejected this Client ID / Secret Key for the ${region.label} region. Check both values, that the credential still exists in Navan, and the Region field. (${e.message})`,
        // Kept so the connect handler can log Navan's status and reason.
        { cause: e },
      );
    }
    throw e;
  }
  const { credentials, tokenResponse } = exchanged;

  // A credential created with no scope ticked mints a token that can call
  // nothing. Fail the connect with a fixable message rather than store a
  // connection whose every request 403s.
  const scopes = (tokenResponse.scope ?? "").split(" ").filter(Boolean);
  if (scopes.length === 0) {
    throw new Error(
      "This Navan credential has no scopes. Recreate it with Booking and/or Expense scopes selected.",
    );
  }

  const companyUuid =
    typeof tokenResponse.company_uuid === "string"
      ? tokenResponse.company_uuid
      : undefined;

  return {
    credentials: region.taRegion
      ? { ...credentials, ta_region: region.taRegion }
      : credentials,
    scopes,
    metadata: {
      name: `Navan (${region.label})`,
      ...(companyUuid ? { companyUuid } : {}),
      tags: [region.label],
    },
  };
};

export const navan: AppDefinition = {
  id: "navan",
  setupGuideUrl: "https://onecli.sh/docs/integrations/navan",
  name: "Navan",
  icon: "/icons/navan.svg",
  darkIcon: "/icons/navan-light.svg",
  apiDocsUrl: "https://docs.navan.com/api/",
  // The docs page covers the Expense API only. Bookings (`/v1/bookings`,
  // epoch-second `createdFrom`/`createdTo`, `size`) are documented solely in
  // this OpenAPI file; an agent guessing ISO dates there got a bare 500.
  apiSpecUrl: "https://app.navan.com/api/public-api.yml",
  description:
    "Read bookings and expense transactions, and sync expense data back to Navan.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        description:
          "From Navan Admin > Travel > Settings > Integrations > Navan API credentials",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        secret: false,
      },
      {
        name: "clientSecret",
        label: "Secret Key",
        description: "Shown once when the credential is created",
        placeholder: "Enter Secret Key",
        secret: true,
      },
      {
        name: "region",
        label: "Region",
        description: 'Your Navan data region: "us" (default) or "eu"',
        placeholder: "us",
        secret: false,
        optional: true,
      },
    ],
    exchangeCredentials,
  },
  labelHint: 'e.g. "acme-travel", "eu-entity"',
};
