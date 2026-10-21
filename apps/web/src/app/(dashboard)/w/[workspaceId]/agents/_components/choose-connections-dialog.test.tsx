// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChooseConnectionsDialog } from "./choose-connections-dialog";

const state = vi.hoisted(() => ({ counts: { apps: 1, secrets: 1 } }));
vi.mock("@/hooks/use-counts", () => ({
  useCounts: () => ({ data: state.counts }),
}));

// The rows are the agent page's own sections, with suites of their own; the
// unit here is that the window hands them THIS agent, unfolded (every row
// starts off and is the choice), and that Done just closes.
vi.mock("../[agentId]/_components/apps-section", () => ({
  AppsSection: ({
    agentId,
    foldInactive,
  }: {
    agentId: string;
    foldInactive?: boolean;
  }) => (
    <div data-testid="apps">
      apps for {agentId}, folded={String(foldInactive)}
    </div>
  ),
}));
vi.mock("../[agentId]/_components/secret-grants-tab", () => ({
  SecretGrantsTab: ({
    agentId,
    kind,
    foldInactive,
  }: {
    agentId: string;
    kind: string;
    foldInactive?: boolean;
  }) => (
    <div data-testid="custom">
      {kind} for {agentId}, folded={String(foldInactive)}
    </div>
  ),
}));

const agent = { id: "ag-1", name: "Donna" };

beforeEach(() => {
  state.counts = { apps: 1, secrets: 1 };
});

describe("ChooseConnectionsDialog", () => {
  it("offers the new agent's apps, then its custom connections, every row in view", async () => {
    render(<ChooseConnectionsDialog agent={agent} onClose={vi.fn()} />);

    expect(screen.getByText("Choose Donna's connections")).toBeInTheDocument();
    // The sections load lazily (they stay out of the agents list's bundle).
    expect(await screen.findByTestId("apps")).toHaveTextContent(
      "apps for ag-1, folded=false",
    );

    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(await screen.findByTestId("custom")).toHaveTextContent(
      "secret for ag-1, folded=false",
    );
    expect(screen.queryByTestId("apps")).toBeNull();
  });

  it("opens on Custom when the workspace has no app, and starts fresh for the next agent", async () => {
    state.counts = { apps: 0, secrets: 2 };
    const { rerender } = render(
      <ChooseConnectionsDialog agent={agent} onClose={vi.fn()} />,
    );
    expect(await screen.findByTestId("custom")).toBeInTheDocument();

    // A tab the user picks sticks while the window is open…
    await userEvent.click(screen.getByRole("button", { name: "Apps" }));
    expect(await screen.findByTestId("apps")).toBeInTheDocument();

    // …and Done resets it: the next agent opens where there is something.
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    rerender(<ChooseConnectionsDialog agent={null} onClose={vi.fn()} />);
    rerender(
      <ChooseConnectionsDialog
        agent={{ id: "ag-2", name: "Arik" }}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByTestId("custom")).toHaveTextContent("ag-2");
  });

  it("closes on Done, with nothing to submit", async () => {
    const onClose = vi.fn();
    render(<ChooseConnectionsDialog agent={agent} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays closed without an agent", () => {
    render(<ChooseConnectionsDialog agent={null} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
