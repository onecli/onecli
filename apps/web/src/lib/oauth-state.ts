import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export interface OAuthStatePayload {
  accountId: string;
  provider: string;
  nonce: string;
  [key: string]: unknown;
}

const getSigningKey = (): string => {
  const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

  if (isCloud) {
    const key = process.env.OAUTH_STATE_SECRET;
    if (!key) throw new Error("OAUTH_STATE_SECRET is required in cloud");
    return key;
  }

  const key =
    process.env.OAUTH_STATE_SECRET ?? process.env.SECRET_ENCRYPTION_KEY;
  if (!key)
    throw new Error("OAUTH_STATE_SECRET or SECRET_ENCRYPTION_KEY must be set");
  return key;
};

/**
 * Sign an OAuth state payload with HMAC-SHA256 to prevent CSRF.
 * The state is base64url-encoded JSON containing both the payload and signature.
 */
export const signOAuthState = (payload: OAuthStatePayload): string => {
  const secret = getSigningKey();
  const data = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(data).digest("hex");
  return Buffer.from(JSON.stringify({ data: payload, sig })).toString(
    "base64url",
  );
};

/**
 * Verify the HMAC signature on an OAuth state parameter.
 * Returns the payload if valid, null if tampered or malformed.
 */
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
