// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
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

const { getSubscriptionStatus, getActiveWorkspacePath } = vi.hoisted(() => ({
  getSubscriptionStatus: vi.fn(),
  getActiveWorkspacePath: vi.fn(),
}));

vi.mock("@/ee/billing/actions", () => ({ getSubscriptionStatus }));
vi.mock("@/lib/onboarding/actions", () => ({
  checkOnboardingComplete: vi.fn(),
  getOnboardingProgress: vi.fn(),
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
vi.mock("@/lib/onboarding/_components/onboarding-escape-hatch", () => ({
  OnboardingEscapeHatch: () => null,
}));

import OnboardingLayout from "./onboarding-layout";

beforeEach(() => {
  replace.mockReset();
  getSubscriptionStatus.mockReset();
  getActiveWorkspacePath.mockReset().mockResolvedValue("/w/p1/overview");
});

afterEach(cleanup);

describe("onboarding layout (onprem)", () => {
  it("bounces a direct visit home without ever touching the billing action", async () => {
    // MUTATION-TESTED (the onprem guard): drop the !CAPS.billing branch and a
    // self-hosted direct visit runs the EE billing action head-on — the
    // headerless 500 the release blocker asked to make unreachable.
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/p1/overview"));
    expect(getSubscriptionStatus).not.toHaveBeenCalled();
  });
});
