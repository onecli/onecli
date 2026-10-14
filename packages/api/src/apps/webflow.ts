import type { AppDefinition } from "./types";

// Webflow Data API v2 (https://developers.webflow.com/data/reference/oauth-app).
// Authorization Code Grant; access tokens do not expire and there is no
// refresh token, so the gateway needs no refresh config.
//
// Webflow rejects an authorize URL that asks for any scope the app was not
// configured with in its Webflow dashboard, so `defaultScopes` must stay a
// subset of the scopes ticked on the OneCLI app (see the Webflow docs page).
export const webflow: AppDefinition = {
  id: "webflow",
  name: "Webflow",
  icon: "/icons/webflow.svg",
  apiDocsUrl: "https://developers.webflow.com/data/reference/rest-introduction",
  description: "Sites, pages, CMS collections, forms, and assets.",
  setupGuideUrl: "https://onecli.sh/docs/integrations/webflow",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "authorized_user:read",
      "sites:read",
      "sites:write",
      "pages:read",
      "pages:write",
      "cms:read",
      "cms:write",
      "forms:read",
      "forms:write",
      "assets:read",
      "assets:write",
      "components:read",
      "components:write",
      "site_config:read",
      "site_config:write",
      "site_activity:read",
      "comments:read",
    ],
    permissions: [
      {
        scope: "authorized_user:read",
        name: "Profile",
        description: "Your name and email",
        access: "read",
      },
      {
        scope: "sites:read",
        name: "Sites",
        description: "View sites and their domains",
        access: "read",
      },
      {
        scope: "sites:write",
        name: "Sites",
        description: "Publish sites",
        access: "write",
      },
      {
        scope: "pages:read",
        name: "Pages",
        description: "View pages, their settings and content",
        access: "read",
      },
      {
        scope: "pages:write",
        name: "Pages",
        description: "Edit page settings and static content",
        access: "write",
      },
      {
        scope: "cms:read",
        name: "CMS",
        description: "View collections and items",
        access: "read",
      },
      {
        scope: "cms:write",
        name: "CMS",
        description: "Create, edit, publish, and delete collections and items",
        access: "write",
      },
      {
        scope: "forms:read",
        name: "Forms",
        description: "View forms and submissions",
        access: "read",
      },
      {
        scope: "forms:write",
        name: "Forms",
        description: "Edit and delete form submissions",
        access: "write",
      },
      {
        scope: "assets:read",
        name: "Assets",
        description: "View assets and folders",
        access: "read",
      },
      {
        scope: "assets:write",
        name: "Assets",
        description: "Upload, edit, and delete assets",
        access: "write",
      },
      {
        scope: "components:read",
        name: "Components",
        description: "View components and their properties",
        access: "read",
      },
      {
        scope: "components:write",
        name: "Components",
        description: "Edit component content and properties",
        access: "write",
      },
      {
        scope: "site_config:read",
        name: "Site config",
        description: "View robots.txt rules",
        access: "read",
      },
      {
        scope: "site_config:write",
        name: "Site config",
        description: "Edit robots.txt rules and well-known files",
        access: "write",
      },
      {
        scope: "site_activity:read",
        name: "Site activity",
        description: "View a site's activity log",
        access: "read",
      },
      {
        scope: "comments:read",
        name: "Comments",
        description: "View comment threads and replies",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Webflow OAuth client ID not configured");
      }
      const url = new URL("https://webflow.com/oauth/authorize");
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
          `Webflow authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }
      if (!callbackParams.code) {
        throw new Error("Webflow callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Webflow OAuth credentials not configured");
      }

      // The redirect_uri is sent on authorize, so Webflow requires it on the
      // token request too (otherwise `invalid_grant`).
      const tokenRes = await fetch(
        "https://api.webflow.com/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            client_id: appCredentials.clientId,
            client_secret: appCredentials.clientSecret,
            code: callbackParams.code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }),
        },
      );

      if (!tokenRes.ok) {
        throw new Error(
          `Webflow token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
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

      const scopes = parseScopes(tokenData.scope);
      const authHeader = { Authorization: `Bearer ${tokenData.access_token}` };

      const metadata: Record<string, unknown> = {};
      try {
        const userRes = await fetch(
          "https://api.webflow.com/v2/token/authorized_by",
          { headers: authHeader },
        );
        if (userRes.ok) {
          const user = (await userRes.json()) as {
            id?: string;
            email?: string;
            firstName?: string;
            lastName?: string;
          };
          const name = [user.firstName, user.lastName]
            .filter(Boolean)
            .join(" ");
          if (user.email) {
            metadata.email = user.email;
            metadata.username = user.email;
          }
          if (name) metadata.name = name;
          if (user.id) metadata.webflowUserId = user.id;
        }
      } catch {
        // User info fetch failed: continue without metadata.
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Create an App with the Data Client building block in your Webflow workspace (Apps & Integrations → Develop).",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "a1b2c3...",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "d4e5f6...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "WEBFLOW_CLIENT_ID",
      clientSecret: "WEBFLOW_CLIENT_SECRET",
    },
  },
};

// Tolerate either separator; the scope list is display-only.
const parseScopes = (raw: string | undefined): string[] =>
  raw?.split(/[\s,]+/).filter(Boolean) ?? [];
