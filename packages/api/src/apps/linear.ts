import type { AppDefinition } from "./types";

export const linear: AppDefinition = {
  id: "linear",
  name: "Linear",
  icon: "/icons/linear.svg",
  darkIcon: "/icons/linear-light.svg",
  description: "Issues, projects, teams, and product development workflows.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: ["read", "write", "issues:create", "comments:create"],
    permissions: [
      {
        scope: "read",
        name: "Read access",
        description: "View issues, projects, teams, and workspace data",
        access: "read",
      },
      {
        scope: "write",
        name: "Write access",
        description: "Update issues, projects, and workspace settings",
        access: "write",
      },
      {
        scope: "issues:create",
        name: "Create issues",
        description: "Create new issues and attachments",
        access: "write",
      },
      {
        scope: "comments:create",
        name: "Create comments",
        description: "Add comments to issues",
        access: "write",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      const url = new URL("https://linear.app/oauth/authorize");
      url.searchParams.set("client_id", appCredentials.clientId!);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      // Linear uses comma-separated scopes (non-standard)
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      const tokenRes = await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: appCredentials.clientId!,
          client_secret: appCredentials.clientSecret!,
          code: callbackParams.code!,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        throw new Error(
          `Linear token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
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

      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      // Linear returns space-separated scopes in the token response
      const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

      let metadata: Record<string, unknown> | undefined;
      const userRes = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ viewer { id name email } }" }),
      });

      if (userRes.ok) {
        const body = (await userRes.json()) as {
          data?: { viewer?: { id?: string; name?: string; email?: string } };
        };
        if (body.data?.viewer) {
          metadata = {
            username: body.data.viewer.email,
            name: body.data.viewer.name,
          };
        }
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Create an OAuth application in Linear Settings > API.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "your-linear-client-id",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-linear-client-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "LINEAR_CLIENT_ID",
      clientSecret: "LINEAR_CLIENT_SECRET",
    },
  },
};
