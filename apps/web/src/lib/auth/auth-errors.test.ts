import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
  redirectErrorMessage,
  SIGNUP_BLOCKED_BY_UPGRADE,
} from "./auth-errors";

/**
 * Turning a failure code into something a person can act on.
 *
 * The important property is not the wording — it is that whatever comes back
 * is a STRING. One of these lookups is keyed on a query parameter, so the key
 * is chosen by whoever wrote the link.
 */

describe("authErrorMessage", () => {
  // The one wording pin: this copy is the operator's ONLY clue when a
  // tunneled or LAN dashboard hits the origin check, and it must teach the
  // canonical var, not the legacy alias.
  it("names ONECLI_EXTERNAL_URL as the INVALID_ORIGIN fix", () => {
    expect(authErrorMessage({ code: "INVALID_ORIGIN" })).toContain(
      "ONECLI_EXTERNAL_URL",
    );
  });

  it("explains the refusals a person can do something about", () => {
    expect(authErrorMessage({ code: SIGNUP_BLOCKED_BY_UPGRADE })).toMatch(
      /finishing an upgrade/i,
    );
    expect(authErrorMessage({ code: "INVALID_EMAIL_OR_PASSWORD" })).toMatch(
      /don't match/i,
    );
  });

  it("reports rate limiting, which arrives with no code of its own", () => {
    expect(authErrorMessage({ status: 429 })).toMatch(/too many/i);
  });

  it("never shows a bare token to a person", () => {
    // better-auth echoes our refusal code as its message on the social path.
    expect(authErrorMessage({ message: "SOME_NEW_UPSTREAM_CODE" })).not.toMatch(
      /SOME_NEW_UPSTREAM_CODE/,
    );
  });

  it("passes through a genuine sentence from a code it does not know", () => {
    expect(authErrorMessage({ message: "The service is unavailable." })).toBe(
      "The service is unavailable.",
    );
  });
});

describe("redirectErrorMessage", () => {
  it("maps our own refusal", () => {
    expect(redirectErrorMessage(SIGNUP_BLOCKED_BY_UPGRADE)).toMatch(
      /finishing an upgrade/i,
    );
  });

  // The refused-social-link case: Google met an existing password account it
  // could not safely absorb. The copy must point at the password door — the
  // one that still works. Lowercase is the only spelling that exists: the
  // refusal reaches the browser solely as the `?error=` redirect token.
  it("tells a refused Google link to use the password instead", () => {
    const copy = redirectErrorMessage("account_not_linked");
    expect(copy).toMatch(/password/i);
    expect(copy).toMatch(/sign in/i);
  });

  it("returns a string for ANY key, including inherited ones", () => {
    // The key is a query parameter, so anyone can choose it. A plain object
    // would answer these from the prototype — with a function or an object,
    // which React cannot render — and a crafted link would blank the sign-in
    // screen for whoever followed it.
    for (const hostile of ["toString", "constructor", "__proto__", "valueOf"]) {
      expect(typeof redirectErrorMessage(hostile)).toBe("string");
    }
    expect(typeof redirectErrorMessage("not-a-real-code")).toBe("string");
  });
});
