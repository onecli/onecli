import type { AppDefinition } from "./types";

export const gitlab: AppDefinition = {
  id: "gitlab",
  name: "GitLab",
  icon: "/icons/gitlab.svg",
  darkIcon: "/icons/gitlab-light.svg",
  description: "Repositories, issues, merge requests, and CI/CD pipelines.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "api",
      "read_user",
      "read_repository",
      "write_repository",
      "read_registry",
    ],
    permissions: [
      {
        scope: "api",
        name: "Full API access",
        description: "All API operations including repositories and CI/CD",
        access: "write",
      },
      {
        scope: "read_user",
        name: "Profile",
        description: "Email, name, and avatar",
        access: "read",
      },
      {
        scope: "read_repository",
        name: "Read repositories",
        description: "Clone and read repository contents",
        access: "read",
      },
      {
        scope: "write_repository",
        name: "Write repositories",
        description: "Push, create branches, and write repository contents",
        access: "write",
      },
      {
        scope: "read_registry",
        name: "Container Registry",
        description: "Pull images from the container registry",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      const url = new URL("https://gitlab.com/oauth/authorize");
      url.searchParams.set("client_id", appCredentials.clientId!);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      const tokenRes = await fetch("https://gitlab.com/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: appCredentials.clientId!,
          client_secret: appCredentials.clientSecret!,
          code: callbackParams.code!,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        throw new Error(
          `GitLab token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        token_type?: string;
        scope?: string;
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
        ...(tokenData.refresh_token && {
          refresh_token: tokenData.refresh_token,
        }),
      };
      const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

      let metadata: Record<string, unknown> | undefined;
      const userRes = await fetch("https://gitlab.com/api/v4/user", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (userRes.ok) {
        const user = (await userRes.json()) as {
          username?: string;
          name?: string;
          avatar_url?: string;
        };
        metadata = {
          username: user.username,
          name: user.name,
          avatarUrl: user.avatar_url,
        };
      }

      return { credentials, scopes, metadata };
    },
  },
  available: true,
  configurable: {
    hint: "Create an OAuth application under GitLab User Settings > Applications.",
    fields: [
      {
        name: "clientId",
        label: "Application ID",
        placeholder: "abc123...",
      },
      {
        name: "clientSecret",
        label: "Secret",
        placeholder: "gloas-...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "GITLAB_CLIENT_ID",
      clientSecret: "GITLAB_CLIENT_SECRET",
    },
  },
};
