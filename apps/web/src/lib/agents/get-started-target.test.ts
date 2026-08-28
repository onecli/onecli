import { describe, expect, it } from "vitest";
import {
  firstHostedAgent,
  getStartedPath,
  type GetStartedAgent,
} from "./get-started-target";

const agent = (
  id: string,
  kind: string,
  createdAt: string | Date,
): GetStartedAgent => ({ id, name: id, kind, createdAt });

describe("firstHostedAgent", () => {
  it("is the OLDEST hosted agent, so the target doesn't move as more are added", () => {
    const agents = [
      agent("newer", "hosted", "2026-03-01T00:00:00Z"),
      agent("oldest", "hosted", "2026-01-01T00:00:00Z"),
      agent("middle", "hosted", "2026-02-01T00:00:00Z"),
    ];
    expect(firstHostedAgent(agents)?.id).toBe("oldest");
  });

  it("ignores BYO agents — a token for a laptop has no thread to open", () => {
    const agents = [
      agent("byo", "byo", "2026-01-01T00:00:00Z"),
      agent("hosted", "hosted", "2026-02-01T00:00:00Z"),
    ];
    expect(firstHostedAgent(agents)?.id).toBe("hosted");
  });

  it("is undefined when only BYO agents exist", () => {
    expect(
      firstHostedAgent([agent("byo", "byo", "2026-01-01T00:00:00Z")]),
    ).toBe(undefined);
  });

  it("orders Date-valued reads too (the server action's shape)", () => {
    const agents = [
      agent("newer", "hosted", new Date("2026-03-01T00:00:00Z")),
      agent("oldest", "hosted", new Date("2026-01-01T00:00:00Z")),
    ];
    expect(firstHostedAgent(agents)?.id).toBe("oldest");
  });
});

describe("getStartedPath", () => {
  it("opens the existing agent's chat — the agent IS the thread", () => {
    const agents = [agent("ag-1", "hosted", "2026-01-01T00:00:00Z")];
    expect(getStartedPath("w1", agents)).toBe("/w/w1/agents/ag-1/chat");
  });

  it("falls back to the create flow when there is nothing to talk to", () => {
    expect(getStartedPath("w1", [])).toBe("/w/w1/agents?new=1");
    expect(
      getStartedPath("w1", [agent("b", "byo", "2026-01-01T00:00:00Z")]),
    ).toBe("/w/w1/agents?new=1");
  });

  it("encodes both ids so a crafted value can't splice extra segments", () => {
    const agents = [agent("a/b", "hosted", "2026-01-01T00:00:00Z")];
    expect(getStartedPath("w/1", agents)).toBe("/w/w%2F1/agents/a%2Fb/chat");
  });
});
