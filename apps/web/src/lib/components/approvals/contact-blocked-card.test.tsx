// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const decide = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-approvals", () => ({
  useDecideChannelAction: () => ({ mutate: decide, isPending: false }),
}));

const { ContactBlockedCard } = await import("./contact-blocked-card");

const item = {
  kind: "action" as const,
  id: "req",
  agentId: "a",
  agentName: "Donna",
  summary: "Let Donna message Sam?",
  standingChoice: false,
  conversationId: "c",
  createdAt: "2026-10-27T08:00:00Z",
  expiresAt: "2026-10-28T08:00:00Z",
  customConnection: null,
  webhookChange: null,
  contactBlocked: { recipientLabel: "Sam" },
};

afterEach(() => {
  vi.useRealTimers();
  decide.mockReset();
});

describe("ContactBlockedCard", () => {
  it("Allow approves with the allow choice; no Allow once / Always allow / Keep blocked", () => {
    render(<ContactBlockedCard item={item} />);
    expect(screen.getByText("Let Donna message Sam?")).toBeTruthy();
    for (const gone of ["Allow once", "Always allow", "Keep blocked"]) {
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(decide).toHaveBeenLastCalledWith({
      approvalId: "req",
      decision: "approve",
      choice: "allow",
    });
  });

  it("Don't send collapses to Not sent · Undo and rejects only after the window", () => {
    vi.useFakeTimers();
    render(<ContactBlockedCard item={item} />);
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    expect(screen.getByText("Not sent")).toBeTruthy();
    act(() => vi.advanceTimersByTime(10_000));
    expect(decide).toHaveBeenLastCalledWith({
      approvalId: "req",
      decision: "reject",
    });
  });
});
