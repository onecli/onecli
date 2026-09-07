// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The unit here is the end of onboarding: the create step's boot screen is
// the LAST screen, and its "Meet your agent" door must complete into the
// greeting path — the chat URL carrying `?hello=1` — so the composer opens
// with the first message already typed. The door must also wait for BOTH the
// narrative and the created agent: never a claim of "ready" on timers alone.
const { handleComplete, prefetch, mutateAsync, recordCreatedAgent } =
  vi.hoisted(() => ({
    handleComplete: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn(),
    mutateAsync: vi.fn(),
    recordCreatedAgent: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch, replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-agents", () => ({
  useCreateHostedAgent: () => ({ isPending: false, mutateAsync }),
}));

// The mission visual pulls in next/image — presentation, not this contract.
vi.mock("./_components/welcome-visual", () => ({
  WelcomeVisual: () => null,
}));

const onboarding = {
  createdAgentId: null as string | null,
  createdAgentName: null as string | null,
  workspaceId: "ws-1",
  completing: false,
  recordCreatedAgent,
  handleComplete,
};

vi.mock("./onboarding-context", () => ({
  useOnboarding: () => onboarding,
}));

import CreatePage from "./create-page";

const GREETING_DESTINATION = "/w/ws-1/agents/ag-1/chat?hello=1";

describe("the create step's hand-off into chat (resume with a created agent)", () => {
  beforeEach(() => {
    handleComplete.mockClear();
    prefetch.mockClear();
    onboarding.createdAgentId = "ag-1";
    onboarding.createdAgentName = "Donna";
  });

  it("resumes straight onto the finished boot screen with the door open", () => {
    render(<CreatePage />);

    expect(screen.getByText("Donna is starting up")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /meet your agent/i }),
    ).toBeInTheDocument();
  });

  it("the door completes into the greeting path — the prefilled first message", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await user.click(screen.getByRole("button", { name: /meet your agent/i }));

    expect(handleComplete).toHaveBeenCalledExactlyOnceWith(
      GREETING_DESTINATION,
    );
  });

  it("prefetches the greeting destination while the narrative plays", () => {
    render(<CreatePage />);

    expect(prefetch).toHaveBeenCalledWith(GREETING_DESTINATION);
  });
});

describe("the boot narrative gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handleComplete.mockClear();
    onboarding.createdAgentId = null;
    onboarding.createdAgentName = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("without a created agent the timers alone never open the door", async () => {
    render(<CreatePage />);

    // mission → form → submit; the create never resolves in this test.
    // fireEvent (not userEvent): synchronous, so it cannot deadlock with the
    // fake clock this test owns.
    mutateAsync.mockReturnValue(new Promise(() => {}));
    fireEvent.click(
      screen.getByRole("button", { name: /create your first agent/i }),
    );
    fireEvent.submit(screen.getByRole("button", { name: /^create agent/i }));

    // Play the whole narrative out — well past every boot line.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByText(/is starting up/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /meet your agent/i }),
    ).toBeNull();
  });
});
