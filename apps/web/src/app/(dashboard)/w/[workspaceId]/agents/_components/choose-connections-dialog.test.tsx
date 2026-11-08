// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChooseConnectionsDialog } from "./choose-connections-dialog";

const state = vi.hoisted(() => ({ counts: { apps: 1, secrets: 1 } }));
vi.mock("@/hooks/use-counts", () => ({
  useCounts: () => ({ data: state.counts }),
}));

// The tabs are the agent page's own, with suites of their own; the unit here
// is that the window hands them THIS agent in their chooser shape, and that
// Done just closes.
vi.mock("../[agentId]/_components/apps-tab", () => ({
  AppsTab: ({
    agentId,
    chooser,
    onManage,
  }: {
    agentId: string;
    chooser?: boolean;
    onManage?: unknown;
  }) => (
    <div data-testid="apps">
      apps for {agentId}, chooser={String(!!chooser)}, manage=
      {String(!!onManage)}
    </div>
  ),
}));
vi.mock("../[agentId]/_components/secret-grants-tab", () => ({
  SecretGrantsTab: ({
    agentId,
    kind,
    chooser,
    onEdit,
  }: {
    agentId: string;
    kind: string;
    chooser?: boolean;
    onEdit?: unknown;
  }) => (
    <div data-testid="custom">
      {kind} for {agentId}, chooser={String(!!chooser)}, edit=
      {String(!!onEdit)}
    </div>
  ),
}));

const agent = { id: "ag-1", name: "Donna" };

beforeEach(() => {
  state.counts = { apps: 1, secrets: 1 };
});

describe("ChooseConnectionsDialog", () => {
  it("offers the new agent's apps, then its custom connections, as switch-only tiles", async () => {
    render(<ChooseConnectionsDialog agent={agent} onClose={vi.fn()} />);

    expect(screen.getByText("Choose Donna's connections")).toBeInTheDocument();
    // The tabs load lazily (they stay out of the agents list's bundle).
    // Switch-only: no Manage and no edit door is handed in.
    expect(await screen.findByTestId("apps")).toHaveTextContent(
      "apps for ag-1, chooser=true, manage=false",
    );

    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(await screen.findByTestId("custom")).toHaveTextContent(
      "secret for ag-1, chooser=true, edit=false",
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
