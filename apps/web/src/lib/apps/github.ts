import type { AppDefinition } from "./types";

export const github: AppDefinition = {
  id: "github",
  name: "GitHub",
  icon: "/icons/github.svg",
  darkIcon: "/icons/github-light.svg",
  description: "Repositories, issues, pull requests, and GitHub Actions.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "repo",
      "user",
      "gist",
      "notifications",
      "project",
      "codespace",
      "workflow",
    ],
    buildAuthUrl: ({ clientId, redirectUri, scopes, state }) => {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "select_account");
      return url.toString();
    },
    exchangeCode: async ({ code, clientId, clientSecret, redirectUri }) => {
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        },
      );

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
      const userRes = await fetch("https://api.github.com/user", {
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
    },
  },
  available: true,
  configurable: {
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "Iv1.abc123...",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "secret_...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "GITHUB_CLIENT_ID",
      clientSecret: "GITHUB_CLIENT_SECRET",
    },
  },
};
