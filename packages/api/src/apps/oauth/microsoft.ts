import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
  OAuthConfigField,
} from "../types";

const AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/**
 * Build a Microsoft identity platform v2.0 authorization URL.
 * Uses the `common` tenant so both personal Microsoft accounts and
 * work/school accounts can sign in.
 */
export const buildMicrosoftAuthUrl = ({
  appCredentials,
  redirectUri,
  scopes,
  state,
}: OAuthBuildAuthUrlParams): string => {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appCredentials.clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
};

/**
 * Exchange an authorization code for Microsoft OAuth tokens.
 */
export const exchangeMicrosoftCode = async ({
  appCredentials,
  callbackParams,
  redirectUri,
}: OAuthExchangeCodeParams): Promise<OAuthExchangeResult> => {
  if (callbackParams.error) {
    throw new Error(
      `Microsoft authorization error: ${callbackParams.error} — ${callbackParams.error_description ?? "no description"}`,
    );
  }

  if (!callbackParams.code) {
    throw new Error("Microsoft callback missing authorization code");
  }

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: callbackParams.code!,
      client_id: appCredentials.clientId!,
      client_secret: appCredentials.clientSecret!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    throw new Error(
      `Microsoft token exchange failed: ${tokenRes.status} ${tokenRes.statusText} — ${errorBody}`,
    );
  }

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

  // Microsoft returns scopes space-separated
  const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

  // Fetch user profile for connection metadata (non-fatal on failure)
  let metadata: Record<string, unknown> | undefined;
  const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (userRes.ok) {
    const user = (await userRes.json()) as {
      userPrincipalName?: string;
      mail?: string;
      displayName?: string;
    };
    metadata = {
      username: user.userPrincipalName ?? user.mail,
      name: user.displayName,
    };
  }

  return { credentials, scopes, metadata };
};

/** Standard BYOC config fields for Microsoft OAuth apps. */
export const microsoftConfigFields: OAuthConfigField[] = [
  {
    name: "clientId",
    label: "Application (client) ID",
    placeholder: "00000000-0000-0000-0000-000000000000",
  },
  {
    name: "clientSecret",
    label: "Client Secret",
    placeholder: "Secret value from Azure App Registration",
    secret: true,
  },
];

/** envDefaults for apps that use the shared platform Microsoft credentials. */
export const microsoftEnvDefaults = {
  clientId: "MICROSOFT_CLIENT_ID",
  clientSecret: "MICROSOFT_CLIENT_SECRET",
} as const;
