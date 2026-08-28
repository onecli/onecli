import { createHmac, timingSafeEqual } from "crypto";

/**
 * Svix webhook signature verification (the scheme Resend uses), implemented
 * against the documented algorithm so no vendor SDK is needed:
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 *
 * signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with
 * the base64-decoded secret (after the `whsec_` prefix), base64 output. The
 * `svix-signature` header carries space-separated `v1,<sig>` entries — any
 * one matching (constant-time) accepts. The timestamp must sit inside the
 * tolerance window or a captured request could be replayed forever.
 */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Split a configured secret value into candidates.
 *
 * A provider issues ONE secret per endpoint, so each endpoint's variable
 * normally holds one — but during a rotation svix keeps the old secret valid
 * alongside the new one, and an endpoint being re-pointed can legitimately
 * accept either. Whitespace/comma separated, empties dropped.
 */
export const webhookSecretsFrom = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export interface SvixSignatureInput {
  /**
   * The signing secrets accepted for THIS endpoint (`whsec_…`). Per-endpoint
   * by design: a provider issues a distinct secret per endpoint, and one
   * endpoint's secret must not authenticate another's traffic.
   */
  secrets: readonly string[];
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  /** The RAW request body — verify before any JSON parse. */
  body: string;
  /** Clock override for tests. */
  nowMs?: number;
}

export const verifySvixSignature = ({
  secrets,
  id,
  timestamp,
  signature,
  body,
  nowMs,
}: SvixSignatureInput): boolean => {
  if (secrets.length === 0 || !id || !timestamp || !signature) return false;

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const skew = Math.abs((nowMs ?? Date.now()) / 1000 - seconds);
  if (skew > TOLERANCE_SECONDS) return false;

  const signedContent = `${id}.${timestamp}.${body}`;

  for (const secret of secrets) {
    let key: Buffer;
    try {
      key = Buffer.from(
        secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
        "base64",
      );
    } catch {
      continue;
    }
    if (key.length === 0) continue;

    const expected = createHmac("sha256", key).update(signedContent).digest();

    for (const entry of signature.split(" ")) {
      const [version, candidate] = entry.split(",", 2);
      if (version !== "v1" || !candidate) continue;
      let candidateBuf: Buffer;
      try {
        candidateBuf = Buffer.from(candidate, "base64");
      } catch {
        continue;
      }
      if (
        candidateBuf.length === expected.length &&
        timingSafeEqual(candidateBuf, expected)
      ) {
        return true;
      }
    }
  }
  return false;
};
