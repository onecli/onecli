import type { AppDefinition } from "./types";

export const linkedin: AppDefinition = {
  id: "linkedin",
  name: "LinkedIn",
  icon: "/icons/linkedin.svg",
  description: "Profile, posts, and social engagement.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: ["openid", "profile", "email", "w_member_social"],
    permissions: [
      {
        scope: "openid",
        name: "Identity",
        description: "Verify your LinkedIn identity",
        access: "read",
      },
      {
        scope: "profile",
        name: "Profile",
        description: "Name, photo, and headline",
        access: "read",
      },
      {
        scope: "email",
        name: "Email",
        description: "Primary email address",
        access: "read",
      },
      {
        scope: "w_member_social",
        name: "Posts & Reactions",
        description:
          "Create, modify, and delete posts, comments, and reactions",
        access: "write",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("LinkedIn OAuth client ID not configured");
      }
      const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `LinkedIn authorization error: ${callbackParams.error} — ${callbackParams.error_description ?? "no description"}`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("LinkedIn callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("LinkedIn OAuth credentials not configured");
      }

      const tokenRes = await fetch(
        "https://www.linkedin.com/oauth/v2/accessToken",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: callbackParams.code,
            client_id: appCredentials.clientId,
            client_secret: appCredentials.clientSecret,
            redirect_uri: redirectUri,
          }),
        },
      );

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        throw new Error(
          `LinkedIn token exchange failed: ${tokenRes.status} ${tokenRes.statusText} — ${errorBody}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        refresh_token_expires_in?: number;
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

      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      if (tokenData.refresh_token) {
        credentials.refresh_token = tokenData.refresh_token;
        if (tokenData.refresh_token_expires_in) {
          credentials.refresh_token_expires_at =
            Math.floor(Date.now() / 1000) + tokenData.refresh_token_expires_in;
        }
      }

      const scopes = tokenData.scope?.split(/[, ]+/).filter(Boolean) ?? [];

      const metadata: Record<string, unknown> = {};
      try {
        const userRes = await fetch("https://api.linkedin.com/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (userRes.ok) {
          const user = (await userRes.json()) as {
            sub?: string;
            name?: string;
            email?: string;
            picture?: string;
          };
          metadata.username = user.email;
          metadata.name = user.name;
          metadata.avatarUrl = user.picture;
          metadata.linkedinId = user.sub;
        }
      } catch {
        // Userinfo fetch failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  available: true,
  configurable: {
    hint: "Create an app in the LinkedIn Developer Portal.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "77...",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "WPL_AP1...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "LINKEDIN_CLIENT_ID",
      clientSecret: "LINKEDIN_CLIENT_SECRET",
    },
  },
};
