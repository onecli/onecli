import type { AppDefinition, OAuthExchangeResult } from "./types";

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { refreshToken, clientId, clientSecret, quotaProjectId } = fields;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: refreshToken!,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    const body = (await tokenRes.json().catch(() => ({}))) as {
      error_description?: string;
    };
    throw new Error(
      body.error_description ?? `Token refresh failed: ${tokenRes.status}`,
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
      tokenData.error_description ?? "Failed to obtain access token",
    );
  }

  const expiresAt = tokenData.expires_in
    ? Math.floor(Date.now() / 1000) + tokenData.expires_in
    : undefined;

  const credentials: Record<string, unknown> = {
    access_token: tokenData.access_token,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_at: expiresAt,
  };

  let metadata: Record<string, unknown> = { quotaProjectId };

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
      ...metadata,
      username: user.email,
      name: user.name,
      avatarUrl: user.picture,
    };
  }

  return {
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    metadata,
  };
};

export const vertexAi: AppDefinition = {
  id: "vertex-ai",
  name: "Vertex AI",
  icon: "/icons/vertex-ai.svg",
  description: "Access Vertex AI models on Google Cloud.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "refreshToken",
        label: "Refresh Token",
        description:
          "From ~/.config/gcloud/application_default_credentials.json",
        placeholder: "1//0e...",
        secret: true,
      },
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
      {
        name: "quotaProjectId",
        label: "GCP Project ID",
        description: "Google Cloud project ID for quota and billing",
        placeholder: "my-gcp-project",
      },
    ],
    exchangeCredentials,
    fileImport: {
      label: "Import application_default_credentials.json",
      accept: ".json,application/json",
      keyMap: {
        refresh_token: "refreshToken",
        client_id: "clientId",
        client_secret: "clientSecret",
        quota_project_id: "quotaProjectId",
      },
    },
  },
  available: true,
  credentialStubs: [
    {
      path: "~/.config/gcloud/application_default_credentials.json",
      content: {
        account: "onecli-managed",
        client_id: "onecli-managed",
        client_secret: "onecli-managed",
        quota_project_id: "onecli-managed",
        refresh_token: "onecli-managed",
        type: "authorized_user",
        universe_domain: "googleapis.com",
      },
    },
  ],
};
