// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * The sidebar, onprem arm: a runnerless self-host lists
 * its BYO agents' rows and nothing hosted; SSH and Ports exist only where
 * the instance serves them.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const state = vi.hoisted(() => ({
  instance: {} as Partial<InstanceInfo>,
  pathname: "/w/p1/agents/ag-b/connections",
  agents: [] as Array<{
    id: string;
    name: string;
    kind: string;
    createdAt: string;
    channels: unknown[];
  }>,
}));

vi.mock("@/lib/api/instance", () => ({
  get: async (): Promise<InstanceInfo> => ({
    edition: "onprem",
    entitled: false,
    version: "test",
    runners: { registered: false, online: false },
    ...state.instance,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgentsForWorkspace: () => ({ data: state.agents, isPending: false }),
  useRenameAgent: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateAgentImage: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("./scope-header", () => ({
  ScopeHeader: () => <div data-testid="scope-header" />,
}));

const { DashboardSidebar } = await import("./dashboard-sidebar");

const renderSidebar = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DashboardSidebar workspaceId="p1" orgId="o1" navItems={[]} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.instance = {};
  state.pathname = "/w/p1/agents/ag-b/connections";
  state.agents = [
    {
      id: "ag-b",
      name: "Laptop",
      kind: "byo",
      createdAt: "2026-01-01T00:00:00Z",
      channels: [],
    },
  ];
});

describe("a runnerless self-host", () => {
  it("lists a BYO agent's rows with no hosted vocabulary", async () => {
    renderSidebar();
    await screen.findByText("Laptop");
    const text = document.body.textContent ?? "";
    for (const word of ["Chat", "Knowledge", "Contacts", "Schedules"]) {
      expect(text).not.toContain(word);
    }
    expect(screen.getByRole("link", { name: "Apps" })).toHaveAttribute(
      "href",
      "/w/p1/agents/ag-b/connections",
    );
  });

  it("keeps More for the BYO agent's Agent settings row", async () => {
    renderSidebar();
    await screen.findByText("Laptop");
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(
      screen.getByRole("link", { name: "Agent settings" }),
    ).toHaveAttribute("href", "/w/p1/agents/ag-b/settings");
  });
});

describe("a hosted agent on a self-host with a runner", () => {
  it("shows SSH only where the instance serves it", async () => {
    state.instance = { runners: { registered: true, online: true } };
    state.agents = [
      {
        id: "ag-h",
        name: "Donna",
        kind: "hosted",
        createdAt: "2026-01-01T00:00:00Z",
        channels: [],
      },
    ];
    state.pathname = "/w/p1/agents/ag-h/evals";
    renderSidebar();
    await screen.findByText("Donna");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "SSH" })).toBeNull(),
    );
    expect(screen.queryByRole("link", { name: "Ports" })).toBeNull();
    expect(screen.getByRole("link", { name: "Evals" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
