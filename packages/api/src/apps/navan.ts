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

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const clientId = fields.clientId?.trim();
  const clientSecret = fields.clientSecret?.trim();
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
        `Navan rejected this Client ID / Secret Key for the ${region.label} region. Check both values, that the credential still exists in Navan, and the Region field.`,
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
  name: "Navan",
  icon: "/icons/navan.svg",
  darkIcon: "/icons/navan-light.svg",
  apiDocsUrl: "https://docs.navan.com/api/",
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
