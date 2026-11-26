/**
 * Shared OAuth 2.0 client_credentials grant exchange.
 *
 * Used by providers that authenticate via service accounts (e.g., MongoDB Atlas,
 * Navan). Stores `client_id`, `client_secret`, and `token_url` alongside the
 * access token so the gateway can refresh autonomously when the token expires.
 *
 * The stored `token_url` is where the gateway later POSTs the client secret, so
 * it must only ever be a provider's own token endpoint. Callers pass a constant,
 * and `exchangeClientCredentials` re-checks it against `ALLOWED_TOKEN_URLS`:
 * a future definition that derives the URL from user input (a region, a
 * tenant) fails closed at connect time instead of persisting a secret-bearing
 * refresh target on an arbitrary host. Connections can only be created
 * through this path, so the gateway's refresh only ever sees these URLs.
 */

/** Every token endpoint a client_credentials connection may store. A new
 *  client_credentials provider adds its endpoint(s) here. */
export const ALLOWED_TOKEN_URLS: readonly string[] = [
  "https://cloud.mongodb.com/api/oauth/token",
  "https://app.navan.com/ta-auth/oauth/token",
  "https://app-fra.navan.com/ta-auth/oauth/token",
];

export interface ClientCredentialsParams {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

/** The token endpoint's JSON body. Providers add their own fields (Navan
 *  returns `company_uuid`, `scope`), so the extras stay visible to callers. */
export interface ClientCredentialsTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

export interface ClientCredentialsResult {
  credentials: Record<string, unknown>;
  accessToken: string;
  /** The raw token response, for provider-specific metadata. */
  tokenResponse: ClientCredentialsTokenResponse;
}

/**
 * The token endpoint answered with a non-2xx status. Carries the status so a
 * provider definition can branch on it (a 401 means "wrong id/secret", which
 * deserves a provider-specific hint) instead of parsing the message.
 */
export class ClientCredentialsExchangeError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(`Token exchange failed (${status}): ${detail}`);
    this.name = "ClientCredentialsExchangeError";
  }
}

export const exchangeClientCredentials = async ({
  tokenUrl,
  clientId,
  clientSecret,
}: ClientCredentialsParams): Promise<ClientCredentialsResult> => {
  if (!ALLOWED_TOKEN_URLS.includes(tokenUrl)) {
    throw new Error("Token URL is not an allowed client_credentials endpoint");
  }

  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (!tokenRes.ok) {
    // The message reaches the connect form (a rejected credential is a 400),
    // so surface the OAuth error fields when the body is JSON and otherwise
    // only the status text: never an arbitrary upstream body (an HTML 502
    // page, say) reflected back to the user.
    const body = (await tokenRes
      .json()
      .catch(() => null)) as ClientCredentialsTokenResponse | null;
    throw new ClientCredentialsExchangeError(
      tokenRes.status,
      body?.error_description ?? body?.error ?? tokenRes.statusText,
    );
  }

  const tokenData = (await tokenRes.json()) as ClientCredentialsTokenResponse;

  if (tokenData.error || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description ??
        tokenData.error ??
        "Failed to obtain access token",
    );
  }

  const expiresAt =
    Math.floor(Date.now() / 1000) + (tokenData.expires_in ?? 3600);

  return {
    accessToken: tokenData.access_token,
    tokenResponse: tokenData,
    credentials: {
      type: "client_credentials",
      access_token: tokenData.access_token,
      expires_at: expiresAt,
      client_id: clientId,
      client_secret: clientSecret,
      token_url: tokenUrl,
    },
  };
};
