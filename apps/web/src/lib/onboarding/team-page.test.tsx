// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The unit here is the hand-off: BOTH ways out of the last onboarding step
// must land on the greeting path — the chat URL carrying `?hello=1` — so the
// composer opens with the first message already typed. The layout boot,
// invitations, and step guard are stubbed to their contracts.
const { handleComplete, prefetch } = vi.hoisted(() => ({
  handleComplete: vi.fn().mockResolvedValue(undefined),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch, replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-invitations", () => ({
  useInviteTeammates: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("./use-step-guard", () => ({ useStepGuard: () => true }));

vi.mock("./onboarding-context", () => ({
  useOnboarding: () => ({
    createdAgentId: "ag-1",
    createdAgentName: "Donna",
    workspaceId: "ws-1",
    completing: false,
    handleComplete,
  }),
}));

import TeamPage from "./team-page";

const GREETING_DESTINATION = "/w/ws-1/agents/ag-1/chat?hello=1";

describe("the team step's hand-off into chat", () => {
  beforeEach(() => {
    handleComplete.mockClear();
    prefetch.mockClear();
  });

  it("Skip completes into the greeting path — the prefilled first message", async () => {
    const user = userEvent.setup();
    render(<TeamPage />);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(handleComplete).toHaveBeenCalledExactlyOnceWith(
      GREETING_DESTINATION,
    );
  });

  it("Continue (no invites) completes into the same greeting path", async () => {
    const user = userEvent.setup();
    render(<TeamPage />);

    await user.click(screen.getByRole("button", { name: /meet your agent/i }));

    expect(handleComplete).toHaveBeenCalledExactlyOnceWith(
      GREETING_DESTINATION,
    );
  });

  it("prefetches the greeting destination while the user types", () => {
    render(<TeamPage />);

    expect(prefetch).toHaveBeenCalledWith(GREETING_DESTINATION);
  });
});
