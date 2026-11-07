import { describe, expect, it } from "vitest";
import { accountTypeLabel } from "./account-type-label";

describe("accountTypeLabel", () => {
  it("names the vendor so it never reads as a OneCLI organization", () => {
    expect(accountTypeLabel("Organization")).toBe("GitHub organization");
    expect(accountTypeLabel("User")).toBe("GitHub user");
  });

  it("passes anything else through, and nothing stays nothing", () => {
    expect(accountTypeLabel("Bot")).toBe("Bot");
    expect(accountTypeLabel(null)).toBeUndefined();
    expect(accountTypeLabel(undefined)).toBeUndefined();
  });
});
