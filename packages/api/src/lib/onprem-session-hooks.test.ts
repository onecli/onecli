import { describe, expect, it } from "vitest";
import { onpremSessionHooks } from "./onprem-session-hooks";

/**
 * The self-hosted session policy.
 *
 * Provisioning is keyed on "this user has no organization" rather than "this
 * request created them", which makes it self-healing. The one exception is the
 * invited signup: they are joining someone else's organization, and giving
 * them their own first would leave one signup owning two.
 */
const request = (url: string) => new Request(url);
const SESSION = "http://localhost:10256/v1/auth/session";

describe("onprem shouldBootstrapOrg", () => {
  it("provisions an organic signup", () => {
    expect(
      onpremSessionHooks.shouldBootstrapOrg?.(request(SESSION), {
        isNewUser: true,
      }),
    ).toBe(true);
  });

  it("provisions an EXISTING user who has none (the self-healing property)", () => {
    // The identity layer creates the row during sign-in, so by the time this
    // runs the user always pre-exists. Requiring "this request created them"
    // would mean a signup whose provisioning failed could never be repaired.
    expect(
      onpremSessionHooks.shouldBootstrapOrg?.(request(SESSION), {
        isNewUser: false,
      }),
    ).toBe(true);
  });

  it("does NOT provision someone arriving through an invitation", () => {
    // They are about to join an existing organization. Bootstrapping first
    // would hand them a personal one they never asked for.
    expect(
      onpremSessionHooks.shouldBootstrapOrg?.(
        request(`${SESSION}?fromInvitation=1`),
        { isNewUser: true },
      ),
    ).toBe(false);
  });
});
