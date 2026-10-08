// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CAPS is resolved at module load — pin the onprem (no-billing) edition.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
});

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/onboarding",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    signOut: vi.fn(),
  }),
}));

const {
  getSubscriptionStatus,
  getActiveWorkspacePath,
  checkOnboardingComplete,
  getOnboardingProgress,
} = vi.hoisted(() => ({
  getSubscriptionStatus: vi.fn(),
  getActiveWorkspacePath: vi.fn(),
  checkOnboardingComplete: vi.fn(),
  getOnboardingProgress: vi.fn(),
}));

vi.mock("@/ee/billing/actions", () => ({ getSubscriptionStatus }));
vi.mock("@/lib/onboarding/actions", () => ({
  checkOnboardingComplete,
  getOnboardingProgress,
}));
vi.mock("@/lib/workspaces/actions", () => ({ getActiveWorkspacePath }));

vi.mock("@/lib/onboarding/onboarding-context", () => ({
  OnboardingProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/onboarding/_components/flow-chrome", () => ({
  FlowChrome: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/onboarding/_components/onboarding-footer", () => ({
  OnboardingFooter: () => null,
}));

import OnboardingLayout from "./onboarding-layout";

beforeEach(() => {
  replace.mockReset();
  getSubscriptionStatus.mockReset();
  checkOnboardingComplete.mockReset().mockResolvedValue(false);
  getOnboardingProgress.mockReset().mockResolvedValue({
    discovery: [],
    agentName: null,
  });
  getActiveWorkspacePath.mockReset().mockResolvedValue("/w/p1/overview");
});

afterEach(cleanup);

describe("onboarding layout (onprem)", () => {
  it("bounces a direct visit home without booting the flow or touching billing", async () => {
    // MUTATION-TESTED (the onprem guard): drop the !CAPS.billing branch and a
    // fresh, never-onboarded self-hosted owner who types /onboarding gets the
    // cloud-only walkthrough booted for them. Onboarding is cloud-only.
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/p1/overview"));
    expect(screen.queryByText("step")).toBeNull();
    expect(getSubscriptionStatus).not.toHaveBeenCalled();
    expect(checkOnboardingComplete).not.toHaveBeenCalled();
    expect(getOnboardingProgress).not.toHaveBeenCalled();
  });

  it("fails OPEN when the workspace lookup rejects: home, never a spinner", async () => {
    getActiveWorkspacePath.mockRejectedValue(new Error("500"));
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("step")).toBeNull();
  });
});
