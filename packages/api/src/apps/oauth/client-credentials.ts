/**
 * Shared OAuth 2.0 client_credentials grant exchange.
 *
 * Used by providers that authenticate via service accounts (e.g., MongoDB Atlas).
 * Stores `client_id`, `client_secret`, and `token_url` alongside the access token
 * so the gateway can refresh autonomously when the token expires.
 */

export interface ClientCredentialsParams {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface ClientCredentialsResult {
  credentials: Record<string, unknown>;
  accessToken: string;
}

export const exchangeClientCredentials = async ({
  tokenUrl,
  clientId,
  clientSecret,
}: ClientCredentialsParams): Promise<ClientCredentialsResult> => {
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
    const body = await tokenRes.text().catch(() => "");
    throw new Error(
      `Token exchange failed (${tokenRes.status}): ${body || tokenRes.statusText}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

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
