import { describe, expect, it } from "vitest";
import { agentHue, agentInitials, agentSquareStyle } from "./agent-square";

describe("agentInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(agentInitials("Research assistant")).toBe("RA");
    expect(agentInitials("ops-bot")).toBe("OB");
    expect(agentInitials("  Sales   Desk  Helper ")).toBe("SD");
  });

  it("takes two letters of a single word", () => {
    expect(agentInitials("Atlas")).toBe("AT");
    expect(agentInitials("x")).toBe("X");
  });

  it("falls back on a blank name", () => {
    expect(agentInitials("   ")).toBe("?");
  });
});

describe("agentHue", () => {
  it("is stable and within the colour wheel", () => {
    expect(agentHue("Research assistant")).toBe(agentHue("Research assistant"));
    expect(agentHue("Atlas")).not.toBe(agentHue("Research assistant"));
    for (const name of ["a", "Atlas", "Research assistant", "ops-bot"]) {
      const hue = agentHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("feeds an oklch background", () => {
    expect(agentSquareStyle("Atlas").backgroundColor).toMatch(
      /^oklch\(0\.58 0\.11 \d+\)$/,
    );
  });
});
