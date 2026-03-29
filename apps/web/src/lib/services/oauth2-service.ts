/**
 * OAuth2 token refresh service.
 *
 * Periodically refreshes access tokens for secrets of type "oauth2".
 * Supports Google service account (JWT → token exchange) and generic
 * refresh_token grant.
 *
 * The service account key or refresh token is stored as the secret's
 * encrypted value. The refreshed access token is stored separately in
 * encrypted_access_token and expires at access_token_expires_at.
 * The gateway reads the access token column for injection.
 */

import { createSign } from "crypto";
import { db } from "@onecli/db";
import { cryptoService } from "@/lib/crypto";
import { parseOAuth2Metadata } from "@/lib/validations/secret";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_SECS = 300; // refresh 5 min before expiry

// ── Google service account JWT ─────────────────────────────────────────

export interface GoogleServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

/**
 * Create a signed JWT for Google service account authentication.
 * The JWT is exchanged for an access token at the token endpoint.
 */
export function createGoogleJWT(
  serviceAccount: GoogleServiceAccountKey,
  scopes: string[],
  nowSecs?: number,
): string {
  const now = nowSecs ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: scopes.join(" "),
    aud: serviceAccount.token_uri || GOOGLE_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600, // 1 hour
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${headerB64}.${payloadB64}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(serviceAccount.private_key, "base64url");

  return `${unsigned}.${signature}`;
}

/**
 * Exchange a Google service account JWT for an access token.
 */
export async function fetchGoogleAccessToken(
  serviceAccount: GoogleServiceAccountKey,
  scopes: string[],
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresInSecs: number }> {
  const jwt = createGoogleJWT(serviceAccount, scopes);
  const tokenUrl = serviceAccount.token_uri || GOOGLE_TOKEN_ENDPOINT;

  const res = await fetchFn(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  return {
    accessToken: data.access_token,
    expiresInSecs: data.expires_in,
  };
}

// ── Generic refresh_token grant ────────────────────────────────────────

export async function fetchGenericAccessToken(
  refreshToken: string,
  tokenEndpoint: string,
  clientId?: string,
  clientSecret?: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresInSecs: number }> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  if (clientId) body.client_id = clientId;
  if (clientSecret) body.client_secret = clientSecret;

  const res = await fetchFn(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    expiresInSecs: data.expires_in || 3600,
  };
}

// ── Refresh logic ──────────────────────────────────────────────────────

/**
 * Refresh a single oauth2 secret's access token.
 */
export async function refreshOAuth2Secret(secretId: string): Promise<void> {
  const secret = await db.secret.findUnique({
    where: { id: secretId },
    select: {
      id: true,
      type: true,
      encryptedValue: true,
      metadata: true,
      accountId: true,
    },
  });

  if (!secret || secret.type !== "oauth2") return;

  const config = parseOAuth2Metadata(secret.metadata);
  if (!config) {
    await db.secret.update({
      where: { id: secretId },
      data: { lastRefreshError: "Invalid oauth2 metadata" },
    });
    return;
  }

  try {
    // Decrypt the stored credential (service account key or refresh token)
    const credential = await cryptoService.decrypt(secret.encryptedValue);

    let result: { accessToken: string; expiresInSecs: number };

    if (config.provider === "google") {
      const serviceAccount = JSON.parse(credential) as GoogleServiceAccountKey;
      const scopes = config.scopes || [
        "https://www.googleapis.com/auth/cloud-platform",
      ];
      result = await fetchGoogleAccessToken(serviceAccount, scopes);
    } else {
      // Generic refresh_token grant
      if (!config.tokenEndpoint) {
        throw new Error("tokenEndpoint required for generic oauth2 provider");
      }
      result = await fetchGenericAccessToken(credential, config.tokenEndpoint);
    }

    // Encrypt and store the new access token
    const encryptedAccessToken = await cryptoService.encrypt(
      result.accessToken,
    );
    const expiresAt = new Date(Date.now() + result.expiresInSecs * 1000);

    await db.secret.update({
      where: { id: secretId },
      data: {
        encryptedAccessToken,
        accessTokenExpiresAt: expiresAt,
        lastRefreshError: null,
      },
    });

    // The gateway's connect-resolution cache has a 60s TTL, so it will
    // pick up the new token within a minute — well within the 5-minute
    // refresh margin. Explicit invalidation would require an authenticated
    // request context that the background worker doesn't have.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[oauth2] Failed to refresh secret ${secretId}: ${message}`);
    await db.secret.update({
      where: { id: secretId },
      data: { lastRefreshError: message },
    });
  }
}

/**
 * Refresh all oauth2 secrets that are expired or about to expire.
 * Fetches full secret data upfront to avoid N+1 queries.
 */
export async function refreshAllOAuth2Tokens(): Promise<void> {
  const cutoff = new Date(Date.now() + REFRESH_MARGIN_SECS * 1000);

  const secrets = await db.secret.findMany({
    where: {
      type: "oauth2",
      OR: [
        { accessTokenExpiresAt: null },
        { accessTokenExpiresAt: { lte: cutoff } },
      ],
    },
    select: { id: true, encryptedValue: true, metadata: true, accountId: true },
  });

  if (secrets.length === 0) return;

  console.log(`[oauth2] Refreshing ${secrets.length} token(s)...`);
  for (const secret of secrets) {
    const config = parseOAuth2Metadata(secret.metadata);
    if (!config) {
      await db.secret.update({
        where: { id: secret.id },
        data: { lastRefreshError: "Invalid oauth2 metadata" },
      });
      continue;
    }

    try {
      const credential = await cryptoService.decrypt(secret.encryptedValue);
      let result: { accessToken: string; expiresInSecs: number };

      if (config.provider === "google") {
        const serviceAccount = JSON.parse(
          credential,
        ) as GoogleServiceAccountKey;
        const scopes = config.scopes || [
          "https://www.googleapis.com/auth/cloud-platform",
        ];
        result = await fetchGoogleAccessToken(serviceAccount, scopes);
      } else {
        if (!config.tokenEndpoint) {
          throw new Error("tokenEndpoint required for generic oauth2 provider");
        }
        result = await fetchGenericAccessToken(
          credential,
          config.tokenEndpoint,
        );
      }

      const encryptedAccessToken = await cryptoService.encrypt(
        result.accessToken,
      );
      const expiresAt = new Date(Date.now() + result.expiresInSecs * 1000);

      await db.secret.update({
        where: { id: secret.id },
        data: {
          encryptedAccessToken,
          accessTokenExpiresAt: expiresAt,
          lastRefreshError: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[oauth2] Failed to refresh secret ${secret.id}: ${message}`,
      );
      await db.secret.update({
        where: { id: secret.id },
        data: { lastRefreshError: message },
      });
    }
  }
}

// ── Background worker ──────────────────────────────────────────────────

// Use globalThis to survive Next.js HMR — module-level `let` gets
// re-initialized on hot reload, orphaning the old interval.
const INTERVAL_KEY = Symbol.for("onecli:oauth2-refresh-interval");
const _g = globalThis as Record<symbol, ReturnType<typeof setInterval> | null>;

export function startOAuth2RefreshWorker(): void {
  if (_g[INTERVAL_KEY]) return;

  console.log("[oauth2] Starting token refresh worker (60s check interval)");

  refreshAllOAuth2Tokens().catch((err) =>
    console.error("[oauth2] Initial refresh failed:", err),
  );

  _g[INTERVAL_KEY] = setInterval(() => {
    refreshAllOAuth2Tokens().catch((err) =>
      console.error("[oauth2] Refresh cycle failed:", err),
    );
  }, 60_000);
}

export function stopOAuth2RefreshWorker(): void {
  if (_g[INTERVAL_KEY]) {
    clearInterval(_g[INTERVAL_KEY]);
    _g[INTERVAL_KEY] = null;
  }
}
