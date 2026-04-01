import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
  OAuthConfigField,
} from "./types";

/**
 * Build a Google OAuth 2.0 authorization URL.
 * Shared by all Google Workspace app integrations.
 */
export const buildGoogleAuthUrl = ({
  clientId,
  redirectUri,
  scopes,
  state,
}: OAuthBuildAuthUrlParams): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

/**
 * Exchange an authorization code for Google OAuth tokens.
 * Shared by all Google Workspace app integrations.
 */
export const exchangeGoogleCode = async ({
  code,
  clientId,
  clientSecret,
  redirectUri,
}: OAuthExchangeCodeParams): Promise<OAuthExchangeResult> => {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

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

  // Google returns scopes space-separated (not comma like GitHub)
  const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

  // Fetch user info for metadata
  let metadata: Record<string, unknown> | undefined;
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (userRes.ok) {
    const user = (await userRes.json()) as {
      email?: string;
      name?: string;
      picture?: string;
    };
    metadata = {
      username: user.email,
      name: user.name,
      avatarUrl: user.picture,
    };
  }

  return { credentials, scopes, metadata };
};

/** Standard BYOC config fields for Google OAuth apps. */
export const googleConfigFields: OAuthConfigField[] = [
  {
    name: "clientId",
    label: "Client ID",
    placeholder: "123...apps.googleusercontent.com",
  },
  {
    name: "clientSecret",
    label: "Client Secret",
    placeholder: "GOCSPX-...",
    secret: true,
  },
];

/** envDefaults for apps that use the shared platform Google credentials. */
export const googleEnvDefaults = {
  clientId: "GOOGLE_CLIENT_ID",
  clientSecret: "GOOGLE_CLIENT_SECRET",
} as const;
