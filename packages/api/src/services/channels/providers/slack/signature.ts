import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request-signature verification (`v0=` scheme) for the inbound events
 * and interactivity routes — the trust boundary of the repo's first free
 * inbound webhook surface.
 *
 * The signature is HMAC-SHA256 over `v0:{timestamp}:{raw body}` with the
 * app's signing secret, so verification MUST see the raw body bytes exactly
 * as sent — parse-then-reserialize breaks it (the Stripe-webhook discipline).
 * The timestamp bounds replay: a captured request is only replayable inside
 * the window, and the window is small because there is no nonce store.
 */

/** Slack's own documented replay window. */
const REPLAY_WINDOW_SECONDS = 60 * 5;

export interface SlackSignatureInput {
  signingSecret: string;
  /** The `X-Slack-Request-Timestamp` header, as received. */
  timestamp: string | undefined;
  /** The `X-Slack-Signature` header, as received (`v0=<hex>`). */
  signature: string | undefined;
  /** The EXACT raw request body. */
  rawBody: string;
  /** Injectable clock for tests. */
  nowSeconds?: number;
}

export const verifySlackSignature = ({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  nowSeconds,
}: SlackSignatureInput): boolean => {
  if (!timestamp || !signature) return false;

  // Reject non-numeric and out-of-window timestamps BEFORE any crypto: the
  // replay window is part of what is being verified, not a nicety after it.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) return false;

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  // Constant-time compare (the `oauth-state.ts` discipline). Length check
  // first because `timingSafeEqual` throws on unequal lengths.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
