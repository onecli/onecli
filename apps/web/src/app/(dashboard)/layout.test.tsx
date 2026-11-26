// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * The dashboard layout, once signed in, on an old address that only
 * forwards: the landing skeleton stays up, with the page (which renders
 * nothing while its redirect lands) in its panel, so an error would still
 * show. Never the old page's scope around an empty panel, which on cloud
 * sat on screen for seconds while sign-in resolved. Any other URL gets the
 * real shell.
 */

const state = vi.hoisted(() => {
  const session: Record<string, unknown> = { workspaceId: "ws1", hasOrg: true };
  return { pathname: "/", session };
});

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    signOut: vi.fn(),
  }),
}));
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: async () =>
    new Response(JSON.stringify(state.session), { status: 200 }),
}));
vi.mock("@/lib/user-plan", () => ({
  checkDashboardRedirect: async () => null,
}));
vi.mock("@/lib/plan-gate", () => ({
  PlanGateProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/dashboard/shell/dashboard-shell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="real-shell">{children}</div>
  ),
}));

const { default: DashboardLayout } = await import("./layout");

afterEach(() => {
  cleanup();
  state.session = { workspaceId: "ws1", hasOrg: true };
});

const open = async (pathname: string) => {
  state.pathname = pathname;
  const utils = render(
    <DashboardLayout settings={null}>
      <p data-testid="page">page</p>
    </DashboardLayout>,
  );
  // The session check resolves on a microtask; let it.
  await act(async () => {});
  return utils.container;
};

describe("DashboardLayout", () => {
  it("keeps the landing skeleton up on an old address, the page in its panel", async () => {
    for (const path of [
      "/org/o1/team",
      "/w/ws1/connections/llms",
      "/w/ws1/agents/ag1/memory",
    ]) {
      const page = await open(path);
      expect(screen.queryByTestId("real-shell"), path).toBeNull();
      const skeleton = page.querySelector("[aria-busy]");
      expect(skeleton, path).not.toBeNull();
      expect(
        page.querySelector("[data-agent-nav-skeleton]"),
        path,
      ).not.toBeNull();
      expect(skeleton?.contains(screen.getByTestId("page")), path).toBe(true);
      cleanup();
    }
  });

  it("draws the real shell on a page that renders", async () => {
    for (const path of [
      "/w/ws1/agents/ag1/chat",
      "/org/o1/workspaces",
      "/w/ws1/settings/install",
    ]) {
      const page = await open(path);
      expect(
        screen.getByTestId("real-shell").contains(screen.getByTestId("page")),
        path,
      ).toBe(true);
      expect(page.querySelector("[aria-busy]"), path).toBeNull();
      cleanup();
    }
  });

  // The account's addresses forward into Settings > Profile for anyone with
  // an org, and are the profile page itself for someone with none.
  it("keeps the skeleton up on an account address for a viewer with an org", async () => {
    for (const path of ["/account", "/account/preferences"]) {
      const page = await open(path);
      expect(screen.queryByTestId("real-shell"), path).toBeNull();
      expect(page.querySelector("[aria-busy]"), path).not.toBeNull();
      cleanup();
    }
  });

  it("draws the real shell around the account page for a viewer with no org", async () => {
    state.session = {};
    for (const path of ["/account", "/account/ssh-keys"]) {
      const page = await open(path);
      expect(
        screen.getByTestId("real-shell").contains(screen.getByTestId("page")),
        path,
      ).toBe(true);
      expect(page.querySelector("[aria-busy]"), path).toBeNull();
      cleanup();
    }
  });
});
