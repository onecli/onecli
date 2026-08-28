import { describe, expect, it } from "vitest";
import { parseCognitoIdentityClaims } from "./cognito-identity";

describe("parseCognitoIdentityClaims", () => {
  it("collects every providerName in token order", () => {
    expect(
      parseCognitoIdentityClaims({
        identities: [
          { providerName: "Google", userId: "115" },
          { providerName: "org-abc", userId: "sub" },
        ],
        email_verified: "true",
      }),
    ).toEqual({
      identityProviders: ["Google", "org-abc"],
      federatedProvider: "Google",
      emailVerified: true,
    });
  });

  it("handles native sessions and malformed claims", () => {
    expect(parseCognitoIdentityClaims({ email_verified: true })).toEqual({
      identityProviders: [],
      federatedProvider: null,
      emailVerified: true,
    });
    expect(
      parseCognitoIdentityClaims({
        identities: [{ providerName: "" }, { userId: "x" }, "junk"],
        email_verified: "false",
      }),
    ).toEqual({
      identityProviders: [],
      federatedProvider: null,
      emailVerified: false,
    });
  });
});
