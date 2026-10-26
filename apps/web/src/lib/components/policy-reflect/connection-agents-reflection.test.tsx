// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveAgentEntry } from "@/lib/api/policy-visibility";
import { ConnectionAgentsReflection } from "./connection-agents-reflection";

/**
 * The post-connect window's copy states what is true now: a workspace
 * connect starts off for every agent, while one that came through an agent's
 * connect link already has that agent on, so it must not claim otherwise.
 */

const state = vi.hoisted(() => ({
  agents: [] as EffectiveAgentEntry[],
  granted: [] as string[],
}));

vi.mock("@/lib/api/policy-visibility", () => ({
  useConnectionEffectiveAgents: () => ({
    data: { catalog: true, agents: state.agents },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
}));
vi.mock("@/hooks/use-grants", () => ({
  useConnectionGrants: () => ({
    data: { agents: state.granted.map((agentId) => ({ agentId })) },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
}));
// Each row has its own suite; only the window's copy is under test here.
vi.mock("./connection-agent-access-row", () => ({
  ConnectionAgentAccessRow: ({ agent }: { agent: EffectiveAgentEntry }) => (
    <div>{agent.name}</div>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/connections",
}));

const agent = (agentId: string, name: string): EffectiveAgentEntry => ({
  agentId,
  name,
  access: "none",
  credential: { status: "none" },
  decisions: null,
});

const renderWindow = () =>
  render(
    <ConnectionAgentsReflection
      connectionId="conn-1"
      appName="Resend"
      open
      onOpenChange={vi.fn()}
    />,
  );

describe("ConnectionAgentsReflection copy", () => {
  beforeEach(() => {
    state.agents = [agent("a1", "Alpha"), agent("a2", "Beta")];
    state.granted = [];
  });

  it("says it is off for every agent after a workspace connect", () => {
    renderWindow();
    expect(screen.getByText("Resend connected")).toBeInTheDocument();
    expect(screen.getByText(/It's off for every agent/)).toBeInTheDocument();
  });

  it("never claims everyone is off when the connecting agent is already on", () => {
    state.granted = ["a2"];
    renderWindow();
    expect(screen.queryByText(/It's off for every agent/)).toBeNull();
    expect(
      screen.getByText(/Choose which agents can use it/),
    ).toBeInTheDocument();
  });
});
