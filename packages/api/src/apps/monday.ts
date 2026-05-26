import type { AppDefinition } from "./types";

export const monday: AppDefinition = {
  id: "monday",
  name: "monday.com",
  icon: "/icons/monday.svg",
  description: "Boards, items, docs, and workspace management.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "me:read",
      "account:read",
      "boards:read",
      "boards:write",
      "docs:read",
      "docs:write",
      "updates:read",
      "updates:write",
      "workspaces:read",
      "workspaces:write",
      "users:read",
      "teams:read",
      "tags:read",
      "webhooks:write",
      "notifications:write",
      "assets:read",
    ],
    permissions: [
      {
        scope: "me:read",
        name: "Profile",
        description: "Your name, email, and avatar",
        access: "read",
      },
      {
        scope: "account:read",
        name: "Account",
        description: "Account info and settings",
        access: "read",
      },
      {
        scope: "boards:read",
        name: "Boards",
        description: "View boards, items, and columns",
        access: "read",
      },
      {
        scope: "boards:write",
        name: "Boards",
        description: "Create and modify boards, items, and columns",
        access: "write",
      },
      {
        scope: "docs:read",
        name: "Docs",
        description: "View documents",
        access: "read",
      },
      {
        scope: "docs:write",
        name: "Docs",
        description: "Create and edit documents",
        access: "write",
      },
      {
        scope: "updates:read",
        name: "Updates",
        description: "View comments and updates",
        access: "read",
      },
      {
        scope: "updates:write",
        name: "Updates",
        description: "Post comments and updates",
        access: "write",
      },
      {
        scope: "workspaces:read",
        name: "Workspaces",
        description: "View workspaces",
        access: "read",
      },
      {
        scope: "workspaces:write",
        name: "Workspaces",
        description: "Create and modify workspaces",
        access: "write",
      },
      {
        scope: "users:read",
        name: "Users",
        description: "View user profiles",
        access: "read",
      },
      {
        scope: "teams:read",
        name: "Teams",
        description: "View team info",
        access: "read",
      },
      {
        scope: "tags:read",
        name: "Tags",
        description: "View account tags",
        access: "read",
      },
      {
        scope: "assets:read",
        name: "Assets",
        description: "View file assets",
        access: "read",
      },
      {
        scope: "webhooks:write",
        name: "Webhooks",
        description: "Manage webhook configurations",
        access: "write",
      },
      {
        scope: "notifications:write",
        name: "Notifications",
        description: "Send user notifications",
        access: "write",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Monday.com OAuth client ID not configured");
      }
      const url = new URL("https://auth.monday.com/oauth2/authorize");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `Monday.com authorization error: ${callbackParams.error} — ${callbackParams.error_description ?? "no description"}`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("Monday.com callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Monday.com OAuth credentials not configured");
      }

      const tokenRes = await fetch("https://auth.monday.com/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: appCredentials.clientId,
          client_secret: appCredentials.clientSecret,
          code: callbackParams.code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        throw new Error(
          `Monday.com token exchange failed: ${tokenRes.status} ${tokenRes.statusText} — ${errorBody}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
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
        token_type: tokenData.token_type ?? "Bearer",
      };

      const scopes = tokenData.scope?.split(/\s+/).filter(Boolean) ?? [];

      const metadata: Record<string, unknown> = {};
      try {
        const userRes = await fetch("https://api.monday.com/v2", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenData.access_token}`,
          },
          body: JSON.stringify({
            query:
              "{ me { id name email photo_original account { id name } } }",
          }),
        });

        if (userRes.ok) {
          const body = (await userRes.json()) as {
            data?: {
              me?: {
                id?: number;
                name?: string;
                email?: string;
                photo_original?: string;
                account?: { id?: number; name?: string };
              };
            };
          };
          const me = body.data?.me;
          if (me) {
            metadata.username = me.email;
            metadata.name = me.name;
            metadata.avatarUrl = me.photo_original;
            metadata.mondayUserId = me.id;
            if (me.account?.name) {
              metadata.accountName = me.account.name;
            }
          }
        }
      } catch {
        // User info fetch failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  available: true,
  configurable: {
    hint: "Create an app in the Monday.com Developer Center.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "32e8...",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "0ffb...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "MONDAY_CLIENT_ID",
      clientSecret: "MONDAY_CLIENT_SECRET",
    },
  },
};
