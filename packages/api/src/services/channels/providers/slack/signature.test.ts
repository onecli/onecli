import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "./signature";

/**
 * The Slack `v0=` request-signature check — the trust boundary of the repo's
 * first free inbound webhook surface. Pure, so every arm is pinned directly:
 * the HMAC itself, the replay window, and the constant-time compare's
 * length precondition each have a test that fails if that guard is deleted.
 */

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_700_000_000;

/** A correctly signed request, exactly as Slack would send it. */
const sign = (secret: string, timestamp: string, body: string): string =>
  `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;

const valid = (
  overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {},
) => {
  const rawBody = '{"type":"event_callback","event":{"type":"message"}}';
  const timestamp = String(NOW);
  return {
    signingSecret: SECRET,
    timestamp,
    signature: sign(SECRET, timestamp, rawBody),
    rawBody,
    nowSeconds: NOW,
    ...overrides,
  };
};

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verifySlackSignature(valid())).toBe(true);
  });

  it("rejects a signature made with the WRONG secret", () => {
    const rawBody = '{"type":"event_callback"}';
    const timestamp = String(NOW);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        signature: sign("some-other-apps-secret-entirely", timestamp, rawBody),
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a TAMPERED body under an otherwise valid signature", () => {
    const good = valid();
    expect(
      verifySlackSignature({
        ...good,
        rawBody: good.rawBody.replace("message", "massage"),
      }),
    ).toBe(false);
  });

  it("rejects a body that was re-serialized (whitespace differs)", () => {
    // The signature covers the RAW bytes: parse-then-reserialize output must
    // fail even though it is semantically the same JSON.
    const good = valid();
    expect(
      verifySlackSignature({
        ...good,
        rawBody: good.rawBody.replace(":", ": "),
      }),
    ).toBe(false);
  });

  it("rejects a request missing the timestamp header", () => {
    expect(verifySlackSignature(valid({ timestamp: undefined }))).toBe(false);
  });

  it("rejects a request missing the signature header", () => {
    expect(verifySlackSignature(valid({ signature: undefined }))).toBe(false);
  });

  it("rejects an empty-string timestamp or signature", () => {
    expect(verifySlackSignature(valid({ timestamp: "" }))).toBe(false);
    expect(verifySlackSignature(valid({ signature: "" }))).toBe(false);
  });

  describe("the replay window (guard: deleting the window check fails these)", () => {
    // Each stale case carries a CORRECT signature over its own timestamp, so
    // the HMAC arm alone would accept it — only the window check refuses it.
    // MUTATION-TESTED: delete the `Math.abs(now - ts) > REPLAY_WINDOW_SECONDS`
    // check and both stale-direction tests below go green-signature and FAIL.
    const signedAt = (ts: number) => {
      const rawBody = '{"replayed":true}';
      return {
        signingSecret: SECRET,
        timestamp: String(ts),
        signature: sign(SECRET, String(ts), rawBody),
        rawBody,
        nowSeconds: NOW,
      };
    };

    it("rejects a correctly signed request older than 5 minutes", () => {
      expect(verifySlackSignature(signedAt(NOW - 5 * 60 - 1))).toBe(false);
    });

    it("rejects a correctly signed request from more than 5 minutes in the FUTURE", () => {
      expect(verifySlackSignature(signedAt(NOW + 5 * 60 + 1))).toBe(false);
    });

    it("accepts a request exactly at the window edge, either direction", () => {
      // Pins the boundary as `>` (Slack's own documented 5 minutes), so a
      // mutation tightening or loosening the comparison is caught.
      expect(verifySlackSignature(signedAt(NOW - 5 * 60))).toBe(true);
      expect(verifySlackSignature(signedAt(NOW + 5 * 60))).toBe(true);
    });

    it("rejects a NON-NUMERIC timestamp before any crypto", () => {
      // `Number("not-a-ts")` is NaN; without the isFinite guard the window
      // comparison is false for NaN and the request would fall through to
      // the HMAC over the junk timestamp string.
      expect(verifySlackSignature(valid({ timestamp: "not-a-ts" }))).toBe(
        false,
      );
    });

    it("rejects an Infinity timestamp (Number('Infinity') is finite-check bait)", () => {
      expect(verifySlackSignature(valid({ timestamp: "Infinity" }))).toBe(
        false,
      );
    });
  });

  describe("the constant-time compare", () => {
    it("rejects an equal-length wrong signature (the timingSafeEqual path)", () => {
      // Same length as the real `v0=` + 64 hex chars, so the comparison runs
      // all the way through timingSafeEqual rather than the length check.
      const good = valid();
      const wrong = `v0=${"ab".repeat(32)}`;
      expect(wrong.length).toBe(good.signature.length);
      expect(verifySlackSignature(valid({ signature: wrong }))).toBe(false);
    });

    it("returns false — not a throw — for a shorter signature", () => {
      // MUTATION-TESTED: the length check exists because `timingSafeEqual`
      // THROWS on unequal-length buffers. Delete the `a.length === b.length`
      // guard and this test fails with a RangeError instead of `false` —
      // which in production is a 500 an attacker can trigger at will.
      expect(verifySlackSignature(valid({ signature: "v0=abc" }))).toBe(false);
    });

    it("returns false — not a throw — for a longer signature", () => {
      const good = valid();
      expect(
        verifySlackSignature(valid({ signature: `${good.signature}00` })),
      ).toBe(false);
    });
  });
});
