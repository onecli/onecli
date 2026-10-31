// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The unit here is the end of onboarding: the create step's boot screen is
// the LAST screen, and its "Meet <name>" door must complete into the
// agent's chat, where the agent speaks first (the empty-thread greeting) and
// the composer opens blank. The door must also wait for BOTH the narrative
// and the created agent: never a claim of "ready" on timers alone.
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

const CHAT_DESTINATION = "/w/ws-1/agents/ag-1/chat";

describe("the create step's hand-off into chat (resume with a created agent)", () => {
  beforeEach(() => {
    handleComplete.mockClear();
    prefetch.mockClear();
    onboarding.createdAgentId = "ag-1";
    onboarding.createdAgentName = "Donna";
  });

  it("resumes straight onto the finished boot screen with the door open", () => {
    render(<CreatePage />);

    expect(screen.getByText("Donna is getting ready")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /meet donna/i }),
    ).toBeInTheDocument();
  });

  it("speaks plain language: no sandbox, credential or gateway jargon", () => {
    render(<CreatePage />);

    expect(screen.getByText("Setting up Donna")).toBeInTheDocument();
    expect(
      screen.getByText("Giving Donna a safe space of its own"),
    ).toBeInTheDocument();
    expect(screen.getByText("Keeping your passwords safe")).toBeInTheDocument();
    expect(
      screen.queryByText(/sandbox|credential|gateway|provision/i),
    ).toBeNull();
  });

  it("the door eases the screen out, then completes into the agent's chat", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await user.click(screen.getByRole("button", { name: /meet donna/i }));

    await waitFor(() =>
      expect(handleComplete).toHaveBeenCalledExactlyOnceWith(CHAT_DESTINATION),
    );
  });

  it("prefetches the chat destination while the narrative plays", () => {
    render(<CreatePage />);

    expect(prefetch).toHaveBeenCalledWith(CHAT_DESTINATION);
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

  it("opens on the tools promise: all your tools, safely, SOC 2", () => {
    render(<CreatePage />);

    expect(
      screen.getByRole("heading", {
        name: "Works with all your tools, safely",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("apps-marquee")).toBeInTheDocument();
    expect(
      screen.getByText(/You decide what your agent can do\./),
    ).toBeInTheDocument();
    expect(screen.getByText("SOC 2 compliant")).toBeInTheDocument();
  });

  it("without a created agent the timers alone never open the door", async () => {
    render(<CreatePage />);

    // mission → form → submit; the create never resolves in this test.
    // fireEvent (not userEvent): synchronous, so it cannot deadlock with the
    // fake clock this test owns.
    mutateAsync.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.submit(screen.getByRole("button", { name: /let's go/i }));

    // Play the whole narrative out — well past every boot line.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByText(/is getting ready/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /meet donna/i })).toBeNull();
  });
});
