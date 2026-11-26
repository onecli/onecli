import { z } from "zod";
import type { AppDefinition } from "./types";

/**
 * Bitbucket Cloud. NOT part of the shared Atlassian sign-in (Jira,
 * Confluence): Bitbucket has its own OAuth consumer, registered in a
 * workspace's settings, with its own endpoints on bitbucket.org. Scopes are
 * fixed on that consumer, so the authorize URL carries none.
 *
 * Bitbucket rotates refresh tokens (each refresh returns a new one) and
 * expires unused ones after 3 months; the gateway's refresh stores the
 * rotated token every time.
 */
const BITBUCKET_AUTHORIZE_URL = "https://bitbucket.org/site/oauth2/authorize";
const BITBUCKET_TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";
const BITBUCKET_USER_URL = "https://api.bitbucket.org/2.0/user";

const tokenSchema = z.object({
  access_token: z.string().trim().min(1),
  refresh_token: z.string().trim().min(1),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().optional(),
  // Bitbucket reports the granted scopes space-separated in `scopes`.
  scopes: z.string().optional(),
});

/** Bitbucket's OAuth error body (RFC 6749 §5.2), sent with a 4xx. */
const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/** `GET /2.0/user`: `username` is documented as kept on this endpoint
 * alone (it returns only the caller's own account). */
const userSchema = z.object({
  username: z.string().optional(),
  display_name: z.string().optional(),
  links: z
    .object({
      avatar: z.object({ href: z.string().optional() }).optional(),
    })
    .optional(),
});

export const bitbucket: AppDefinition = {
  id: "bitbucket",
  setupGuideUrl: "https://onecli.sh/docs/integrations/bitbucket",
  name: "Bitbucket",
  apiDocsUrl: "https://developer.atlassian.com/cloud/bitbucket/rest/",
  icon: "/icons/bitbucket.svg",
  description: "Repositories, pull requests, and Pipelines in Bitbucket Cloud.",
  connectionMethod: {
    type: "oauth",
    // Informational only: Bitbucket grants whatever the consumer was set up
    // with. These name what OneCLI's setup guide asks for.
    defaultScopes: [
      "account",
      "repository",
      "repository:write",
      "pullrequest",
      "pullrequest:write",
      "project",
      "pipeline",
    ],
    permissions: [
      {
        scope: "account",
        name: "Profile",
        description: "Your Bitbucket username, name, and workspaces",
        access: "read",
      },
      {
        scope: "repository",
        name: "Read repositories",
        description: "Clone and read repository contents",
        access: "read",
      },
      {
        scope: "repository:write",
        name: "Write repositories",
        description: "Push commits and create branches",
        access: "write",
      },
      {
        scope: "pullrequest:write",
        name: "Pull requests",
        description: "Read, create, comment on, and merge pull requests",
        access: "write",
      },
      {
        scope: "pipeline",
        name: "Pipelines",
        description: "View Pipelines runs and their logs",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, state }) => {
      const url = new URL(BITBUCKET_AUTHORIZE_URL);
      url.searchParams.set("client_id", appCredentials.clientId!);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      // Optional for Bitbucket (the consumer has one callback), but sent so a
      // mismatch fails at the consent screen, not at the token exchange.
      url.searchParams.set("redirect_uri", redirectUri);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      // The callback's own query is untrusted text: never echo it back.
      if (callbackParams.error) {
        throw new Error("Bitbucket authorization failed");
      }
      if (!callbackParams.code) {
        throw new Error("Bitbucket callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Bitbucket OAuth credentials not configured");
      }
      const basic = Buffer.from(
        `${appCredentials.clientId}:${appCredentials.clientSecret}`,
      ).toString("base64");
      const tokenRes = await fetch(BITBUCKET_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callbackParams.code,
          redirect_uri: redirectUri,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await tokenRes.json().catch(() => null);

      if (!tokenRes.ok) {
        // Bitbucket answers a refused grant with a 400 and an OAuth error
        // body ("authorization_code is invalid"): show its words.
        const refused = tokenErrorSchema.safeParse(body);
        throw new Error(
          refused.success
            ? (refused.data.error_description ?? refused.data.error)
            : `Bitbucket token exchange failed: ${tokenRes.status}`,
        );
      }
      const token = tokenSchema.safeParse(body);
      if (!token.success) {
        throw new Error("Invalid Bitbucket token response");
      }
      const tokenData = token.data;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: tokenData.expires_in
          ? Math.floor(Date.now() / 1000) + tokenData.expires_in
          : undefined,
      };
      const scopes = tokenData.scopes?.split(/\s+/).filter(Boolean) ?? [];

      let metadata: Record<string, unknown> | undefined;
      const userRes = await fetch(BITBUCKET_USER_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (userRes?.ok) {
        const user = userSchema.safeParse(
          await userRes.json().catch(() => null),
        );
        if (user.success) {
          metadata = {
            username: user.data.username,
            name: user.data.display_name,
            avatarUrl: user.data.links?.avatar?.href,
          };
        }
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Create an OAuth consumer in your Bitbucket workspace: Settings > Apps and features > OAuth consumers. Grant type: Authorization code (with refresh token).",
    fields: [
      {
        name: "clientId",
        label: "Key",
        placeholder: "Your OAuth consumer key",
      },
      {
        name: "clientSecret",
        label: "Secret",
        placeholder: "Your OAuth consumer secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "BITBUCKET_CLIENT_ID",
      clientSecret: "BITBUCKET_CLIENT_SECRET",
    },
  },
};
