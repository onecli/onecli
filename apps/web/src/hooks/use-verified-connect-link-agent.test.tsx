// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useVerifiedConnectLinkAgent } from "./use-verified-connect-link-agent";

/**
 * A connect link's agent is SHOWN as the workspace's own record for its id:
 * a hand-edited link can't say one agent is asking while the connect turns
 * the account on for another.
 */

const state = vi.hoisted(() => ({
  agents: [
    { id: "ag-1", name: "Mail Bot" },
    { id: "ag-2", name: "Support" },
  ] as { id: string; name: string }[] | undefined,
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: state.agents }),
}));

const verify = (agent: Parameters<typeof useVerifiedConnectLinkAgent>[0]) =>
  renderHook(() => useVerifiedConnectLinkAgent(agent)).result.current;

describe("useVerifiedConnectLinkAgent", () => {
  it("shows the workspace's name for the id, never the link's", () => {
    expect(verify({ name: "Safe Bot", id: "ag-2" })).toEqual({
      id: "ag-2",
      name: "Support",
    });
  });

  it("names no agent for an id the workspace doesn't have", () => {
    expect(verify({ name: "Ghost", id: "not-ours" })).toBeUndefined();
  });

  it("keeps the id under a neutral name while the agents load, so an early click still connects for it", () => {
    const loaded = state.agents;
    state.agents = undefined;
    try {
      expect(verify({ name: "Safe Bot", id: "ag-2" })).toEqual({
        id: "ag-2",
        name: "your agent",
      });
    } finally {
      state.agents = loaded;
    }
  });

  it("keeps a legacy link's name when it carries no id (it turns nothing on)", () => {
    expect(verify({ name: "Old Bot" })).toEqual({ name: "Old Bot" });
    expect(verify(undefined)).toBeUndefined();
  });
});
