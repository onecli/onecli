import { describe, expect, it } from "vitest";
import {
  IDENTIFIER_REGEX,
  createAgentSchema,
  identifierFromName,
} from "./agent";

describe("identifierFromName", () => {
  it("folds a display name onto the identifier alphabet", () => {
    expect(identifierFromName("Support Triage!")).toBe("support-triage");
    expect(identifierFromName("  Donna  ")).toBe("donna");
    expect(identifierFromName("a--b__c")).toBe("a-b-c");
  });

  it("derives to the empty string when nothing survives (the service's fallback case)", () => {
    expect(identifierFromName("✨")).toBe("");
    expect(identifierFromName("ドンナ")).toBe("");
  });

  it("always fits the identifier rule when non-empty", () => {
    for (const name of ["x".repeat(80), "-lead", "trail-", "Mixed Case 9"]) {
      const derived = identifierFromName(name);
      expect(derived).not.toBe("");
      expect(IDENTIFIER_REGEX.test(derived)).toBe(true);
    }
  });
});

describe("createAgentSchema: the identifier contract per kind", () => {
  it("requires it for a byo agent, the kind the handle was made for", () => {
    const parsed = createAgentSchema.safeParse({ name: "N" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ["identifier"],
      message: "identifier is required for byo agents",
    });
  });

  it("lets a hosted agent omit it, and still checks one that is sent", () => {
    expect(
      createAgentSchema.safeParse({ name: "N", kind: "hosted" }).success,
    ).toBe(true);
    expect(
      createAgentSchema.safeParse({
        name: "N",
        kind: "hosted",
        identifier: "Not Valid",
      }).success,
    ).toBe(false);
  });
});
