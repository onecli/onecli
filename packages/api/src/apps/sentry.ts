import type { AppDefinition } from "./types";

export const sentry: AppDefinition = {
  id: "sentry",
  name: "Sentry",
  icon: "/icons/sentry.svg",
  darkIcon: "/icons/sentry-light.svg",
  description: "Error tracking, performance monitoring, and issue management.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "org:read",
      "project:read",
      "project:releases",
      "event:read",
      "event:write",
      "team:read",
      "member:read",
    ],
    permissions: [
      {
        scope: "org:read",
        name: "Organization",
        description: "Read organization data and settings",
        access: "read",
      },
      {
        scope: "project:read",
        name: "Projects",
        description: "Read project info and settings",
        access: "read",
      },
      {
        scope: "project:releases",
        name: "Releases",
        description: "Manage releases, source maps, and deploys",
        access: "write",
      },
      {
        scope: "event:read",
        name: "Events & Issues",
        description: "Read errors, issues, and performance events",
        access: "read",
      },
      {
        scope: "event:write",
        name: "Manage Issues",
        description: "Update, resolve, and archive issues",
        access: "write",
      },
      {
        scope: "team:read",
        name: "Teams",
        description: "Read team membership and settings",
        access: "read",
      },
      {
        scope: "member:read",
        name: "Members",
        description: "Read organization member info",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Sentry OAuth client ID not configured");
      }
      const url = new URL("https://sentry.io/oauth/authorize/");
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
          `Sentry authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("Sentry callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Sentry OAuth credentials not configured");
      }

      const tokenRes = await fetch("https://sentry.io/oauth/token/", {
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
        const errorBody = await tokenRes.text();
        throw new Error(
          `Sentry token exchange failed: ${tokenRes.status} ${tokenRes.statusText} (${errorBody})`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        expires_at?: string;
        token_type?: string;
        scope?: string;
        user?: { id?: string; name?: string; email?: string };
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
        : tokenData.expires_at
          ? Math.floor(new Date(tokenData.expires_at).getTime() / 1000)
          : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      const scopes = tokenData.scope?.split(/\s+/).filter(Boolean) ?? [];

      const metadata: Record<string, unknown> = {};

      if (tokenData.user) {
        metadata.username = tokenData.user.email;
        metadata.name = tokenData.user.name;
      } else {
        try {
          const userRes = await fetch("https://sentry.io/api/0/users/me/", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (userRes.ok) {
            const user = (await userRes.json()) as {
              id?: string;
              name?: string;
              email?: string;
              avatarUrl?: string;
            };
            metadata.username = user.email;
            metadata.name = user.name;
            metadata.avatarUrl = user.avatarUrl;
          }
        } catch {
          // User info fetch failed — continue without metadata
        }
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Create an OAuth application in Sentry's Developer Settings.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "your-sentry-client-id",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-sentry-client-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "SENTRY_CLIENT_ID",
      clientSecret: "SENTRY_CLIENT_SECRET",
    },
  },
};
