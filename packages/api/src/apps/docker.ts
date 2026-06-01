import type { AppDefinition, OAuthExchangeResult } from "./types";

const DOCKER_HUB_LOGIN_URL = "https://hub.docker.com/v2/users/login";

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

  const res = await fetch(DOCKER_HUB_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: apiToken }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(body?.detail ?? `Docker Hub login failed (${res.status})`);
  }

  const data = (await res.json()) as { token: string };

  if (!data.token) {
    throw new Error("Docker Hub login did not return a token");
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtExp = parseJwtExp(data.token);
  const expiresAt = jwtExp ? jwtExp - 60 : now + 3600;

  const credentials: Record<string, unknown> = {
    access_token: data.token,
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
  name: "Docker Hub",
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
  available: true,
};
