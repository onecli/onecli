import { OAUTH_STATE_SECRET, SECRET_ENCRYPTION_KEY } from "../../lib/env";

// PKCE (RFC 7636, S256) without a cross-request store: the verifier is an HMAC
// of the signed OAuth state under the server's signing key, so the authorize
// leg and the callback derive the same value on any instance. node:crypto
// loads lazily because app definitions ride the client-reachable registry,
// whose module graph must stay free of Node builtins.

/** The PKCE code verifier bound to one signed OAuth state. */
export const pkceVerifier = async (state: string): Promise<string> => {
  const key = OAUTH_STATE_SECRET || SECRET_ENCRYPTION_KEY;
  if (!key) throw new Error("OAuth signing secret is required");
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", key).update(`pkce:${state}`).digest("base64url");
};

/** The S256 code challenge for a verifier. */
export const pkceChallenge = async (verifier: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(verifier).digest("base64url");
};
