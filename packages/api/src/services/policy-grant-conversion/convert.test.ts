import { describe, expect, it } from "vitest";
import { groupsToGrantInput } from "./convert";

// The one path the pg proofs CANNOT reach by design: a `mixed` verdict is
// impossible once network/behavioral rules are excluded from the fold (every
// remaining rule shape treats a tool's variants uniformly), so hitting one
// means an unmodeled rule shape. It must abort the project loudly — folding a
// guess would bake a wrong verdict into a grant stack.

const group = (tools: { toolId: string; verdict: string }[]) => [{ tools }];

describe("groupsToGrantInput", () => {
  it("all allow/unmanaged folds to the uncustomized whole-app attach", () => {
    expect(
      groupsToGrantInput(
        group([
          { toolId: "a", verdict: "allow" },
          { toolId: "b", verdict: "unmanaged" },
        ]),
        "agent-1",
      ),
    ).toEqual({ access: "full" });
  });

  it("any approval or block customizes with the exact A/K split", () => {
    expect(
      groupsToGrantInput(
        group([
          { toolId: "a", verdict: "allow" },
          { toolId: "k", verdict: "approval" },
          { toolId: "b", verdict: "block" },
        ]),
        "agent-1",
      ),
    ).toEqual({ access: "custom", allow: ["a"], ask: ["k"] });
  });

  it("a mixed verdict aborts loudly instead of guessing", () => {
    expect(() =>
      groupsToGrantInput(group([{ toolId: "t", verdict: "mixed" }]), "agent-1"),
    ).toThrow(/unconvertible/);
  });
});
