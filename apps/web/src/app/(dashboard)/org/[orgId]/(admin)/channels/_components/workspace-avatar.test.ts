import { describe, expect, it } from "vitest";
import { workspaceInitials } from "./workspace-avatar";

/**
 * The avatar stands in for a workspace icon we cannot fetch (see the
 * component), so its initials are the only thing distinguishing one
 * connected workspace from another — including the one-word case that a
 * naive "first letter of each word" gets wrong.
 */
describe("workspaceInitials", () => {
  it("takes two characters from a one-word name", () => {
    expect(workspaceInitials("OneCLI")).toBe("ON");
  });

  it("takes the first letter of each word when there are several", () => {
    expect(workspaceInitials("Acme Corp")).toBe("AC");
  });

  it("stops at two letters for a long name", () => {
    expect(workspaceInitials("Very Big Company Name")).toBe("VB");
  });

  it("falls back rather than rendering empty", () => {
    expect(workspaceInitials("   ")).toBe("?");
  });

  it("survives a Slack team id standing in for a missing name", () => {
    expect(workspaceInitials("T0TESTTEAM1")).toBe("T0");
  });
});
