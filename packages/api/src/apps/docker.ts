import type { AppDefinition, OAuthExchangeResult } from "./types";

/**
 * Docker Hub's "Create access token" endpoint: a username and a personal
 * access token (or password) in, a short-lived bearer JWT out. Replaces the
 * deprecated `/v2/users/login`; the gateway re-mints through the same one.
 */
const DOCKER_HUB_TOKEN_URL = "https://hub.docker.com/v2/auth/token";

const parseJwtExp = (token: string): number | null => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp : null;
  } catch {
    return null;
  }
};

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { username, apiToken } = fields;

  if (!username || !apiToken) {
    throw new Error("Username and Personal Access Token are required");
  }

  const res = await fetch(DOCKER_HUB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: username, secret: apiToken }),
  });

  if (!res.ok) {
    // The one documented refusal is a 401 (`{"message":"unauthorized"}`),
    // which says nothing more useful than the status: name the fix instead.
    throw new Error(
      res.status === 401
        ? "Docker Hub rejected this username and Personal Access Token. Check both, and that the token has not been revoked."
        : `Docker Hub token request failed (${res.status})`,
    );
  }

  const data = (await res.json()) as { access_token?: string };

  if (!data.access_token) {
    throw new Error("Docker Hub did not return an access token");
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtExp = parseJwtExp(data.access_token);
  const expiresAt = jwtExp ? jwtExp - 60 : now + 3600;

  const credentials: Record<string, unknown> = {
    access_token: data.access_token,
    username,
    password: apiToken,
    expires_at: expiresAt,
    type: "docker_hub",
  };

  const metadata: Record<string, unknown> = {
    username,
    name: username,
  };

  return { credentials, scopes: [], metadata };
};

export const docker: AppDefinition = {
  id: "docker",
  setupGuideUrl: "https://onecli.sh/docs/integrations/docker",
  name: "Docker Hub",
  apiDocsUrl: "https://docs.docker.com/reference/api/hub/latest/",
  icon: "/icons/docker.svg",
  darkIcon: "/icons/docker-light.svg",
  description:
    "Manage Docker Hub repositories, images, tags, and organizations.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "username",
        label: "Username",
        description: "Your Docker Hub username",
        placeholder: "my-docker-user",
        secret: false,
      },
      {
        name: "apiToken",
        label: "Personal Access Token",
        description:
          "Your Docker Hub Personal Access Token. Create one at app.docker.com under Account Settings → Personal access tokens",
        placeholder: "dckr_pat_...",
        secret: true,
      },
    ],
    exchangeCredentials,
  },
  labelHint: 'e.g. "staging", "my-org"',
};
