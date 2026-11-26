// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * The sidebar, cloud arm: inside an agent it shows that agent's rows from
 * the shared section table (through the instance's availability wire), a
 * More disclosure for the rest, and the inline name editor. The onprem arm
 * is the sibling file.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  instance: {} as Partial<InstanceInfo>,
  pathname: "/w/p1/agents/ag-h/chat",
  agents: [] as Array<{
    id: string;
    name: string;
    kind: string;
    createdAt: string;
    channels: unknown[];
  }>,
  renamed: [] as { agentId: string; name: string }[],
}));

vi.mock("@/lib/api/instance", () => ({
  get: async (): Promise<InstanceInfo> => ({
    edition: "cloud",
    entitled: true,
    version: "test",
    ...state.instance,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgentsForWorkspace: () => ({ data: state.agents, isPending: false }),
  useRenameAgent: () => ({
    isPending: false,
    // Never settles: the header must show the new name on its own, before
    // the server (and the refetch) answer.
    mutateAsync: (input: { agentId: string; name: string }) => {
      state.renamed.push(input);
      return new Promise(() => {});
    },
  }),
  useUpdateAgentImage: () => ({ isPending: false, mutate: vi.fn() }),
}));
// The scope header's own reads (orgs, workspaces) have their own proofs.
vi.mock("./scope-header", () => ({
  ScopeHeader: () => <div data-testid="scope-header" />,
}));

const { DashboardSidebar } = await import("./dashboard-sidebar");

const hosted = {
  id: "ag-h",
  name: "Donna",
  kind: "hosted",
  createdAt: "2026-01-01T00:00:00Z",
  channels: [],
};
const byo = {
  id: "ag-b",
  name: "Laptop",
  kind: "byo",
  createdAt: "2026-01-02T00:00:00Z",
  channels: [],
};

const renderSidebar = (workspaceId: string | undefined = "p1") =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DashboardSidebar workspaceId={workspaceId} orgId="o1" navItems={[]} />
    </QueryClientProvider>,
  );

/** The agent's page rows (the header's settings gear is not one). */
const links = () =>
  within(screen.getByRole("navigation", { name: "Agent pages" }))
    .getAllByRole("link")
    .map((l) => l.textContent?.trim() ?? "");

beforeEach(() => {
  state.instance = {};
  state.pathname = "/w/p1/agents/ag-h/chat";
  state.agents = [hosted, byo];
  state.renamed = [];
});

describe("inside a hosted agent", () => {
  it("shows the everyday rows and a closed More", async () => {
    renderSidebar();
    await screen.findByText("Donna");
    expect(links()).toEqual([
      "Chat",
      "Knowledge",
      "Apps",
      "Contacts",
      "Schedules",
    ]);
    expect(screen.getByRole("button", { name: /More/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  // The More rows stay mounted so they can ease open; closed, they must be
  // neither tabbable nor announced, or a keyboard user walks into links
  // they cannot see.
  it("keeps closed More rows out of reach, and opens them on a click", async () => {
    renderSidebar();
    await screen.findByText("Donna");
    const more = screen.getByRole("button", { name: /More/ });
    const webhooks = screen.getByText("Webhooks").closest("a")!;
    const panel = webhooks.closest("[inert]");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(webhooks.closest("[inert]")).toBeNull();
    expect(links()).toContain("Webhooks");
  });

  it("marks the row that owns the current section", async () => {
    state.pathname = "/w/p1/agents/ag-h/knowledge";
    renderSidebar();
    await screen.findByText("Donna");
    expect(screen.getByRole("link", { name: "Knowledge" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Chat" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("opens More on its own when the current section lives there", async () => {
    state.pathname = "/w/p1/agents/ag-h/webhooks";
    renderSidebar();
    await screen.findByText("Donna");
    expect(screen.getByRole("button", { name: /More/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("link", { name: "Webhooks" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps the workspace's own rows out of More (the agent's rows reach them)", async () => {
    state.pathname = "/w/p1/agents/ag-h/webhooks";
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <DashboardSidebar
          workspaceId="p1"
          orgId="o1"
          navItems={[
            {
              title: "Connections",
              url: "/w/p1/connections",
              icon: (() => null) as never,
            },
            {
              title: "Workspace Settings",
              url: "/w/p1/settings",
              icon: (() => null) as never,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Donna");
    // Ports is still offered here: the instance read is in flight, and
    // loading never renders as unavailable.
    expect(links()).toEqual([
      "Chat",
      "Knowledge",
      "Apps",
      "Contacts",
      "Schedules",
      "Activity",
      "Evals",
      "Webhooks",
      "Ports",
      "Agent settings",
    ]);
  });

  it("hides SSH and Ports once the instance answers without them", async () => {
    state.instance = { ssh: undefined, previews: undefined };
    state.pathname = "/w/p1/agents/ag-h/evals";
    renderSidebar();
    await screen.findByText("Donna");
    // Shown while the instance read is in flight (loading never renders as
    // unavailable), gone once it answers without the capability.
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "SSH" })).toBeNull(),
    );
    expect(screen.queryByRole("link", { name: "Ports" })).toBeNull();
    expect(screen.getByRole("link", { name: "Evals" })).toBeInTheDocument();
  });

  it("renames in place: click the name, type, Enter", async () => {
    renderSidebar();
    await screen.findByText("Donna");
    fireEvent.click(screen.getByRole("button", { name: "Rename Donna" }));
    const input = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.change(input, { target: { value: "Donna 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state.renamed).toEqual([{ agentId: "ag-h", name: "Donna 2" }]);
    expect(screen.queryByRole("textbox", { name: "Agent name" })).toBeNull();
    // Optimistic: the new name is on screen while the save is in flight.
    expect(
      await screen.findByRole("button", { name: "Rename Donna 2" }),
    ).toBeInTheDocument();
  });

  it("saves nothing for an unchanged or blank name", async () => {
    renderSidebar();
    await screen.findByText("Donna");
    fireEvent.click(screen.getByRole("button", { name: "Rename Donna" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Agent name" }), {
      target: { value: "   " },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Agent name" }), {
      key: "Enter",
    });
    expect(state.renamed).toEqual([]);
  });

  // Each row plays its own icon's loop, on that icon alone: hovering Apps
  // moves the plug, and nothing in the Chat row. jsdom has no Web
  // Animations, so `animate` is a stand-in that records its targets.
  it("plays a row's own icon loop on hover, once the pointer rests", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const animated: Element[] = [];
    const animate = vi.fn(function (this: Element) {
      animated.push(this);
      return Object.assign(new EventTarget(), { cancel: vi.fn() });
    });
    Object.defineProperty(Element.prototype, "animate", {
      value: animate,
      configurable: true,
      writable: true,
    });
    try {
      renderSidebar();
      await screen.findByText("Donna");
      const apps = screen.getByRole("link", { name: "Apps" });
      fireEvent.mouseEnter(apps);
      expect(animated).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(animated.length).toBeGreaterThan(0);
      const plug = apps.querySelector("svg");
      for (const el of animated) {
        expect(el === plug || plug?.contains(el)).toBe(true);
      }
    } finally {
      Reflect.deleteProperty(Element.prototype, "animate");
      vi.useRealTimers();
    }
  });
});

describe("inside a BYO agent", () => {
  it("shows only the rows its kind has", async () => {
    state.pathname = "/w/p1/agents/ag-b/connections";
    renderSidebar();
    await screen.findByText("Laptop");
    expect(links()).toEqual(["Apps"]);
    expect(screen.getByRole("link", { name: "Apps" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

describe("outside an agent", () => {
  it("lists the scope's rows instead", async () => {
    state.pathname = "/org/o1/team";
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardSidebar
          workspaceId={undefined}
          orgId="o1"
          navItems={[
            {
              title: "Members",
              url: "/org/o1/team",
              icon: (() => null) as never,
            },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(
      within(container).getByRole("link", { name: "Members" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
  });

  // The org's and workspace's rows are the same NavLink: their icons play
  // their own loops too (here the org's Skills sparkle).
  it("plays a scope row's icon loop on hover", async () => {
    state.pathname = "/org/o1/skills";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const animated: Element[] = [];
    Object.defineProperty(Element.prototype, "animate", {
      value: vi.fn(function (this: Element) {
        animated.push(this);
        return Object.assign(new EventTarget(), { cancel: vi.fn() });
      }),
      configurable: true,
      writable: true,
    });
    try {
      const { getNavItems } = await import("@/lib/nav-config");
      const { container } = render(
        <QueryClientProvider client={new QueryClient()}>
          <DashboardSidebar
            workspaceId={undefined}
            orgId="o1"
            navItems={getNavItems("o1", {
              entitled: true,
              hosted: true,
            }).flat()}
          />
        </QueryClientProvider>,
      );
      const skills = within(container).getByRole("link", { name: "Skills" });
      fireEvent.mouseEnter(skills);
      await vi.advanceTimersByTimeAsync(150);
      expect(animated.length).toBeGreaterThan(0);
      const sparkle = skills.querySelector("svg");
      for (const el of animated) {
        expect(el === sparkle || sparkle?.contains(el)).toBe(true);
      }
    } finally {
      Reflect.deleteProperty(Element.prototype, "animate");
      vi.useRealTimers();
    }
  });
});
