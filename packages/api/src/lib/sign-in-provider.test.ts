import { describe, expect, it } from "vitest";
import { recordableSignInProvider } from "./sign-in-provider";

describe("recordableSignInProvider", () => {
  it("records Google from the federated provider", () => {
    expect(recordableSignInProvider({ federatedProvider: "Google" })).toBe(
      "Google",
    );
  });

  it("records Google wherever it appears among the identities", () => {
    expect(
      recordableSignInProvider({
        federatedProvider: "org-acme",
        identityProviders: ["org-acme", "Google"],
      }),
    ).toBe("Google");
  });

  it("leaves the stored value alone for a native email sign-in", () => {
    // `undefined`, never `null`: an email-code login by someone who also
    // signs in with Google must not erase what the Google login proved.
    expect(recordableSignInProvider({})).toBeUndefined();
    expect(
      recordableSignInProvider({
        federatedProvider: null,
        identityProviders: [],
      }),
    ).toBeUndefined();
  });

  it("does not record other providers (only Google lifts the trial-credit rule)", () => {
    expect(
      recordableSignInProvider({
        federatedProvider: "org-acme",
        identityProviders: ["org-acme"],
      }),
    ).toBeUndefined();
  });

  it("is case-sensitive, as Cognito names the provider exactly 'Google'", () => {
    expect(recordableSignInProvider({ federatedProvider: "google" })).toBe(
      undefined,
    );
  });
});
