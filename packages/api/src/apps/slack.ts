import type { AppDefinition } from "./types";

export const slack: AppDefinition = {
  id: "slack",
  name: "Slack",
  icon: "/icons/slack.svg",
  description: "Channels, messages, people, and reactions in your workspace.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "channels:read",
      "channels:history",
      "groups:read",
      "users:read",
      "chat:write",
      "reactions:write",
    ],
    permissions: [
      {
        scope: "channels:read",
        name: "Channels",
        description: "View basic info about public channels",
        access: "read",
      },
      {
        scope: "channels:history",
        name: "Channel history",
        description: "Read messages in public channels the app is in",
        access: "read",
      },
      {
        scope: "groups:read",
        name: "Private channels",
        description: "View basic info about private channels the app is in",
        access: "read",
      },
      {
        scope: "users:read",
        name: "People",
        description: "View people in the workspace",
        access: "read",
      },
      {
        scope: "chat:write",
        name: "Send messages",
        description: "Post messages as the app",
        access: "write",
      },
      {
        scope: "reactions:write",
        name: "Reactions",
        description: "Add emoji reactions to messages",
        access: "write",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", appCredentials.clientId!);
      url.searchParams.set("redirect_uri", redirectUri);
      // Slack expects comma-separated bot scopes in the `scope` param.
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      // Slack recommends authenticating the app with HTTP Basic (client_id +
      // client_secret) rather than passing them in the request body.
      const basicAuth = Buffer.from(
        `${appCredentials.clientId}:${appCredentials.clientSecret}`,
      ).toString("base64");

      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code: callbackParams.code!,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        throw new Error(
          `Slack token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      // Slack returns HTTP 200 even on failure; the `ok` flag is authoritative.
      const tokenData = (await tokenRes.json()) as {
        ok?: boolean;
        access_token?: string;
        token_type?: string;
        scope?: string;
        bot_user_id?: string;
        app_id?: string;
        expires_in?: number;
        refresh_token?: string;
        team?: { id?: string; name?: string };
        error?: string;
      };

      if (!tokenData.ok || !tokenData.access_token) {
        throw new Error(tokenData.error ?? "Failed to exchange code for token");
      }

      // Default Slack bot tokens are non-expiring. Token rotation (opt-in) adds
      // expires_in + refresh_token; store those only when Slack returns them.
      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
      };

      const scopes = tokenData.scope?.split(",").filter(Boolean) ?? [];

      // The V2 token response already carries the workspace + bot identity, so
      // no extra auth.test call is needed to populate the connection metadata.
      const metadata: Record<string, unknown> = {
        name: tokenData.team?.name,
        teamId: tokenData.team?.id,
        botUserId: tokenData.bot_user_id,
        appId: tokenData.app_id,
      };

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Create a Slack app at api.slack.com/apps (Basic Information → App Credentials).",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "1234567890.1234567890",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-slack-app-client-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "SLACK_CLIENT_ID",
      clientSecret: "SLACK_CLIENT_SECRET",
    },
  },
};
