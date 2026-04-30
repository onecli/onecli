import { createSign } from "crypto";
import type { AppDefinition, OAuthExchangeResult } from "./types";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const signJwt = (privateKey: string, clientEmail: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    sub: clientEmail,
    aud: GOOGLE_TOKEN_URL,
    scope: CLOUD_PLATFORM_SCOPE,
    iat: now,
    exp: now + 3600,
  };

  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Claims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${b64Header}.${b64Claims}`;

  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(privateKey, "base64url");

  return `${unsigned}.${signature}`;
};

const exchangeServiceAccount = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { privateKey, clientEmail, projectId } = fields;
  if (!privateKey || !clientEmail) {
    throw new Error("Service account email and private key are required");
  }
  if (!projectId) {
    throw new Error("GCP Project ID is required");
  }

  const jwt = signJwt(privateKey, clientEmail);

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const body = (await tokenRes.json().catch(() => ({}))) as {
      error_description?: string;
    };
    throw new Error(
      body.error_description ??
        `Service account token exchange failed: ${tokenRes.status}`,
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

  return {
    credentials: {
      type: "service_account",
      access_token: tokenData.access_token,
      private_key: privateKey,
      client_email: clientEmail,
      project_id: projectId,
      expires_at: expiresAt,
    },
    scopes: [CLOUD_PLATFORM_SCOPE],
    metadata: {
      quotaProjectId: projectId,
      username: clientEmail,
    },
  };
};

const exchangeAuthorizedUser = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { refreshToken, clientId, clientSecret, quotaProjectId } = fields;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("Refresh token, client ID, and client secret are required");
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
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
    scopes: [CLOUD_PLATFORM_SCOPE],
    metadata,
  };
};

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  if (fields.privateKey && fields.clientEmail) {
    return exchangeServiceAccount(fields);
  }
  return exchangeAuthorizedUser(fields);
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
        name: "clientEmail",
        label: "Service Account Email",
        placeholder: "sa@project.iam.gserviceaccount.com",
        group: "service_account",
      },
      {
        name: "projectId",
        label: "GCP Project ID",
        description: "Google Cloud project ID for quota and billing",
        placeholder: "my-gcp-project",
        group: "service_account",
      },
      {
        name: "privateKey",
        label: "Private Key",
        description: "RSA private key from service account JSON",
        placeholder: "-----BEGIN PRIVATE KEY-----...",
        secret: true,
        group: "service_account",
      },
      {
        name: "refreshToken",
        label: "Refresh Token",
        description:
          "From ~/.config/gcloud/application_default_credentials.json",
        placeholder: "1//0e...",
        secret: true,
        group: "authorized_user",
      },
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "123...apps.googleusercontent.com",
        group: "authorized_user",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "GOCSPX-...",
        secret: true,
        group: "authorized_user",
      },
      {
        name: "quotaProjectId",
        label: "GCP Project ID",
        description: "Google Cloud project ID for quota and billing",
        placeholder: "my-gcp-project",
        group: "authorized_user",
      },
    ],
    exchangeCredentials,
    fileImport: {
      label: "Import credentials JSON",
      accept: ".json,application/json",
      keyMap: {
        private_key: "privateKey",
        client_email: "clientEmail",
        project_id: "projectId",
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
