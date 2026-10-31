// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@onecli/ui/components/sidebar";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * THE AUTO-HIDE PROOF, onprem arm (§3.13 as amended 2026-08-16): with no
 * runner ever registered, a self-host dashboard shows no hosted vocabulary —
 * no Channels, no Skills, no chat links. One deliberate exception
 * to the old byte-identical posture: the sidebar's agent list is
 * availability-independent, so the workspace's own (BYO) agents are listed
 * even here. Same real wire→hook→availability→DOM chain as the cloud arm
 * (dashboard-sidebar.test.tsx); only the edition pin differs.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const state = vi.hoisted(() => ({
  runners: undefined as InstanceInfo["runners"],
  pathname: "/org/o1/workspaces",
  agents: [] as Array<{ id: string; name: string; kind: string }>,
}));

vi.mock("@/lib/api/instance", () => ({
  get: async (): Promise<InstanceInfo> => ({
    edition: "onprem",
    entitled: false,
    version: "test",
    ...(state.runners && { runners: state.runners }),
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

// The New agent row owns the create flow (its own suite covers it); these
// suites are about the agent rows.
vi.mock("@/lib/dashboard/new-agent-row", () => ({
  NewAgentRow: () => <li>New agent</li>,
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));
vi.mock("@/ee/team/actions", () => ({
  getUserOrgRole: async () => "owner",
}));
vi.mock("@/ee/billing/_components/sidebar-quota", () => ({
  SidebarQuota: () => null,
}));
vi.mock("@/lib/dashboard/nav-user", () => ({
  NavUser: () => null,
}));
vi.mock("@/lib/dashboard/org-switcher", () => ({
  OrgSwitcher: () => null,
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgentsForWorkspace: () => ({ data: state.agents, isPending: false }),
}));

const { DashboardSidebar } = await import("./dashboard-sidebar");

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const renderSidebar = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SidebarProvider>
        <DashboardSidebar />
      </SidebarProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.runners = undefined;
  state.pathname = "/org/o1/workspaces";
  state.agents = [];
});

describe("pure auto-hide: no runner, no feature", () => {
  it("the org nav carries no hosted vocabulary at all", async () => {
    state.runners = { registered: false, online: false };
    renderSidebar();
    await screen.findByText("Members");
    const text = document.body.textContent ?? "";
    for (const word of ["Channels", "Skills"]) {
      expect(text).not.toContain(word);
    }
  });

  it("the workspace sidebar shows no thread links — self-host absent is SILENT", async () => {
    state.runners = { registered: false, online: false };
    state.pathname = "/w/p1/activity";
    renderSidebar();
    await screen.findByText("Activity");
    expect(
      screen
        .queryAllByRole("link")
        .filter((link) => link.getAttribute("href")?.includes("/chat")),
    ).toEqual([]);
  });

  it("a runnerless self-host still lists the workspace's BYO agents", async () => {
    // The 2026-08-16 amendment made executable: the agent list never depends
    // on a runner existing — only the hosted nav entries do.
    state.runners = { registered: false, online: false };
    state.pathname = "/w/p1/activity";
    state.agents = [{ id: "ag-b", name: "Laptop", kind: "byo" }];
    renderSidebar();
    await screen.findByText("Laptop");
    expect(screen.getByRole("link", { name: /Laptop/ })).toHaveAttribute(
      "href",
      "/w/p1/agents/ag-b/connections",
    );
  });

  it("labels the workspace nav under the Agents group — and only in a workspace", async () => {
    state.runners = { registered: false, online: false };
    state.pathname = "/w/p1/activity";
    const view = renderSidebar();
    await screen.findByText("Activity");
    const labels = [
      ...view.container.querySelectorAll('[data-sidebar="group-label"]'),
    ].map((el) => el.textContent);
    expect(labels).toEqual(["Agents", "Workspace"]);
    view.unmount();

    state.pathname = "/org/o1/workspaces";
    const org = renderSidebar();
    await screen.findByText("Members");
    expect(
      org.container.querySelectorAll('[data-sidebar="group-label"]'),
    ).toHaveLength(0);
  });

  it("a runner flips the same install to the full surface with no code change", async () => {
    state.runners = { registered: true, online: true };
    state.pathname = "/org/o1/workspaces";
    renderSidebar();
    await screen.findByText("Channels");
    expect(screen.getByText("Skills")).toBeDefined();
  });

  it("the footer shows the installed version on self-host", async () => {
    state.runners = { registered: false, online: false };
    renderSidebar();
    // The wire mock reports version "test"; the real SidebarVersion renders it.
    await screen.findByText("vtest");
  });
});
