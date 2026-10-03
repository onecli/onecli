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
  checkOnboardingComplete.mockReset();
  getOnboardingProgress.mockReset();
  getActiveWorkspacePath.mockReset().mockResolvedValue("/w/p1/overview");
});

afterEach(cleanup);

describe("onboarding layout (onprem)", () => {
  it("boots the flow for a not-yet-onboarded owner without ever touching the billing action", async () => {
    // MUTATION-TESTED (the onprem guard): route the status read through the
    // EE billing action unconditionally and a self-hosted visit runs it
    // head-on — the headerless 500 the release blocker asked to make
    // unreachable. Without billing every org reads as free, so the flow boots.
    checkOnboardingComplete.mockResolvedValue(false);
    getOnboardingProgress.mockResolvedValue({
      discovery: [],
      agentName: null,
    });
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(screen.getByText("step")).toBeTruthy());
    expect(replace).not.toHaveBeenCalled();
    expect(getSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("bounces a completed user home — onboarding has no return door", async () => {
    checkOnboardingComplete.mockResolvedValue(true);
    getOnboardingProgress.mockResolvedValue({
      discovery: [],
      agentName: null,
    });
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/p1/overview"));
    expect(getSubscriptionStatus).not.toHaveBeenCalled();
  });
});
