import { createRemoteJWKSet, jwtVerify } from "jose";
import { db } from "@onecli/db";
import { OAUTH_ISSUER, OAUTH_AUDIENCE, OAUTH_JWKS_URL } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface JwtAuth {
  userId: string;
  accountId: string;
}

const log = logger.child({ module: "validate-jwt" });

// Module-level singletons — persist across requests in the Node.js process.
let cachedJwksUri: string | null = null;
let cachedGetKey: ReturnType<typeof createRemoteJWKSet> | null = null;

const resolveJwksUri = async (): Promise<string | null> => {
  if (cachedJwksUri) return cachedJwksUri;

  if (OAUTH_JWKS_URL) {
    cachedJwksUri = OAUTH_JWKS_URL;
    return cachedJwksUri;
  }

  try {
    const res = await fetch(`${OAUTH_ISSUER}/.well-known/openid-configuration`);
    const doc = (await res.json()) as { jwks_uri?: string };
    if (!doc.jwks_uri) {
      log.warn("OIDC discovery response missing jwks_uri");
      return null;
    }
    cachedJwksUri = doc.jwks_uri;
    return cachedJwksUri;
  } catch (err) {
    log.warn({ err }, "OIDC discovery failed");
    return null;
  }
};

const getKeyFunction = async (): Promise<ReturnType<
  typeof createRemoteJWKSet
> | null> => {
  if (cachedGetKey) return cachedGetKey;

  const jwksUri = await resolveJwksUri();
  if (!jwksUri) return null;

  cachedGetKey = createRemoteJWKSet(new URL(jwksUri));
  return cachedGetKey;
};

const extractBearerToken = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || token.startsWith("oc_")) return null;
  return token;
};

const lookupUser = async (externalAuthId: string): Promise<JwtAuth | null> => {
  const user = await db.user.findUnique({
    where: { externalAuthId },
    select: {
      id: true,
      memberships: { select: { accountId: true }, take: 1 },
    },
  });

  if (!user || user.memberships.length === 0) {
    log.warn({ sub: externalAuthId }, "JWT auth: user or account not found");
    return null;
  }

  return { userId: user.id, accountId: user.memberships[0]!.accountId };
};

/**
 * Validate an OAuth access token (JWT) from a request's `Authorization: Bearer ...` header.
 * Verifies signature via JWKS, checks issuer + audience + expiration, then resolves the user.
 * Returns null (and logs a warning) on any failure, allowing fallthrough to session auth.
 */
export const validateJwt = async (
  request: Request,
): Promise<JwtAuth | null> => {
  if (!OAUTH_ISSUER) return null;

  const token = extractBearerToken(request);
  if (!token) return null;

  const getKey = await getKeyFunction();
  if (!getKey) return null;

  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: OAUTH_ISSUER,
      audience: OAUTH_AUDIENCE || undefined,
      algorithms: ["RS256", "RS384", "RS512"],
    });

    const sub = payload.sub;
    if (!sub) {
      log.warn("JWT missing sub claim");
      return null;
    }

    return await lookupUser(sub);
  } catch (err) {
    log.warn({ err }, "JWT validation failed");
    return null;
  }
};

// ── Identity resolution (JWT verify + email/name from claims) ──────────

export interface ResolvedIdentity {
  sub: string;
  email: string;
  name?: string;
}

/**
 * Verify a JWT access token and resolve the user's identity (sub + email + name)
 * from the token claims, without performing a database lookup.
 *
 * Returns null if the JWT is invalid or the email claim is missing.
 */
export const verifyAndResolveIdentity = async (
  request: Request,
): Promise<ResolvedIdentity | null> => {
  if (!OAUTH_ISSUER) return null;

  const token = extractBearerToken(request);
  if (!token) return null;

  const getKey = await getKeyFunction();
  if (!getKey) return null;

  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: OAUTH_ISSUER,
      audience: OAUTH_AUDIENCE || undefined,
      algorithms: ["RS256", "RS384", "RS512"],
    });

    const sub = payload.sub;
    if (!sub) {
      log.warn("JWT missing sub claim");
      return null;
    }

    const email = typeof payload.email === "string" ? payload.email : undefined;
    if (!email) {
      log.warn({ sub }, "JWT missing email claim");
      return null;
    }

    const name = typeof payload.name === "string" ? payload.name : undefined;

    return { sub, email, name };
  } catch (err) {
    log.warn({ err }, "JWT verification failed");
    return null;
  }
};
