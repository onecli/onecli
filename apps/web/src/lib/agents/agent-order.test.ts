import { describe, expect, it } from "vitest";
import { sortAgentsOldestFirst, workspaceLandingPath } from "./agent-order";

describe("sortAgentsOldestFirst", () => {
  it("orders oldest first without mutating the input", () => {
    const input = [
      { id: "c", createdAt: "2026-10-03T00:00:00Z" },
      { id: "a", createdAt: "2026-10-01T00:00:00Z" },
      { id: "b", createdAt: new Date("2026-10-02T00:00:00Z") },
    ];
    expect(sortAgentsOldestFirst(input).map((a) => a.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(input.map((a) => a.id)).toEqual(["c", "a", "b"]);
  });

  it("breaks same-instant ties on id, matching the server's order", () => {
    const at = "2026-10-01T00:00:00Z";
    expect(
      sortAgentsOldestFirst([
        { id: "z", createdAt: at },
        { id: "m", createdAt: at },
      ]).map((a) => a.id),
    ).toEqual(["m", "z"]);
  });
});

describe("workspaceLandingPath", () => {
  it("lands a hosted agent on Chat and a BYO agent on Connections", () => {
    expect(workspaceLandingPath("ws1", { id: "a1", kind: "hosted" })).toBe(
      "/w/ws1/agents/a1/chat",
    );
    expect(workspaceLandingPath("ws1", { id: "a2", kind: "byo" })).toBe(
      "/w/ws1/agents/a2/connections",
    );
  });

  it("lands on the agents page (agent creation) when the workspace has no agent", () => {
    expect(workspaceLandingPath("ws1", null)).toBe("/w/ws1/agents");
  });
});
