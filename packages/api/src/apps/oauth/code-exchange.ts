import type { OAuthExchangeResult } from "../types";

/**
 * Finish an authorization-code exchange from the vendor's OK token response:
 * reject an error or a missing access token, return the tokens and scopes,
 * and read the user's profile with the new access token. A non-OK profile
 * response leaves `metadata` undefined.
 */
export const completeCodeExchange = async <Profile>(
  tokenRes: Response,
  profileUrl: string,
  toMetadata: (user: Profile) => Record<string, unknown>,
): Promise<OAuthExchangeResult> => {
  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description ?? "Failed to exchange code for token",
    );
  }

  const expiresAt = tokenData.expires_in
    ? Math.floor(Date.now() / 1000) + tokenData.expires_in
    : undefined;

  const credentials: Record<string, unknown> = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type,
    expires_at: expiresAt,
  };

  // Space-separated, as RFC 6749 specifies (unlike GitHub's commas).
  const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

  let metadata: Record<string, unknown> | undefined;
  const userRes = await fetch(profileUrl, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (userRes.ok) {
    metadata = toMetadata((await userRes.json()) as Profile);
  }

  return { credentials, scopes, metadata };
};
