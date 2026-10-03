// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyThreadWelcome } from "./empty-thread-welcome";

// The connect card pulls live queries of its own; this unit's contract is
// WHAT THE COPY CLAIMS, so the card is stubbed.
vi.mock("./greeting-connect-card", () => ({
  GreetingConnectCard: () => <div data-testid="connect-card" />,
}));

const { useAgentModels } = vi.hoisted(() => ({ useAgentModels: vi.fn() }));
vi.mock("@/hooks/use-agents", () => ({ useAgentModels }));

afterEach(() => {
  cleanup();
  useAgentModels.mockReset();
});

const renderWelcome = () =>
  render(<EmptyThreadWelcome agentId="agent-1" agentName="Donna" />);

describe("<EmptyThreadWelcome />", () => {
  it("is the PRODUCT's voice, not the agent's — never a message bubble", () => {
    // The whole reason this exists: the replaced code wrote a pre-baked
    // "done" turn, which put words the agent never said inside the agent's
    // own bubble. This is a page, and it names the agent in the third
    // person rather than speaking as it.
    useAgentModels.mockReturnValue({ data: undefined });
    renderWelcome();
    expect(screen.getByText(/Donna is ready when you are/)).toBeTruthy();
  });

  it("names the next step when the agent has no model key", () => {
    useAgentModels.mockReturnValue({ data: { provider: null } });
    renderWelcome();
    expect(screen.getByText(/Connect a model key/)).toBeTruthy();
  });

  it("does NOT ask for a key when the agent already has one", () => {
    // A keyed agent's empty thread is simply new (its greeting may still be
    // in flight). Telling that person to connect a key would be false.
    useAgentModels.mockReturnValue({ data: { provider: "anthropic" } });
    renderWelcome();
    expect(screen.queryByText(/Connect a model key/)).toBeNull();
    expect(screen.getByText(/Say hello/)).toBeTruthy();
  });

  it("claims neither while the model query is unresolved", () => {
    useAgentModels.mockReturnValue({ data: undefined });
    renderWelcome();
    expect(screen.queryByText(/Connect a model key/)).toBeNull();
  });

  it("offers the same first-connection picks either way", () => {
    useAgentModels.mockReturnValue({ data: { provider: null } });
    renderWelcome();
    expect(screen.getByTestId("connect-card")).toBeTruthy();
  });
});
