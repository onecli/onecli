import type { AppDefinition } from "./types";

export const googleDrive: AppDefinition = {
  id: "google-drive",
  name: "Google Drive",
  icon: "/icons/google-drive.svg",
  description: "Read, create, and manage files and folders.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/drive",
        name: "Drive",
        description: "Read, create, edit, and delete files and folders",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.email",
        name: "Email address",
        description: "View your email address",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.profile",
        name: "Profile",
        description: "Name and profile picture",
        access: "read",
      },
    ],
    buildAuthUrl: ({ clientId, redirectUri, scopes, state }) => {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      return url.toString();
    },
    exchangeCode: async ({ code, clientId, clientSecret, redirectUri }) => {
      // Google requires form-encoded body, not JSON
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
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

      // Store expires_at as unix timestamp for the gateway to check
      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      // Google returns scopes space-separated (not comma like GitHub)
      const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

      // Fetch user info for metadata
      let metadata: Record<string, unknown> | undefined;
      const userRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        },
      );

      if (userRes.ok) {
        const user = (await userRes.json()) as {
          email?: string;
          name?: string;
          picture?: string;
        };
        metadata = {
          username: user.email,
          name: user.name,
          avatarUrl: user.picture,
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
        placeholder: "123...apps.googleusercontent.com",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "GOCSPX-...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "GOOGLE_CLIENT_ID",
      clientSecret: "GOOGLE_CLIENT_SECRET",
    },
  },
};
