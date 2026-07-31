import { describe, expect, it, vi } from "vitest";

// buildOnePasswordMetadata doesn't touch the DB; stub it so importing the
// module doesn't pull in a real Prisma client.
vi.mock("@onecli/db", () => ({ db: {}, Prisma: { JsonNull: Symbol("null") } }));

import { buildOnePasswordMetadata } from "./secret-service";

// Regression for onecli/onecli#387: a 1Password-sourced anthropic secret has
// no value the server can inspect, so `authMode` used to be hardcoded to
// "api-key" no matter what was actually stored — container-config then always
// emitted ANTHROPIC_API_KEY, so OAuth injection silently never fired.
describe("buildOnePasswordMetadata", () => {
  it("uses the caller-supplied authMode for an anthropic secret", () => {
    expect(buildOnePasswordMetadata("anthropic", undefined, "oauth")).toEqual({
      authMode: "oauth",
    });
  });

  it("defaults an anthropic secret to api-key when authMode is omitted", () => {
    expect(buildOnePasswordMetadata("anthropic", undefined, undefined)).toEqual(
      { authMode: "api-key" },
    );
  });

  it("still hardcodes api-key for openai (no 1Password OAuth path)", () => {
    expect(buildOnePasswordMetadata("openai", undefined, "oauth")).toEqual({
      authMode: "api-key",
    });
  });

  it("carries opDisplay through alongside authMode", () => {
    const opDisplay = { vault: "V", item: "I", field: "F" };
    expect(buildOnePasswordMetadata("anthropic", opDisplay, "oauth")).toEqual({
      authMode: "oauth",
      opDisplay,
    });
  });
});
