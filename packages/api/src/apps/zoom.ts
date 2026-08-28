import type { AppDefinition } from "./types";

export const zoom: AppDefinition = {
  id: "zoom",
  name: "Zoom",
  icon: "/icons/zoom.svg",
  description: "Meetings, webinars, and cloud recordings.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "user:read:user",
      "meeting:read:list_meetings",
      "meeting:read:meeting",
      "meeting:write:meeting",
      "meeting:update:meeting",
      "meeting:delete:meeting",
      "cloud_recording:read:list_user_recordings",
      "cloud_recording:read:list_recording_files",
    ],
    permissions: [
      {
        scope: "user:read:user",
        name: "Profile",
        description: "Name, email, and account info",
        access: "read",
      },
      {
        scope: "meeting:read:list_meetings",
        name: "Meetings",
        description: "List and view meeting details",
        access: "read",
      },
      {
        scope: "meeting:write:meeting",
        name: "Meetings",
        description: "Create, update, and delete meetings",
        access: "write",
      },
      {
        scope: "cloud_recording:read:list_user_recordings",
        name: "Recordings",
        description: "List and access cloud recordings",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Zoom OAuth client ID not configured");
      }
      const url = new URL("https://zoom.us/oauth/authorize");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `Zoom authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("Zoom callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Zoom OAuth credentials not configured");
      }

      const basicAuth = Buffer.from(
        `${appCredentials.clientId}:${appCredentials.clientSecret}`,
      ).toString("base64");

      const tokenRes = await fetch("https://zoom.us/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callbackParams.code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        throw new Error(
          `Zoom token exchange failed: ${tokenRes.status} ${tokenRes.statusText} (${errorBody})`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
        error?: string;
        reason?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(
          tokenData.reason ??
            tokenData.error ??
            "Failed to exchange code for token",
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
        const userRes = await fetch("https://api.zoom.us/v2/users/me", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (userRes.ok) {
          const user = (await userRes.json()) as {
            email?: string;
            first_name?: string;
            last_name?: string;
            display_name?: string;
            pic_url?: string;
          };
          const name =
            user.display_name ??
            ([user.first_name, user.last_name].filter(Boolean).join(" ") ||
              undefined);
          metadata.username = user.email;
          metadata.email = user.email;
          metadata.name = name;
          metadata.avatarUrl = user.pic_url;
        }
      } catch {
        // Userinfo fetch failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Create a General App at marketplace.zoom.us under Develop > Build App.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "yWpUiJ...",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "0YqEFA...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "ZOOM_CLIENT_ID",
      clientSecret: "ZOOM_CLIENT_SECRET",
    },
  },
};
