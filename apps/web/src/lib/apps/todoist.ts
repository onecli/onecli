import type { AppDefinition } from "./types";

export const todoist: AppDefinition = {
  id: "todoist",
  name: "Todoist",
  icon: "/icons/todoist.svg",
  description: "Tasks, projects, and productivity tracking.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: ["data:read_write", "data:delete"],
    permissions: [
      {
        scope: "data:read_write",
        name: "Tasks & projects",
        description: "Read, create, and manage tasks, projects, and labels",
        access: "write",
      },
      {
        scope: "data:delete",
        name: "Delete",
        description: "Permanently delete tasks and projects",
        access: "write",
      },
    ],
    buildAuthUrl: ({ clientId, redirectUri, scopes, state }) => {
      const url = new URL("https://app.todoist.com/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      // Todoist uses comma-separated scopes (non-standard)
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ code, clientId, clientSecret }) => {
      const tokenRes = await fetch(
        "https://api.todoist.com/oauth/access_token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        },
      );

      if (!tokenRes.ok) {
        throw new Error(
          `Todoist token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
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

      const scopes = tokenData.scope?.split(",").filter(Boolean) ?? [];

      let metadata: Record<string, unknown> | undefined;
      const userRes = await fetch("https://api.todoist.com/api/v1/sync", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          sync_token: "*",
          resource_types: '["user"]',
        }),
      });

      if (userRes.ok) {
        const sync = (await userRes.json()) as {
          user?: {
            email?: string;
            full_name?: string;
            avatar_medium?: string;
          };
        };
        if (sync.user) {
          metadata = {
            username: sync.user.email,
            name: sync.user.full_name,
            avatarUrl: sync.user.avatar_medium,
          };
        }
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
        placeholder: "your-todoist-app-client-id",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-todoist-app-client-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "TODOIST_CLIENT_ID",
      clientSecret: "TODOIST_CLIENT_SECRET",
    },
  },
};
