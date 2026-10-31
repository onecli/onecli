// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push, prefetch, saveOnboardingProgress } = vi.hoisted(() => ({
  push: vi.fn(),
  prefetch: vi.fn(),
  saveOnboardingProgress: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, prefetch, replace: vi.fn() }),
}));

vi.mock("./actions", () => ({ saveOnboardingProgress }));

const onboarding = {
  progress: {
    discovery: [] as string[],
    messagingTool: null as string | null,
    messagingToolOther: null as string | null,
    agentName: null,
    createdAgentId: null,
  },
};

vi.mock("./onboarding-context", () => ({
  useOnboarding: () => onboarding,
}));

import WelcomePage from "./welcome-page";

describe("step 1: which messaging tool", () => {
  beforeEach(() => {
    push.mockClear();
    saveOnboardingProgress.mockClear();
    onboarding.progress.messagingTool = null;
    onboarding.progress.messagingToolOther = null;
  });

  it("asks the question with Slack selected by default", () => {
    render(<WelcomePage />);

    expect(
      screen.getByRole("heading", {
        name: "Which messaging tool does your team use?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Slack" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("radio", { name: "Microsoft Teams" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("Continue saves the default answer and moves on after a short fade", () => {
    vi.useFakeTimers();
    render(<WelcomePage />);

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(saveOnboardingProgress).toHaveBeenCalledExactlyOnceWith({
      messagingTool: "slack",
      messagingToolOther: null,
    });
    expect(push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(push).toHaveBeenCalledWith("/onboarding/create");
    vi.useRealTimers();
  });

  it("Other asks which one, and Continue waits for an answer", () => {
    render(<WelcomePage />);

    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    const field = screen.getByRole("textbox", {
      name: "Which messaging tool?",
    });
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();

    fireEvent.change(field, { target: { value: "  Google Chat " } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(saveOnboardingProgress).toHaveBeenCalledExactlyOnceWith({
      messagingTool: "other",
      messagingToolOther: "Google Chat",
    });
  });

  it("Skip moves on without saving an answer", () => {
    vi.useFakeTimers();
    render(<WelcomePage />);

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(saveOnboardingProgress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(push).toHaveBeenCalledWith("/onboarding/create");
    vi.useRealTimers();
  });

  it("a resumed session keeps the saved answer", () => {
    onboarding.progress.messagingTool = "teams";
    render(<WelcomePage />);

    expect(
      screen.getByRole("radio", { name: "Microsoft Teams" }),
    ).toHaveAttribute("aria-checked", "true");
  });
});
