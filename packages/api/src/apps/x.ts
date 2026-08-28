import type { AppDefinition } from "./types";
import { OAUTH_STATE_SECRET, SECRET_ENCRYPTION_KEY } from "../lib/env";

// Derive PKCE verifier deterministically from the signed OAuth state using an
// HMAC with the server's signing key. This avoids an in-memory store that
// would break across serverless invocations or multi-instance deployments.
// node:crypto is imported lazily inside the (server-only) OAuth handlers: this
// definition module rides the client-reachable app registry, whose graph must
// stay free of Node builtins.
const deriveCodeVerifier = async (state: string): Promise<string> => {
  const { createHmac } = await import("node:crypto");
  const key = OAUTH_STATE_SECRET || SECRET_ENCRYPTION_KEY;
  return createHmac("sha256", key).update(`pkce:${state}`).digest("base64url");
};

const deriveCodeChallenge = async (verifier: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(verifier).digest("base64url");
};

export const x: AppDefinition = {
  id: "x",
  name: "X",
  icon: "/icons/x.svg",
  darkIcon: "/icons/x-light.svg",
  description: "Posts, timelines, DMs, and account management.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "tweet.read",
      "tweet.write",
      "tweet.moderate.write",
      "users.read",
      "follows.read",
      "follows.write",
      "like.read",
      "like.write",
      "list.read",
      "list.write",
      "bookmark.read",
      "bookmark.write",
      "block.read",
      "block.write",
      "mute.read",
      "mute.write",
      "dm.read",
      "dm.write",
      "space.read",
      "media.write",
      "offline.access",
    ],
    permissions: [
      {
        scope: "tweet.read",
        name: "Read posts",
        description: "View posts, timelines, and search results",
        access: "read",
      },
      {
        scope: "tweet.write",
        name: "Write posts",
        description: "Create, retweet, and quote posts",
        access: "write",
      },
      {
        scope: "tweet.moderate.write",
        name: "Moderate posts",
        description: "Hide and unhide replies to your posts",
        access: "write",
      },
      {
        scope: "users.read",
        name: "Users",
        description: "View user profiles and account info",
        access: "read",
      },
      {
        scope: "follows.read",
        name: "Read follows",
        description: "View followers and following lists",
        access: "read",
      },
      {
        scope: "follows.write",
        name: "Manage follows",
        description: "Follow and unfollow accounts",
        access: "write",
      },
      {
        scope: "like.read",
        name: "Read likes",
        description: "View liked posts",
        access: "read",
      },
      {
        scope: "like.write",
        name: "Manage likes",
        description: "Like and unlike posts",
        access: "write",
      },
      {
        scope: "dm.read",
        name: "Read DMs",
        description: "View direct message conversations",
        access: "read",
      },
      {
        scope: "dm.write",
        name: "Send DMs",
        description: "Send and manage direct messages",
        access: "write",
      },
      {
        scope: "bookmark.read",
        name: "Read bookmarks",
        description: "View bookmarked posts",
        access: "read",
      },
      {
        scope: "bookmark.write",
        name: "Manage bookmarks",
        description: "Add and remove bookmarks",
        access: "write",
      },
      {
        scope: "list.read",
        name: "Read lists",
        description: "View lists and list members",
        access: "read",
      },
      {
        scope: "list.write",
        name: "Manage lists",
        description: "Create, edit, and delete lists",
        access: "write",
      },
      {
        scope: "block.read",
        name: "Read blocks",
        description: "View blocked accounts",
        access: "read",
      },
      {
        scope: "block.write",
        name: "Manage blocks",
        description: "Block and unblock accounts",
        access: "write",
      },
      {
        scope: "mute.read",
        name: "Read mutes",
        description: "View muted accounts",
        access: "read",
      },
      {
        scope: "mute.write",
        name: "Manage mutes",
        description: "Mute and unmute accounts",
        access: "write",
      },
      {
        scope: "space.read",
        name: "Spaces",
        description: "View Spaces and participants",
        access: "read",
      },
      {
        scope: "media.write",
        name: "Upload media",
        description: "Upload images and videos for posts",
        access: "write",
      },
      {
        scope: "offline.access",
        name: "Stay connected",
        description: "Maintain access when you are not actively using the app",
        access: "read",
      },
    ],
    buildAuthUrl: async ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("X OAuth client ID not configured");
      }

      const verifier = await deriveCodeVerifier(state);
      const challenge = await deriveCodeChallenge(verifier);

      const url = new URL("https://x.com/i/oauth2/authorize");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `X authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }

      if (!callbackParams.code) {
        throw new Error("X callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("X OAuth credentials not configured");
      }

      if (!callbackParams.state) {
        throw new Error("X callback missing state parameter");
      }
      const codeVerifier = await deriveCodeVerifier(callbackParams.state);

      const basicAuth = Buffer.from(
        `${appCredentials.clientId}:${appCredentials.clientSecret}`,
      ).toString("base64");

      const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callbackParams.code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      if (!tokenRes.ok) {
        const errorBody = await tokenRes.text();
        throw new Error(
          `X token exchange failed: ${tokenRes.status} ${tokenRes.statusText} (${errorBody})`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
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

      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

      let metadata: Record<string, unknown> | undefined;
      try {
        const userRes = await fetch(
          "https://api.x.com/2/users/me?user.fields=profile_image_url",
          {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          },
        );

        if (userRes.ok) {
          const body = (await userRes.json()) as {
            data?: {
              id?: string;
              name?: string;
              username?: string;
              profile_image_url?: string;
            };
          };
          if (body.data) {
            metadata = {
              username: body.data.username,
              name: body.data.name,
              avatarUrl: body.data.profile_image_url,
            };
          }
        }
      } catch {
        // User info fetch failed — continue without metadata
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Create an app in the X Developer Portal under Projects & Apps.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "your-x-client-id",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-x-client-secret",
        secret: true,
      },
    ],
  },
};
