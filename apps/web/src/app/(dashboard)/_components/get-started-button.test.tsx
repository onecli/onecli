// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The header's Chat button is the earliest sign a person is heading for the
// agent: a hover or a focus warms its machine (once; the hook dedupes), and
// the click lands where it always did. Only a hosted agent has a machine.

const state = vi.hoisted(() => ({
  pathname: "/w/ws-1/overview",
  agents: [] as { id: string; name: string; kind: string; createdAt: string }[],
}));
const mocks = vi.hoisted(() => ({ push: vi.fn(), warm: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => state.pathname,
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: state.agents }),
  useWarmAgent: () => mocks.warm,
}));
vi.mock("./get-started-picker", () => ({ GetStartedPicker: () => null }));

const { GetStartedButton } = await import("./get-started-button");

const agent = (kind: "hosted" | "byo") => ({
  id: `ag-${kind}`,
  name: "Donna",
  kind,
  createdAt: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  mocks.push.mockClear();
  mocks.warm.mockClear();
  state.agents = [];
});

describe("GetStartedButton", () => {
  it("warms the existing hosted agent on hover and on focus, then opens its chat on click", () => {
    state.agents = [agent("hosted")];
    render(<GetStartedButton />);
    const button = screen.getByRole("button", { name: /chat/i });

    fireEvent.mouseEnter(button);
    fireEvent.focus(button);
    expect(mocks.warm).toHaveBeenCalledTimes(2);
    expect(mocks.warm).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ag-hosted", kind: "hosted" }),
    );

    fireEvent.click(button);
    expect(mocks.push).toHaveBeenCalledWith("/w/ws-1/agents/ag-hosted/chat");
  });

  it("has nothing to warm with no hosted agent: the hint gets `undefined`", () => {
    state.agents = [agent("byo")];
    render(<GetStartedButton />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /create agent/i }));
    expect(mocks.warm).toHaveBeenCalledWith(undefined);
  });
});
