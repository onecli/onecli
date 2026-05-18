import type { AppDefinition } from "./types";

export const supabase: AppDefinition = {
  id: "supabase",
  name: "Supabase",
  icon: "/icons/supabase.svg",
  description: "Projects, databases, edge functions, and storage.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [],
    permissions: [
      {
        scope: "projects:read",
        name: "Projects",
        description: "View projects, settings, and network config",
        access: "read",
      },
      {
        scope: "database:read",
        name: "Database",
        description: "Read database config, pooler, and SSL settings",
        access: "read",
      },
      {
        scope: "database:write",
        name: "Database write",
        description: "Run SQL queries, manage webhooks, and backups",
        access: "write",
      },
      {
        scope: "auth:read",
        name: "Auth",
        description: "View auth config and SSO providers",
        access: "read",
      },
      {
        scope: "organizations:read",
        name: "Organizations",
        description: "View organization metadata and members",
        access: "read",
      },
      {
        scope: "storage:read",
        name: "Storage",
        description: "List and view storage buckets",
        access: "read",
      },
      {
        scope: "edge_functions:read",
        name: "Edge Functions",
        description: "List and view edge functions",
        access: "read",
      },
      {
        scope: "secrets:read",
        name: "Secrets",
        description: "View API keys and project secrets",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Supabase OAuth client ID not configured");
      }
      const url = new URL("https://api.supabase.com/v1/oauth/authorize");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (!callbackParams.code) {
        throw new Error("Supabase callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Supabase OAuth credentials not configured");
      }

      const basicAuth = Buffer.from(
        `${appCredentials.clientId}:${appCredentials.clientSecret}`,
      ).toString("base64");

      const tokenRes = await fetch("https://api.supabase.com/v1/oauth/token", {
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
        throw new Error(
          `Supabase token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
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
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      const scopes = [
        "projects:read",
        "database:read",
        "database:write",
        "auth:read",
        "organizations:read",
        "storage:read",
        "edge_functions:read",
        "secrets:read",
      ];

      const metadata: Record<string, unknown> = {};
      try {
        const orgsRes = await fetch(
          "https://api.supabase.com/v1/organizations",
          {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          },
        );

        if (orgsRes.ok) {
          const orgs = (await orgsRes.json()) as {
            id?: string;
            name?: string;
          }[];
          const first = orgs[0];
          if (first) {
            metadata.username = first.name;
            metadata.name = first.name;
            metadata.organizationId = first.id;
          }
        }
      } catch {
        // Org fetch failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  available: true,
  configurable: {
    hint: "Create an OAuth app in your Supabase organization settings.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "sba_...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "SUPABASE_CLIENT_ID",
      clientSecret: "SUPABASE_CLIENT_SECRET",
    },
  },
};
