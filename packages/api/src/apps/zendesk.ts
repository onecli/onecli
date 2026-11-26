import { z } from "zod";
import type { AppDefinition } from "./types";

// Zendesk serves every account from its own subdomain (`acme.zendesk.com`),
// and the OAuth client lives inside that account, so the connection is
// bring-your-own: the subdomain, client ID and secret all come from the
// workspace's app config. The subdomain is spliced into URLs that carry the
// client secret, so it is validated as a single DNS label before any request.
const ZENDESK_SCOPES = ["read", "write"];
// Cap provider lifetimes at two days, keeping expires_at safely bounded.
const ZENDESK_MAX_ACCESS_TOKEN_SECONDS = 172800;
const tokenSchema = z.object({
  access_token: z.string().trim().min(1),
  refresh_token: z.string().trim().min(1),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(ZENDESK_MAX_ACCESS_TOKEN_SECONDS)
    .optional(),
  token_type: z
    .string()
    .regex(/^bearer$/i)
    .optional(),
  scope: z.string().optional(),
});
const identitySchema = z.object({
  user: z.object({
    email: z.string().optional(),
    name: z.string().optional(),
    photo: z
      .object({ content_url: z.string().optional() })
      .nullable()
      .optional(),
  }),
});

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Zendesk's default lifetimes (access 30 minutes, refresh 30 days). */
const ZENDESK_ACCESS_TOKEN_SECONDS = 30 * 60;
const ZENDESK_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

/** The account host for a configured subdomain. Accepts `acme`, `acme.zendesk.com`
 *  or `https://acme.zendesk.com/`; rejects anything else. */
export const zendeskHost = (raw: unknown): string => {
  if (typeof raw !== "string") throw new Error("Invalid Zendesk subdomain");
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (value.endsWith(".zendesk.com")) {
    value = value.slice(0, -".zendesk.com".length);
  }
  if (!SUBDOMAIN.test(value)) {
    throw new Error("Invalid Zendesk subdomain");
  }
  return `${value}.zendesk.com`;
};

export const zendesk: AppDefinition = {
  id: "zendesk",
  setupGuideUrl: "https://onecli.sh/docs/integrations/zendesk",
  name: "Zendesk",
  icon: "/icons/zendesk.svg",
  darkIcon: "/icons/zendesk-light.svg",
  apiDocsUrl: "https://developer.zendesk.com/api-reference/",
  description: "Support tickets, users, organizations, and Help Center.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: ZENDESK_SCOPES,
    permissions: [
      {
        scope: "read",
        name: "Read",
        description: "View tickets, users, organizations, and articles",
        access: "read",
      },
      {
        scope: "write",
        name: "Write",
        description: "Create and update tickets, users, and articles",
        access: "write",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Zendesk OAuth client ID not configured");
      }
      const host = zendeskHost(appCredentials.subdomain);
      const url = new URL(`https://${host}/oauth/authorizations/new`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error("Zendesk authorization failed");
      }
      if (!callbackParams.code) {
        throw new Error("Zendesk callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Zendesk OAuth credentials not configured");
      }
      const host = zendeskHost(appCredentials.subdomain);

      // Legacy OAuth clients can issue non-expiring tokens unless lifetimes
      // are explicit. The gateway renews both tokens on this account's host.
      const tokenRes = await fetch(`https://${host}/oauth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: callbackParams.code,
          client_id: appCredentials.clientId,
          client_secret: appCredentials.clientSecret,
          redirect_uri: redirectUri,
          scope: ZENDESK_SCOPES.join(" "),
          expires_in: ZENDESK_ACCESS_TOKEN_SECONDS,
          refresh_token_expires_in: ZENDESK_REFRESH_TOKEN_SECONDS,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) {
        throw new Error(`Zendesk token exchange failed: ${tokenRes.status}`);
      }

      const parsedToken = tokenSchema.safeParse(
        await tokenRes.json().catch(() => null),
      );
      if (!parsedToken.success) {
        throw new Error(
          "Invalid Zendesk token response: access token, refresh token, or token metadata",
        );
      }
      const tokenData = parsedToken.data;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: "Bearer",
        expires_at:
          Math.floor(Date.now() / 1000) +
          (tokenData.expires_in ?? ZENDESK_ACCESS_TOKEN_SECONDS),
        // Pins injection to this account's host (gateway `credential_host_field`)
        // and names the host the gateway refreshes on (`ZENDESK_REFRESH`).
        instance_host: host,
      };

      let metadata: Record<string, unknown> = { instance: host };
      const userRes = await fetch(`https://${host}/api/v2/users/me.json`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (userRes?.ok) {
        const identity = identitySchema.safeParse(
          await userRes.json().catch(() => null),
        );
        if (identity.success) {
          metadata = {
            ...metadata,
            username: identity.data.user.email,
            name: identity.data.user.name,
            avatarUrl: identity.data.user.photo?.content_url,
          };
        }
      }

      return {
        credentials,
        scopes: tokenData.scope?.split(/\s+/).filter(Boolean) ?? [],
        metadata,
      };
    },
  },
  labelHint: 'e.g. "you@acme.com"',
  configurable: {
    hint: "Connect the OAuth client you created in your Zendesk Admin Center (Apps and integrations > APIs > OAuth Clients).",
    fields: [
      {
        name: "subdomain",
        label: "Subdomain",
        description: "Your Zendesk subdomain (the part before .zendesk.com)",
        placeholder: "acme",
      },
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "your-zendesk-oauth-client-id",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-zendesk-oauth-client-secret",
        secret: true,
      },
    ],
  },
};
