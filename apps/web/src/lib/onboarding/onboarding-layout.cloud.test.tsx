// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CAPS is resolved at module load — pin the billing edition before imports.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
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
  checkOnboardingComplete,
  getOnboardingProgress,
  getActiveWorkspacePath,
} = vi.hoisted(() => ({
  getSubscriptionStatus: vi.fn(),
  checkOnboardingComplete: vi.fn(),
  getOnboardingProgress: vi.fn(),
  getActiveWorkspacePath: vi.fn(),
}));

vi.mock("@/ee/billing/actions", () => ({ getSubscriptionStatus }));
vi.mock("@/lib/onboarding/actions", () => ({
  checkOnboardingComplete,
  getOnboardingProgress,
}));
vi.mock("@/lib/workspaces/actions", () => ({ getActiveWorkspacePath }));

vi.mock("@/lib/onboarding/onboarding-context", () => ({
  OnboardingProvider: ({
    children,
    initialWorkspaceId,
  }: {
    children: React.ReactNode;
    initialWorkspaceId: string | null;
  }) => <div data-workspace={initialWorkspaceId ?? ""}>{children}</div>,
}));
vi.mock("@/lib/onboarding/_components/flow-chrome", () => ({
  FlowChrome: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="flow">{children}</div>
  ),
}));
vi.mock("@/lib/onboarding/_components/onboarding-footer", () => ({
  OnboardingFooter: () => null,
}));
vi.mock("@/lib/onboarding/_components/onboarding-escape-hatch", () => ({
  OnboardingEscapeHatch: () => null,
}));

import OnboardingLayout from "./onboarding-layout";

const emptyProgress = {
  discovery: [],
  agentName: null,
  createdAgentId: null,
};

beforeEach(() => {
  replace.mockReset();
  getSubscriptionStatus.mockReset().mockResolvedValue({ status: "free" });
  checkOnboardingComplete.mockReset().mockResolvedValue(false);
  getActiveWorkspacePath.mockReset().mockResolvedValue("/w/p1/overview");
  getOnboardingProgress.mockReset().mockResolvedValue(emptyProgress);
});

afterEach(cleanup);

describe("onboarding layout boot (billing edition)", () => {
  it("boots the flow for a free, not-yet-onboarded user, with the boot-resolved workspace", async () => {
    render(<OnboardingLayout>step</OnboardingLayout>);
    const flow = await screen.findByTestId("flow");
    expect(flow).toHaveTextContent("step");
    // The default workspace is parsed off the active-workspace path so the
    // flow's API calls can target a workspace the onboarding URL doesn't carry.
    expect(flow.parentElement).toHaveAttribute("data-workspace", "p1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("bounces a completed user to the dashboard — onboarding has no return door", async () => {
    checkOnboardingComplete.mockResolvedValue(true);
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/p1/overview"));
    expect(screen.queryByTestId("flow")).toBeNull();
  });

  it("bounces when no workspace resolved — the flow can't create into nowhere", async () => {
    // ensureUserDefaultOrgAndWorkspace found no default workspace: the active
    // path is /create-org, which is where the user must go first.
    getActiveWorkspacePath.mockResolvedValue("/create-org");
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/create-org"));
    expect(screen.queryByTestId("flow")).toBeNull();
  });

  it("FAILS OPEN when a boot action rejects — home, never an eternal spinner", async () => {
    // MUTATION-TESTED (the fail-open catch): remove the boot().catch and a
    // rejecting server action strands the user on the loading spinner forever
    // (the 500-loop half of the release blocker) instead of landing home.
    getSubscriptionStatus.mockRejectedValue(new Error("500"));
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByTestId("flow")).toBeNull();
  });

  it("bounces a paid-org user to the dashboard", async () => {
    getSubscriptionStatus.mockResolvedValue({ status: "team" });
    render(<OnboardingLayout>step</OnboardingLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/p1/overview"));
  });
});
