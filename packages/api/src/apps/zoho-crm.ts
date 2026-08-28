import type { AppDefinition } from "./types";

const DEFAULT_SCOPES = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
  "ZohoCRM.users.READ",
  "ZohoCRM.org.READ",
];

export const zohoCrm: AppDefinition = {
  id: "zoho-crm",
  name: "Zoho CRM",
  icon: "/icons/zoho-crm.svg",
  description: "Leads, contacts, accounts, deals, and tasks in Zoho CRM.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: DEFAULT_SCOPES,
    permissions: [
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Leads",
        description: "View lead records and properties",
        access: "read",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Leads",
        description: "Create, update, and delete leads",
        access: "write",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Contacts",
        description: "View contact records and properties",
        access: "read",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Contacts",
        description: "Create, update, and delete contacts",
        access: "write",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Accounts",
        description: "View account records and properties",
        access: "read",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Accounts",
        description: "Create, update, and delete accounts",
        access: "write",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Deals",
        description: "View deal records and pipeline stages",
        access: "read",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Deals",
        description: "Create, update, and delete deals",
        access: "write",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Tasks",
        description: "View task records",
        access: "read",
      },
      {
        scope: "ZohoCRM.modules.ALL",
        name: "Tasks",
        description: "Create, update, and delete tasks",
        access: "write",
      },
      {
        scope: "ZohoCRM.settings.ALL",
        name: "Settings",
        description: "View CRM settings, fields, layouts, and roles",
        access: "read",
      },
      {
        scope: "ZohoCRM.settings.ALL",
        name: "Settings",
        description: "Modify CRM settings, fields, layouts, and roles",
        access: "write",
      },
      {
        scope: "ZohoCRM.users.READ",
        name: "Users",
        description: "View CRM users and their profiles",
        access: "read",
      },
      {
        scope: "ZohoCRM.org.READ",
        name: "Organization",
        description: "View organization details",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Zoho CRM OAuth client ID not configured");
      }
      const url = new URL("https://accounts.zoho.com/oauth/v2/auth");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `Zoho CRM authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("Zoho CRM callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Zoho CRM OAuth credentials not configured");
      }

      const accountsServer =
        (callbackParams["accounts-server"] as string) ??
        "https://accounts.zoho.com";

      const tokenRes = await fetch(`${accountsServer}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: appCredentials.clientId,
          client_secret: appCredentials.clientSecret,
          redirect_uri: redirectUri,
          code: callbackParams.code,
        }),
      });

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        throw new Error(
          `Zoho CRM token exchange failed: ${tokenRes.status} ${tokenRes.statusText} (${errorBody})`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        api_domain?: string;
        error?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(tokenData.error ?? "Failed to exchange code for token");
      }

      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const apiDomain = tokenData.api_domain ?? "https://www.zohoapis.com";

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
        api_domain: apiDomain,
        accounts_server: accountsServer,
      };

      const scopes = [...DEFAULT_SCOPES];

      const metadata: Record<string, unknown> = {};

      try {
        const userRes = await fetch(
          `${apiDomain}/crm/v8/users?type=CurrentUser`,
          {
            headers: {
              Authorization: `Zoho-oauthtoken ${tokenData.access_token}`,
            },
          },
        );
        if (userRes.ok) {
          const userData = (await userRes.json()) as {
            users?: Array<{
              email?: string;
              full_name?: string;
              first_name?: string;
              last_name?: string;
            }>;
          };
          const user = userData.users?.[0];
          if (user) {
            if (user.email) metadata.username = user.email;
            if (user.full_name) metadata.name = user.full_name;
          }
        }
      } catch {
        // User info fetch failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "1000.XXXX...",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-zoho-client-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "ZOHO_CRM_CLIENT_ID",
      clientSecret: "ZOHO_CRM_CLIENT_SECRET",
    },
  },
};
