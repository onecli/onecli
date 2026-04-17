import type {
  OAuthBuildAuthUrlParams,
  OAuthExchangeCodeParams,
  OAuthExchangeResult,
} from "./types";

export interface GithubOAuthConfig {
  baseUrl: string;
  apiBase: string;
}

export const buildGithubAuthUrl = (
  cfg: GithubOAuthConfig,
  params: OAuthBuildAuthUrlParams,
): string => {
  const url = new URL(`${cfg.baseUrl}/login/oauth/authorize`);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
};

export const exchangeGithubCode = async (
  cfg: GithubOAuthConfig,
  params: OAuthExchangeCodeParams,
): Promise<OAuthExchangeResult> => {
  const tokenRes = await fetch(`${cfg.baseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(
      `GitHub token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
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

  const credentials: Record<string, unknown> = {
    access_token: tokenData.access_token,
    token_type: tokenData.token_type,
  };
  const scopes = tokenData.scope?.split(",").filter(Boolean) ?? [];

  let metadata: Record<string, unknown> | undefined;
  const userRes = await fetch(`${cfg.apiBase}/user`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (userRes.ok) {
    const user = (await userRes.json()) as {
      login?: string;
      name?: string;
      avatar_url?: string;
    };
    metadata = {
      username: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
    };
  }

  return { credentials, scopes, metadata };
};
