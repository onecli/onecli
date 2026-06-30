import type { AppDefinition } from "./types";

export const dropbox: AppDefinition = {
  id: "dropbox",
  name: "Dropbox",
  icon: "/icons/dropbox.svg",
  description: "Cloud file storage, sharing, and collaboration.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
      "sharing.read",
      "sharing.write",
    ],
    permissions: [
      {
        scope: "account_info.read",
        name: "Account info",
        description: "View your name, email, and profile photo",
        access: "read",
      },
      {
        scope: "files.metadata.read",
        name: "File metadata",
        description: "List files and folders, view names and sizes",
        access: "read",
      },
      {
        scope: "files.content.read",
        name: "Download files",
        description: "Read and download file content",
        access: "read",
      },
      {
        scope: "files.content.write",
        name: "Edit files",
        description:
          "Upload, update, move, rename, delete, and create files and folders",
        access: "write",
      },
      {
        scope: "sharing.read",
        name: "Sharing info",
        description: "View shared folders and links",
        access: "read",
      },
      {
        scope: "sharing.write",
        name: "Manage sharing",
        description: "Create shared links and share folders",
        access: "write",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Dropbox OAuth client ID not configured");
      }
      const url = new URL("https://www.dropbox.com/oauth2/authorize");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("token_access_type", "offline");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `Dropbox authorization error: ${callbackParams.error} — ${callbackParams.error_description ?? "no description"}`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("Dropbox callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Dropbox OAuth credentials not configured");
      }

      const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callbackParams.code,
          client_id: appCredentials.clientId,
          client_secret: appCredentials.clientSecret,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        throw new Error(
          `Dropbox token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
        uid?: string;
        account_id?: string;
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

      const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

      const metadata: Record<string, unknown> = {};
      try {
        const userRes = await fetch(
          "https://api.dropboxapi.com/2/users/get_current_account",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              "Content-Type": "application/json",
            },
            body: "null",
          },
        );

        if (userRes.ok) {
          const user = (await userRes.json()) as {
            email?: string;
            name?: { display_name?: string };
            profile_photo_url?: string;
          };
          metadata.username = user.email;
          metadata.name = user.name?.display_name;
          metadata.avatarUrl = user.profile_photo_url;
        }
      } catch {
        // Account info fetch failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  available: true,
  configurable: {
    fields: [
      {
        name: "clientId",
        label: "App Key",
        placeholder: "your-dropbox-app-key",
      },
      {
        name: "clientSecret",
        label: "App Secret",
        placeholder: "your-dropbox-app-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "DROPBOX_CLIENT_ID",
      clientSecret: "DROPBOX_CLIENT_SECRET",
    },
  },
};
