import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
  OAuthConfigField,
} from "../types";
import { completeCodeExchange } from "./code-exchange";

/**
 * Build a Google OAuth 2.0 authorization URL.
 * Shared by all Google Workspace app integrations.
 */
export const buildGoogleAuthUrl = ({
  appCredentials,
  redirectUri,
  scopes,
  state,
}: OAuthBuildAuthUrlParams): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", appCredentials.clientId!);
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
  appCredentials,
  callbackParams,
  redirectUri,
}: OAuthExchangeCodeParams): Promise<OAuthExchangeResult> => {
  if (callbackParams.error) {
    throw new Error(
      `Google authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
    );
  }

  if (!callbackParams.code) {
    throw new Error("Google callback missing authorization code");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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
      `Google token exchange failed: ${tokenRes.status} ${tokenRes.statusText} (${errorBody})`,
    );
  }

  return completeCodeExchange(
    tokenRes,
    "https://www.googleapis.com/oauth2/v2/userinfo",
    (user: { email?: string; name?: string; picture?: string }) => ({
      username: user.email,
      name: user.name,
      avatarUrl: user.picture,
    }),
  );
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
