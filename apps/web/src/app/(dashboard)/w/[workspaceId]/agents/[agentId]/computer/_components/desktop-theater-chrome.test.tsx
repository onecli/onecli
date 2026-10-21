// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/w/ws-1/agents/ag-1/computer",
  authenticated: true,
  pending: false,
  error: false,
  kind: "hosted",
  replace: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    isAuthenticated: state.authenticated,
    isLoading: false,
    signOut: state.signOut,
  }),
}));
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
}));
vi.mock("@/lib/user-plan", () => ({
  checkDashboardRedirect: async () => null,
}));
vi.mock("@/lib/dashboard/session-redirect", () => ({
  getDashboardRedirect: () => null,
}));
vi.mock("@/lib/plan-gate", () => ({
  PlanGateProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="plan-provider">{children}</div>
  ),
}));
vi.mock("@dashboard/dashboard-sidebar", () => ({
  DashboardSidebar: () => <div>Dashboard sidebar</div>,
}));
vi.mock("@dashboard/dashboard-header", () => ({
  DashboardHeader: () => <div>Dashboard header</div>,
}));
vi.mock("@dashboard/settings-nav", () => ({ SettingsNav: () => null }));
vi.mock("@dashboard/settings-mobile-nav", () => ({
  SettingsMobileNav: () => null,
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({
    data: [{ id: "ag-1", name: "andy", kind: state.kind }],
    isPending: state.pending,
    isError: state.error,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../_components/agent-page-header", () => ({
  AgentPageHeader: () => <div>Agent header</div>,
}));
vi.mock("../../_components/agent-section-rail", () => ({
  AgentSectionRail: () => <div>Agent rail</div>,
}));
const { default: DashboardLayout } = await import("../../../../../../layout");
const { AgentPageFrame } = await import("../../_components/agent-page-frame");
beforeEach(() => {
  state.pathname = "/w/ws-1/agents/ag-1/computer";
  state.authenticated = true;
  state.pending = false;
  state.error = false;
  state.kind = "hosted";
  vi.clearAllMocks();
});
afterEach(cleanup);
const renderPage = () =>
  render(
    <DashboardLayout>
      <AgentPageFrame agentId="ag-1">
        <div>Theater content</div>
      </AgentPageFrame>
    </DashboardLayout>,
  );

describe("theater chrome and guards", () => {
  it("retains header and rail on ordinary agent sections", () => {
    state.pathname = "/w/ws-1/agents/ag-1/chat";
    render(
      <AgentPageFrame agentId="ag-1">
        <div>Chat content</div>
      </AgentPageFrame>,
    );
    expect(screen.getByText("Agent header")).toBeInTheDocument();
    expect(screen.getByText("Agent rail")).toBeInTheDocument();
    expect(screen.getByText("Chat content")).toBeInTheDocument();
  });
  it("removes both chrome layers but keeps the plan provider", async () => {
    renderPage();
    await screen.findByText("Theater content");
    expect(screen.getByTestId("plan-provider")).toBeInTheDocument();
    for (const label of [
      "Dashboard sidebar",
      "Dashboard header",
      "Agent header",
      "Agent rail",
    ])
      expect(screen.queryByText(label)).toBeNull();
  });
  it("keeps the hosted-only guard", async () => {
    state.kind = "byo";
    renderPage();
    await screen.findByText(
      "That section is only available for hosted agents.",
    );
    expect(screen.queryByText("Theater content")).toBeNull();
  });
  it("does not expose children to unauthenticated visitors", async () => {
    state.authenticated = false;
    renderPage();
    await waitFor(() =>
      expect(state.replace).toHaveBeenCalledWith("/auth/login"),
    );
    expect(screen.queryByText("Theater content")).toBeNull();
  });
  it("retains agent loading and error states without chrome", async () => {
    state.pending = true;
    const view = renderPage();
    await screen.findByText("Loading agent");
    expect(screen.queryByText("Agent header")).toBeNull();
    state.pending = false;
    state.error = true;
    view.rerender(
      <DashboardLayout>
        <AgentPageFrame agentId="ag-1">
          <div>Theater content</div>
        </AgentPageFrame>
      </DashboardLayout>,
    );
    expect(screen.getByText("Couldn't load this agent.")).toBeInTheDocument();
    expect(screen.queryByText("Theater content")).toBeNull();
  });
});
