import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
  OAuthConfigField,
} from "../types";
import { completeCodeExchange } from "./code-exchange";

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

  return completeCodeExchange(
    tokenRes,
    "https://api.atlassian.com/me",
    (user: { email?: string; name?: string; picture?: string }) => ({
      username: user.email,
      name: user.name,
      avatarUrl: user.picture,
    }),
  );
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
