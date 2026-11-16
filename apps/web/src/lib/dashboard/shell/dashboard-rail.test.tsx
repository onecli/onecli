// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TooltipProvider } from "@onecli/ui/components/tooltip";

/**
 * The rail. The logo goes to the page the workspace opens on (its oldest
 * agent), read off the list the rail already holds, so it lands in one hop
 * instead of through the workspace's forwarding URL; and while that list
 * loads, the agent squares hold their places instead of the rail
 * collapsing and refilling.
 */

const state = vi.hoisted(() => ({
  agents: undefined as
    | { id: string; name: string; kind: string; createdAt: string }[]
    | undefined,
  isPending: true,
  pathname: "/w/ws1/agents/ag-new/chat",
  warmed: [] as string[],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/hooks/use-agents", () => ({
  useAgentsForWorkspace: () => ({
    data: state.agents,
    isPending: state.isPending,
  }),
  useWarmAgent: () => (agent: { id: string }) => state.warmed.push(agent.id),
}));
vi.mock("@/lib/settings-modal/use-settings-href", () => ({
  useSettingsHref: () => (page: string) => `?settings=${page}`,
}));
vi.mock("./new-agent-square", () => ({ NewAgentSquare: () => null }));
vi.mock("./rail-user-menu", () => ({ RailUserMenu: () => null }));

const { DashboardRail } = await import("./dashboard-rail");
const { RAIL_APPROACH_DWELL_MS } = await import("./rail-item");

const renderRail = (workspaceId: string | null = "ws1") =>
  render(
    <TooltipProvider>
      <DashboardRail workspaceId={workspaceId} orgHref="/org/o1/workspaces" />
    </TooltipProvider>,
  ).container;

beforeEach(() => {
  state.agents = undefined;
  state.isPending = true;
  state.pathname = "/w/ws1/agents/ag-new/chat";
  state.warmed = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const logo = () => screen.getByRole("link", { name: "OneCLI" });

describe("DashboardRail", () => {
  it("sends the logo straight to the workspace's oldest agent", () => {
    state.isPending = false;
    state.agents = [
      { id: "ag-new", name: "New", kind: "hosted", createdAt: "2026-03-01" },
      { id: "ag-old", name: "Old", kind: "byo", createdAt: "2026-01-01" },
    ];
    renderRail();
    expect(logo()).toHaveAttribute("href", "/w/ws1/agents/ag-old/connections");
  });

  it("sends the logo to agent creation in an empty workspace", () => {
    state.isPending = false;
    state.agents = [];
    renderRail();
    expect(logo()).toHaveAttribute("href", "/w/ws1/agents");
  });

  it("falls back to the workspace's front door while the list loads", () => {
    renderRail();
    expect(logo()).toHaveAttribute("href", "/w/ws1");
  });

  it("sends the logo to the org's home outside a workspace", () => {
    renderRail(null);
    expect(logo()).toHaveAttribute("href", "/org/o1/workspaces");
  });

  // The gear opens the Settings modal over the page; the account's own page
  // (the shell shows it only to a viewer with no org) has no org for it.
  it("offers the Settings gear on a URL that names an org, not on the account's page", () => {
    renderRail();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "?settings=apps",
    );
    cleanup();
    state.pathname = "/account";
    renderRail(null);
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("holds the agent squares' places while the list loads, then shows the agents", () => {
    const rail = renderRail();
    expect(rail.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
    state.isPending = false;
    state.agents = [
      { id: "ag-new", name: "New", kind: "hosted", createdAt: "2026-03-01" },
    ];
    cleanup();
    const loaded = renderRail();
    expect(loaded.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    expect(screen.getByRole("link", { name: "New" })).toBeInTheDocument();
  });

  // An idle agent's hover is the rail square's wash, a shade darker (the
  // avatar covers most of it), fading in and out; the one on screen keeps
  // its brand ring and no wash.
  it("gives idle agents the darker hover wash, the active one the brand ring", () => {
    state.isPending = false;
    state.agents = [
      { id: "ag-new", name: "New", kind: "hosted", createdAt: "2026-03-01" },
      { id: "ag-old", name: "Old", kind: "byo", createdAt: "2026-01-01" },
    ];
    renderRail();
    const idle = screen.getByRole("link", { name: "Old" }).className;
    const active = screen.getByRole("link", { name: "New" }).className;
    expect(idle).toContain("hover:bg-foreground/[0.12]");
    expect(idle).not.toContain("hover:bg-foreground/[0.06]");
    expect(idle).toContain("transition-colors");
    expect(idle).toContain("duration-200");
    expect(active).toContain("ring-brand");
    expect(active).not.toContain("hover:bg-foreground");
  });

  // The rail is a column: a pointer heading for the bottom square crosses
  // every square above it. Firing on entry alone woke every agent the
  // pointer crossed, and the wanted one queued behind machines nobody
  // asked for.
  // An approach is a pointer that RESTS on a square, or keyboard focus.
  it("warms an agent the pointer rests on, never the ones it passes through", () => {
    vi.useFakeTimers();
    state.isPending = false;
    state.agents = [
      { id: "ag-a", name: "A", kind: "hosted", createdAt: "2026-01-01" },
      { id: "ag-b", name: "B", kind: "hosted", createdAt: "2026-01-02" },
      { id: "ag-c", name: "C", kind: "hosted", createdAt: "2026-01-03" },
    ];
    renderRail();
    const square = (name: string) => screen.getByRole("link", { name });
    // The pointer sweeps A and B on its way to C.
    fireEvent.pointerEnter(square("A"));
    act(() => vi.advanceTimersByTime(40));
    fireEvent.pointerLeave(square("A"));
    fireEvent.pointerEnter(square("B"));
    act(() => vi.advanceTimersByTime(40));
    fireEvent.pointerLeave(square("B"));
    fireEvent.pointerEnter(square("C"));
    act(() => vi.advanceTimersByTime(RAIL_APPROACH_DWELL_MS - 1));
    expect(state.warmed).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(state.warmed).toEqual(["ag-c"]);
    // Resting longer fires nothing more; leaving and coming back is a new
    // approach, judged afresh.
    act(() => vi.advanceTimersByTime(RAIL_APPROACH_DWELL_MS * 4));
    expect(state.warmed).toEqual(["ag-c"]);
  });

  it("warms on keyboard focus at once: focus is deliberate", () => {
    vi.useFakeTimers();
    state.isPending = false;
    state.agents = [
      { id: "ag-a", name: "A", kind: "hosted", createdAt: "2026-01-01" },
    ];
    renderRail();
    fireEvent.focus(screen.getByRole("link", { name: "A" }));
    expect(state.warmed).toEqual(["ag-a"]);
  });

  it("a square unmounted mid-dwell never fires", () => {
    vi.useFakeTimers();
    state.isPending = false;
    state.agents = [
      { id: "ag-a", name: "A", kind: "hosted", createdAt: "2026-01-01" },
    ];
    renderRail();
    fireEvent.pointerEnter(screen.getByRole("link", { name: "A" }));
    cleanup();
    act(() => vi.advanceTimersByTime(RAIL_APPROACH_DWELL_MS * 2));
    expect(state.warmed).toEqual([]);
  });
});
