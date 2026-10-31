// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const decide = vi.hoisted(() => vi.fn());
const inFlight = vi.hoisted(() => ({
  current: undefined as { choice: string } | undefined,
}));
vi.mock("@/hooks/use-approvals", () => ({
  useDecideChannelAction: () => ({
    mutate: decide,
    isPending: inFlight.current !== undefined,
    variables: inFlight.current,
  }),
}));

const { ChooseSenderCard } = await import("./choose-sender-card");

const item = {
  kind: "action" as const,
  id: "req",
  agentId: "a",
  agentName: "Donna",
  summary: 'How should Donna message @Sam? "hi"',
  standingChoice: false,
  conversationId: "c",
  createdAt: "2026-10-27T08:00:00Z",
  expiresAt: "2026-10-28T08:00:00Z",
  customConnection: null,
  webhookChange: null,
  chooseSender: { recipientLabel: "@Sam", text: "hi", agentName: "Donna" },
};

afterEach(() => {
  vi.useRealTimers();
  decide.mockReset();
  inFlight.current = undefined;
});

describe("ChooseSenderCard", () => {
  it("the pick in flight says Sending… on its own button and holds every button", () => {
    inFlight.current = { choice: "you" };
    render(<ChooseSenderCard item={item} />);
    const sending = screen.getByRole("button", { name: "Sending…" });
    expect(sending).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "As me" })).toBeNull();
    expect(screen.getByRole("button", { name: "As Donna" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Don't send" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("asks one question with a preview; each button decides with its choice", () => {
    render(<ChooseSenderCard item={item} />);
    expect(screen.getByText("“hi”")).toBeTruthy();
    expect(screen.getByText(/You can\s+change it in Contacts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "As Donna" }));
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "approve", choice: "agent" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "As me" }));
    expect(decide).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "approve", choice: "you" }),
    );
  });

  it("Don't send collapses with an Undo that restores the card and rejects nothing", () => {
    vi.useFakeTimers();
    render(<ChooseSenderCard item={item} />);
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(decide).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "As Donna" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(decide).toHaveBeenLastCalledWith({
      approvalId: "req",
      decision: "reject",
    });
  });
});
