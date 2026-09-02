import { createHmac, timingSafeEqual } from "crypto";

/**
 * The signing key, resolved at CALL time (not module load: the fail-closed
 * arm must be testable, and a long-lived process should honor the env it
 * started with).
 *
 * `UNSUBSCRIBE_TOKEN_SECRET` wins when set. Otherwise the key is DERIVED
 * from the deployment's encryption key with domain separation — every
 * deployment that can encrypt secrets can therefore sign unsubscribe links,
 * so no deployment silently loses its RFC 8058 one-click headers for want
 * of one more provisioned variable, and the raw encryption key never leaves
 * this function. Only a deployment with neither value fails closed.
 */
const tokenSecret = () => {
  const explicit = (process.env.UNSUBSCRIBE_TOKEN_SECRET ?? "").trim();
  if (explicit) return explicit;
  const base = (process.env.SECRET_ENCRYPTION_KEY ?? "").trim();
  if (!base) return "";
  return createHmac("sha256", base)
    .update("onecli:unsubscribe-token:v1")
    .digest("hex");
};

// FAIL-CLOSED on an empty secret, both sides: an HMAC keyed by "" is
// computable by anyone, so minting would hand out forgeable links and
// verifying would accept them — no token beats a forgeable token.
export const createUnsubscribeToken = (email: string): string | null => {
  const secret = tokenSecret();
  if (!secret) return null;
  const payload = Buffer.from(email).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
};

export const verifyUnsubscribeToken = (token: string): string | null => {
  const secret = tokenSecret();
  if (!secret) return null;
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;

  const payload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
  } catch {
    return null;
  }

  try {
    return Buffer.from(payload, "base64url").toString();
  } catch {
    return null;
  }
};
