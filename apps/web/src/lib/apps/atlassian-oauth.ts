import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
  OAuthConfigField,
} from "./types";

export const buildAtlassianAuthUrl = ({
  appCredentials,
  redirectUri,
  scopes,
  state,
}: OAuthBuildAuthUrlParams): string => {
  const url = new URL("https://auth.atlassian.com/authorize");
  url.searchParams.set("client_id", appCredentials.clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

export const exchangeAtlassianCode = async ({
  appCredentials,
  callbackParams,
  redirectUri,
}: OAuthExchangeCodeParams): Promise<OAuthExchangeResult> => {
  const tokenRes = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: appCredentials.clientId!,
      client_secret: appCredentials.clientSecret!,
      code: callbackParams.code!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(
      `Atlassian token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
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

  const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

  let metadata: Record<string, unknown> | undefined;
  const userRes = await fetch("https://api.atlassian.com/me", {
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

export const atlassianConfigFields: OAuthConfigField[] = [
  {
    name: "clientId",
    label: "Client ID",
    placeholder: "your-atlassian-app-client-id",
  },
  {
    name: "clientSecret",
    label: "Client Secret",
    placeholder: "your-atlassian-app-client-secret",
    secret: true,
  },
];

export const atlassianEnvDefaults = {
  clientId: "ATLASSIAN_CLIENT_ID",
  clientSecret: "ATLASSIAN_CLIENT_SECRET",
} as const;
