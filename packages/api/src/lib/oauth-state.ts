import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  IS_CLOUD,
  NODE_ENV,
  OAUTH_STATE_SECRET,
  SECRET_ENCRYPTION_KEY,
} from "./env";

export interface OAuthStatePayload {
  workspaceId?: string;
  provider: string;
  nonce: string;
  [key: string]: unknown;
}

const getSigningKey = (): string => {
  if (IS_CLOUD) {
    if (!OAUTH_STATE_SECRET)
      throw new Error("OAUTH_STATE_SECRET is required in cloud");
    return OAUTH_STATE_SECRET;
  }

  const key = OAUTH_STATE_SECRET || SECRET_ENCRYPTION_KEY;
  if (!key)
    throw new Error("OAUTH_STATE_SECRET or SECRET_ENCRYPTION_KEY must be set");
  return key;
};

export const signOAuthState = (payload: OAuthStatePayload): string => {
  const secret = getSigningKey();
  const data = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(data).digest("hex");
  return Buffer.from(JSON.stringify({ data: payload, sig })).toString(
    "base64url",
  );
};

export const verifyOAuthState = (raw: string): OAuthStatePayload | null => {
  try {
    const secret = getSigningKey();

    const { data, sig } = JSON.parse(
      Buffer.from(raw, "base64url").toString(),
    ) as { data: OAuthStatePayload; sig: string };

    const expected = createHmac("sha256", secret)
      .update(JSON.stringify(data))
      .digest("hex");

    const sigBuf = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");

    if (
      sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
};

export const generateNonce = (): string => randomBytes(16).toString("hex");

/** Cookie carrying this browser's OAuth state on the callback path. */
export const OAUTH_STATE_COOKIE = "oauth_state";

/**
 * Options for {@link OAUTH_STATE_COOKIE}, scoped to the exact callback path.
 * `Lax` so the provider's top-level redirect back still carries it.
 */
export const oauthStateCookieOptions = (path: string) => ({
  httpOnly: true,
  secure: NODE_ENV === "production",
  sameSite: "Lax" as const,
  path,
  maxAge: 600,
});
