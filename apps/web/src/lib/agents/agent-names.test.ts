import { describe, expect, it } from "vitest";
import { validateDisplayName } from "@onecli/api/validations/display-name";
import { nameToIdentifier } from "@/lib/agents/agent-identifier";
import { AGENT_NAMES, randomAgentName } from "./agent-names";

describe("agent names", () => {
  it("has 50 distinct names", () => {
    expect(AGENT_NAMES).toHaveLength(50);
    expect(new Set(AGENT_NAMES.map((n) => n.toLowerCase())).size).toBe(50);
  });

  it("every name is a valid agent name with a clean identifier", () => {
    for (const name of AGENT_NAMES) {
      expect(validateDisplayName(name), name).toBeNull();
      expect(nameToIdentifier(name), name).toBe(name.toLowerCase());
    }
  });

  it("never repeats the current name, so shuffle always changes it", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomAgentName([], "Jarvis")).not.toBe("Jarvis");
    }
  });

  it("skips names already used in the workspace, case-insensitively", () => {
    const taken = AGENT_NAMES.filter((n) => n !== "Alfred").map((n) =>
      n.toUpperCase(),
    );
    expect(randomAgentName(taken)).toBe("Alfred");
  });

  it("still returns a name when every one is taken", () => {
    expect(AGENT_NAMES).toContain(randomAgentName(AGENT_NAMES));
  });
});
