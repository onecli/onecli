// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The org/account-scope router. It asks only what the URL cannot answer — the
 * workspace — and must never route before it knows create-vs-chat: sending
 * someone who HAS an agent to the create form is the failure this guards.
 */

const state = vi.hoisted(() => ({
  workspaces: [] as { id: string; name: string }[],
  agents: [] as { id: string; kind: string; createdAt: string }[],
  agentsPending: false,
}));
const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-workspaces", () => ({
  useWorkspacesList: () => ({ data: state.workspaces, isPending: false }),
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgentsForWorkspace: (id: string) => ({
    data: id ? state.agents : [],
    isPending: id ? state.agentsPending : false,
  }),
}));

const { GetStartedPicker } = await import("./get-started-picker");

const hosted = (id: string) => ({
  id,
  kind: "hosted",
  createdAt: "2026-01-01T00:00:00Z",
});

// Radix's Select drives its listbox through pointer-capture and scroll APIs
// jsdom does not implement; stubbing them is what makes the component's real
// interaction path testable at all.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  state.workspaces = [];
  state.agents = [];
  state.agentsPending = false;
  mocks.push.mockClear();
});

const open = () =>
  render(<GetStartedPicker organizationId="org-1" onOpenChange={vi.fn()} />);

describe("the workspace picker", () => {
  it("never renders when there is only one workspace — it just goes", async () => {
    state.workspaces = [{ id: "w1", name: "Default" }];
    open();
    expect(screen.queryByText("Select a workspace")).toBeNull();
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/w/w1/agents?new=1"),
    );
  });

  it("opens the single workspace's existing agent rather than the create flow", async () => {
    state.workspaces = [{ id: "w1", name: "Default" }];
    state.agents = [hosted("ag-1")];
    open();
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/w/w1/agents/ag-1/chat"),
    );
  });

  it("waits for the agent read before routing — a half-loaded list must not decide", async () => {
    state.workspaces = [{ id: "w1", name: "Default" }];
    state.agentsPending = true;
    open();
    // Nothing yet: routing now would send an agent-having user to a create form.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("asks which workspace when there is a real choice", async () => {
    state.workspaces = [
      { id: "w1", name: "Default" },
      { id: "w2", name: "Other" },
    ];
    open();
    expect(screen.getByText("Select a workspace")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    // Continue is dead until a workspace is chosen.
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("routes on the explicit choice, and only when Continue is pressed", async () => {
    const user = userEvent.setup();
    state.workspaces = [
      { id: "w1", name: "Default" },
      { id: "w2", name: "Other" },
    ];
    state.agents = [hosted("ag-9")];
    open();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Other" }));

    // Picking is NOT navigating: an explicit choice must wait for Continue.
    expect(mocks.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(mocks.push).toHaveBeenCalledWith("/w/w2/agents/ag-9/chat");
  });

  it("stays closed when no org is set", () => {
    render(<GetStartedPicker organizationId={null} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Choose a workspace")).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("points at the workspaces page when the org has none", () => {
    open();
    expect(
      screen.getByRole("link", { name: "Go to workspaces" }),
    ).toHaveAttribute("href", "/org/org-1/workspaces");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
