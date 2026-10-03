import type { AppDefinition } from "./types";
import { OAUTH_STATE_SECRET, SECRET_ENCRYPTION_KEY } from "../lib/env";

// Salesforce serves every org from its own My Domain host under
// `my.salesforce.com` — production (`acme.my.salesforce.com`), sandboxes
// (`acme--dev.sandbox.my.salesforce.com`) and the partitioned non-production
// domains (`acme-dev-ed.develop.my.salesforce.com`, plus `.scratch`, `.patch`,
// `.demo`, `.free`, `.trailblaze`). Accept any label chain under that zone
// rather than enumerating partitions: the whole zone is Salesforce-operated, and
// tenant isolation comes from the gateway pinning the connection to this exact
// stored host (`credential_host_field`), not from the suffix.
const INSTANCE_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.my\.salesforce\.com$/;

/** The org host the token is bound to. Rejects anything but a bare https origin. */
export const parseInstanceUrl = (value: unknown): string => {
  if (typeof value !== "string")
    throw new Error("Invalid Salesforce instance URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Salesforce instance URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !INSTANCE_HOST.test(url.hostname)
  ) {
    throw new Error("Invalid Salesforce instance URL");
  }
  return url.hostname;
};

/** Salesforce authenticates against a fixed pair of endpoints. Sandboxes —
 *  including Developer Edition and scratch orgs — use `test.salesforce.com`. */
const loginOrigin = (environment: string): string => {
  if (environment === "production") return "https://login.salesforce.com";
  if (environment === "sandbox") return "https://test.salesforce.com";
  throw new Error("Salesforce environment must be production or sandbox");
};

// PKCE verifier derived from the signed OAuth state with the server's signing
// key — same approach as `x.ts`, so no cross-request store is needed. node
// builtins load lazily: this module rides the client-reachable app registry.
const deriveCodeVerifier = async (state: string): Promise<string> => {
  const { createHmac } = await import("node:crypto");
  const key = OAUTH_STATE_SECRET || SECRET_ENCRYPTION_KEY;
  if (!key) throw new Error("OAuth signing secret is required");
  return createHmac("sha256", key).update(`pkce:${state}`).digest("base64url");
};

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Salesforce response missing ${field}`);
  }
  return value;
};

// Salesforce does not return `expires_in`: access-token lifetime follows the
// org's (or the app's) session-timeout setting, which an admin can set as low
// as 15 minutes. Store a conservative expiry UNDER that floor so the gateway's
// standard expiry-driven refresh renews the token before any org can expire it.
// Refreshing early is cheap; refreshing late surfaces a 401 to the agent.
const ASSUMED_TOKEN_LIFETIME_SECONDS = 10 * 60;

export const salesforce: AppDefinition = {
  id: "salesforce",
  name: "Salesforce",
  icon: "/icons/salesforce.svg",
  description: "Salesforce CRM records, queries, and object metadata.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: ["api", "refresh_token", "openid"],
    permissions: [
      {
        scope: "api",
        name: "CRM data",
        description:
          "Read and write records, queries, and object metadata — limited to what the connected Salesforce user may do",
        access: "write",
      },
      {
        scope: "refresh_token",
        name: "Offline access",
        description: "Keep the connection working without re-authorizing",
        access: "read",
      },
      {
        scope: "openid",
        name: "Identity",
        description: "Identify the Salesforce user and organization",
        access: "read",
      },
    ],
    buildAuthUrl: async ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Salesforce OAuth client ID not configured");
      }
      const { createHash } = await import("node:crypto");
      const verifier = await deriveCodeVerifier(state);

      const url = new URL(
        `${loginOrigin(appCredentials.environment ?? "")}/services/oauth2/authorize`,
      );
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `Salesforce authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }
      if (!callbackParams.code) {
        throw new Error("Salesforce callback missing authorization code");
      }
      if (!callbackParams.state) {
        throw new Error("Salesforce callback missing state parameter");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Salesforce OAuth credentials not configured");
      }

      const origin = loginOrigin(appCredentials.environment ?? "");
      const tokenRes = await fetch(`${origin}/services/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callbackParams.code,
          client_id: appCredentials.clientId,
          client_secret: appCredentials.clientSecret,
          redirect_uri: redirectUri,
          code_verifier: await deriveCodeVerifier(callbackParams.state),
        }),
      });

      if (!tokenRes.ok) {
        throw new Error(
          `Salesforce token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        instance_url?: string;
        token_type?: string;
        scope?: string;
      };

      const accessToken = nonEmpty(tokenData.access_token, "an access token");
      const refreshToken = nonEmpty(tokenData.refresh_token, "a refresh token");
      const instanceHost = parseInstanceUrl(tokenData.instance_url);

      // Identity comes from the environment's fixed endpoint, never from a URL
      // in the token payload.
      const identityRes = await fetch(`${origin}/services/oauth2/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!identityRes.ok) {
        throw new Error("Salesforce identity lookup failed");
      }
      const identity = (await identityRes.json()) as {
        user_id?: string;
        organization_id?: string;
        preferred_username?: string;
        name?: string;
      };

      const credentials: Record<string, unknown> = {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_at:
          Math.floor(Date.now() / 1000) + ASSUMED_TOKEN_LIFETIME_SECONDS,
        // Pins injection to this org's host and tells the gateway which
        // Salesforce endpoint refreshes this connection. Deliberately NOT
        // `token_url`: that key means an arbitrary dial-able endpoint for
        // `client_credentials` connections, and the two must not be conflated.
        instance_host: instanceHost,
        token_endpoint: `${origin}/services/oauth2/token`,
      };

      return {
        credentials,
        scopes: tokenData.scope?.split(/\s+/).filter(Boolean) ?? [],
        // `username` (not `email`) carries the label: the Salesforce username is
        // unique per org and already distinguishes a sandbox from its production
        // org, so two orgs sharing a person's email stay separate connections.
        metadata: {
          username: identity.preferred_username,
          name: identity.name,
          user_id: identity.user_id,
          organization_id: identity.organization_id,
          instance_host: instanceHost,
        },
      };
    },
  },
  configurable: {
    hint: "Use the Consumer Key and Secret from a Salesforce External Client App. Agents act as the connecting Salesforce user, so their permissions apply — including writes.",
    fields: [
      {
        name: "clientId",
        label: "Consumer Key",
        placeholder: "3MVG9...",
      },
      {
        name: "clientSecret",
        label: "Consumer Secret",
        placeholder: "your-consumer-secret",
        secret: true,
      },
      {
        name: "environment",
        label: "Environment",
        description:
          "Use sandbox for sandboxes, Developer Edition, and scratch orgs.",
        placeholder: "production or sandbox",
      },
    ],
  },
};
