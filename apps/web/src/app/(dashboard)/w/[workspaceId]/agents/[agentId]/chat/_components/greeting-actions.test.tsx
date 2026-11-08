// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GreetingActions } from "./greeting-actions";

// The card pulls live queries of its own; this unit's contract is the
// card's VARIANT and the picker door, so both are stubbed.
vi.mock("./greeting-connect-card", () => ({
  GreetingConnectCard: ({ variant }: { variant: string }) => (
    <div data-testid="connect-card" data-variant={variant} />
  ),
}));
vi.mock("../../_components/connect-app-picker-dialog", () => ({
  ConnectAppPickerDialog: ({
    agentId,
    open,
  }: {
    agentId: string;
    open: boolean;
  }) => <div data-testid="picker" data-agent={agentId} data-open={open} />,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "ag-1" }),
}));

afterEach(cleanup);

describe("<GreetingActions />", () => {
  it("offers the greeting's bare Gmail row", () => {
    render(<GreetingActions />);
    expect(screen.getByTestId("connect-card")).toHaveAttribute(
      "data-variant",
      "greeting",
    );
  });

  it("opens the app picker in place, without leaving the chat", () => {
    render(<GreetingActions />);
    expect(screen.queryByTestId("picker")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Add different tools" }),
    );
    expect(screen.getByTestId("picker")).toHaveAttribute("data-agent", "ag-1");
    expect(screen.getByTestId("picker")).toHaveAttribute("data-open", "true");
  });
});
