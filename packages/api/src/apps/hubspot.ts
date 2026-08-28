import type { AppDefinition } from "./types";

const REQUIRED_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.companies.read",
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "tickets",
];

const OPTIONAL_SCOPES = [
  "crm.objects.contacts.write",
  "crm.objects.companies.write",
  "crm.objects.deals.write",
  "crm.objects.line_items.read",
  "crm.objects.quotes.read",
  "crm.lists.read",
  "crm.schemas.contacts.read",
  "crm.schemas.companies.read",
  "crm.schemas.deals.read",
];

export const hubspot: AppDefinition = {
  id: "hubspot",
  name: "HubSpot",
  icon: "/icons/hubspot.svg",
  description: "CRM contacts, companies, deals, and tickets.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: REQUIRED_SCOPES,
    permissions: [
      {
        scope: "crm.objects.contacts.read",
        name: "Contacts",
        description: "View contact records and properties",
        access: "read",
      },
      {
        scope: "crm.objects.contacts.write",
        name: "Contacts",
        description: "Create and update contact records",
        access: "write",
      },
      {
        scope: "crm.objects.companies.read",
        name: "Companies",
        description: "View company records and properties",
        access: "read",
      },
      {
        scope: "crm.objects.companies.write",
        name: "Companies",
        description: "Create and update company records",
        access: "write",
      },
      {
        scope: "crm.objects.deals.read",
        name: "Deals",
        description: "View deal records and pipeline stages",
        access: "read",
      },
      {
        scope: "crm.objects.deals.write",
        name: "Deals",
        description: "Create and update deal records",
        access: "write",
      },
      {
        scope: "tickets",
        name: "Tickets",
        description: "View ticket records and properties",
        access: "read",
      },
      {
        scope: "tickets",
        name: "Tickets",
        description: "Create and update ticket records",
        access: "write",
      },
      {
        scope: "crm.objects.owners.read",
        name: "Owners",
        description: "View record owners and assignments",
        access: "read",
      },
      {
        scope: "crm.objects.line_items.read",
        name: "Line items",
        description: "View line item records",
        access: "read",
      },
      {
        scope: "crm.objects.quotes.read",
        name: "Quotes",
        description: "View quote records",
        access: "read",
      },
      {
        scope: "crm.lists.read",
        name: "Lists",
        description: "View contact lists",
        access: "read",
      },
      {
        scope: "crm.schemas.contacts.read",
        name: "Contact schema",
        description: "View contact property definitions",
        access: "read",
      },
      {
        scope: "crm.schemas.companies.read",
        name: "Company schema",
        description: "View company property definitions",
        access: "read",
      },
      {
        scope: "crm.schemas.deals.read",
        name: "Deal schema",
        description: "View deal property definitions",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("HubSpot OAuth client ID not configured");
      }
      const url = new URL("https://app.hubspot.com/oauth/authorize");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("optional_scope", OPTIONAL_SCOPES.join(" "));
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `HubSpot authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("HubSpot callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("HubSpot OAuth credentials not configured");
      }

      const tokenRes = await fetch(
        "https://api.hubapi.com/oauth/2026-03/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: appCredentials.clientId,
            client_secret: appCredentials.clientSecret,
            redirect_uri: redirectUri,
            code: callbackParams.code,
          }),
        },
      );

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        throw new Error(
          `HubSpot token exchange failed: ${tokenRes.status} ${tokenRes.statusText} (${errorBody})`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        hub_id?: number;
        scopes?: string[];
        error?: string;
        message?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(
          tokenData.message ?? "Failed to exchange code for token",
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

      const scopes = tokenData.scopes ?? [];

      const metadata: Record<string, unknown> = {
        hubId: tokenData.hub_id,
      };

      try {
        const introspectRes = await fetch(
          "https://api.hubapi.com/oauth/2026-03/token/introspect",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: appCredentials.clientId,
              client_secret: appCredentials.clientSecret,
              token: tokenData.access_token,
              token_type_hint: "access_token",
            }),
          },
        );
        if (introspectRes.ok) {
          const info = (await introspectRes.json()) as {
            user?: string;
            user_id?: number;
            hub_domain?: string;
            hub_id?: number;
          };
          if (info.user) metadata.username = info.user;
          if (info.hub_domain) metadata.name = info.hub_domain;
        }
      } catch {
        // Token introspection failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "your-hubspot-app-client-id",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-hubspot-app-client-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "HUBSPOT_CLIENT_ID",
      clientSecret: "HUBSPOT_CLIENT_SECRET",
    },
  },
};
