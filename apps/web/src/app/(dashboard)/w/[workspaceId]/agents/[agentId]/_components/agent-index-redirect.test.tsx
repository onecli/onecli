// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The agent index is not a page: it forwards to the agent's first section.
// This is the client fallback for when the server can't decide.

const state = vi.hoisted(() => ({
  pathname: "/w/w1/agents/ag-1",
  agent: { id: "ag-1", kind: "hosted" } as { id: string; kind: string } | null,
}));
const mocks = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("./agent-page-frame", () => ({
  useAgentPageAgent: () => {
    if (!state.agent) throw new Error("no agent");
    return state.agent;
  },
}));

const { AgentIndexRedirect } = await import("./agent-index-redirect");

beforeEach(() => {
  state.pathname = "/w/w1/agents/ag-1";
  state.agent = { id: "ag-1", kind: "hosted" };
  mocks.replace.mockClear();
});

describe("the agent index redirect", () => {
  it("forwards a hosted agent to Chat", async () => {
    render(<AgentIndexRedirect />);
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/w/w1/agents/ag-1/chat"),
    );
  });

  it("forwards a BYO agent to Connections — it has no Chat", async () => {
    state.agent = { id: "ag-1", kind: "byo" };
    render(<AgentIndexRedirect />);
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith(
        "/w/w1/agents/ag-1/connections",
      ),
    );
  });

  it("forwards from a trailing-slash index too", async () => {
    state.pathname = "/w/w1/agents/ag-1/";
    render(<AgentIndexRedirect />);
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/w/w1/agents/ag-1/chat"),
    );
  });

  it("forwards again when the agent changes under an already-mounted index", async () => {
    const view = render(<AgentIndexRedirect />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));

    // Switching agents from the breadcrumb lands on the NEW agent's index
    // without remounting this component.
    mocks.replace.mockClear();
    state.pathname = "/w/w1/agents/ag-2";
    state.agent = { id: "ag-2", kind: "byo" };
    view.rerender(<AgentIndexRedirect />);

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith(
        "/w/w1/agents/ag-2/connections",
      ),
    );
  });
});
