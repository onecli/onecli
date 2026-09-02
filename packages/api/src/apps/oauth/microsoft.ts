import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
  OAuthConfigField,
} from "../types";

export const buildMicrosoftAuthUrl = ({
  appCredentials,
  redirectUri,
  scopes,
  state,
}: OAuthBuildAuthUrlParams): string => {
  const url = new URL(
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  );
  url.searchParams.set("client_id", appCredentials.clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("domain_hint", "organizations");
  return url.toString();
};

export const exchangeMicrosoftCode = async ({
  appCredentials,
  callbackParams,
  redirectUri,
}: OAuthExchangeCodeParams): Promise<OAuthExchangeResult> => {
  if (callbackParams.error) {
    const adminConsentErrors = [
      "access_denied",
      "interaction_required",
      "consent_required",
    ];
    if (adminConsentErrors.includes(callbackParams.error)) {
      throw new Error(
        "Your organization requires admin approval for this app. Please ask your IT administrator to approve OneCLI, then try again.",
      );
    }
    throw new Error(
      `Microsoft authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
    );
  }

  if (!callbackParams.code) {
    throw new Error("Microsoft callback missing authorization code");
  }

  const tokenRes = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: callbackParams.code!,
        client_id: appCredentials.clientId!,
        client_secret: appCredentials.clientSecret!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    },
  );

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    throw new Error(
      `Microsoft token exchange failed: ${tokenRes.status} ${tokenRes.statusText} (${errorBody})`,
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
  const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (userRes.ok) {
    const user = (await userRes.json()) as {
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
    };
    metadata = {
      username: user.mail ?? user.userPrincipalName,
      name: user.displayName,
    };
  }

  return { credentials, scopes, metadata };
};

export const microsoftConfigFields: OAuthConfigField[] = [
  {
    name: "clientId",
    label: "Client ID",
    placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  },
  {
    name: "clientSecret",
    label: "Client Secret",
    placeholder: "Azure AD client secret",
    secret: true,
  },
];

export const microsoftEnvDefaults = {
  clientId: "MICROSOFT_CLIENT_ID",
  clientSecret: "MICROSOFT_CLIENT_SECRET",
} as const;
