// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@onecli/ui/components/sidebar";

/**
 * The Agents group's faces (§3.18 nav as amended 2026-08-16), rendered for
 * real: the unconditional Manage agents row, the agent list (BYO and hosted
 * alike, kind-aware links), the separator between management and agents, and
 * the one-highlight law.
 */

const state = vi.hoisted(() => ({
  agents: [] as Array<{
    id: string;
    name: string;
    kind: string;
    channels?: Array<{ provider: string; status?: string }>;
  }>,
  agentsPending: false,
  pathname: "/w/p1/overview",
}));

vi.mock("@/hooks/use-agents", () => ({
  // Honors `workspaceId`, `enabled` and `isPending` like the real hook: a
  // disabled or still-loading query holds NO data. The group calls this
  // always-enabled; the explicit workspaceId (never the URL scope) is the
  // sidebar's 500-proofing — chrome can query while the browser sits on a
  // non-workspace URL.
  useAgentsForWorkspace: (workspaceId: string, enabled?: boolean) =>
    enabled === false || workspaceId === "" || state.agentsPending
      ? { data: undefined, isPending: true }
      : { data: state.agents, isPending: false },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

// Structural chrome (the Slack mark renders through AppIcon → next/image).
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));

const { AgentsGroup } = await import("./agents-group");

// The sidebar primitives read their provider (and it reads matchMedia).
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

const renderGroup = () =>
  render(
    <SidebarProvider>
      <AgentsGroup workspaceId="p1" />
    </SidebarProvider>,
  );

const HOSTED = { id: "ag-1", name: "Support Triage", kind: "hosted" };
const BYO = { id: "ag-2", name: "Laptop", kind: "byo" };

beforeEach(() => {
  state.agents = [];
  state.agentsPending = false;
  state.pathname = "/w/p1/overview";
});

describe("the Manage agents row is unconditional", () => {
  it("renders the group label and Manage agents link", () => {
    renderGroup();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    const manageAgents = screen.getByRole("link", { name: /Manage Agents/ });
    expect(manageAgents).toHaveAttribute("href", "/w/p1/agents");
  });
});

describe("the agents list (§3.18 as amended)", () => {
  it("lists BYO and hosted agents with kind-aware landings", () => {
    state.agents = [HOSTED, BYO];
    renderGroup();

    expect(
      screen.getByRole("link", { name: /Support Triage/ }),
    ).toHaveAttribute("href", "/w/p1/agents/ag-1/chat");
    expect(screen.getByRole("link", { name: /Laptop/ })).toHaveAttribute(
      "href",
      "/w/p1/agents/ag-2/connections",
    );
  });

  it("separates management from the list only when rows exist", () => {
    state.agents = [];
    const { container, unmount } = renderGroup();
    expect(
      container.querySelector('[data-sidebar="separator"]'),
    ).not.toBeInTheDocument();
    unmount();

    state.agents = [BYO];
    const { container: withRows } = renderGroup();
    expect(
      withRows.querySelector('[data-sidebar="separator"]'),
    ).toBeInTheDocument();
  });
});

describe("what the group highlights", () => {
  const activeNames = () =>
    screen
      .getAllByRole("link")
      .filter((el) => el.dataset.active === "true")
      .map((el) => el.textContent);

  it("highlights Manage agents on the agents list itself", () => {
    state.agents = [HOSTED];
    state.pathname = "/w/p1/agents";
    renderGroup();
    expect(activeNames()).toEqual(["Manage Agents"]);
  });

  it("highlights the agent — and NOT Manage agents — anywhere inside that agent", () => {
    state.agents = [HOSTED];
    for (const path of [
      "/w/p1/agents/ag-1/chat",
      "/w/p1/agents/ag-1",
      "/w/p1/agents/ag-1/connections",
    ]) {
      state.pathname = path;
      const { unmount } = renderGroup();
      expect(activeNames()).toEqual(["Support Triage"]);
      unmount();
    }
  });

  it("highlights the BYO agent's own row inside that agent", () => {
    state.agents = [HOSTED, BYO];
    for (const path of ["/w/p1/agents/ag-2", "/w/p1/agents/ag-2/connections"]) {
      state.pathname = path;
      const { unmount } = renderGroup();
      expect(activeNames()).toEqual(["Laptop"]);
      unmount();
    }
  });

  it("highlights Manage agents inside an agent that has no row — never zero rows", () => {
    // An agent missing from the list (deleted, or the list resolved empty):
    // the roster row is the only place the sidebar can point at.
    state.agents = [HOSTED];
    state.pathname = "/w/p1/agents/ag-2/connections";
    renderGroup();
    expect(activeNames()).toEqual(["Manage Agents"]);
  });

  it("highlights NOTHING while the list is still loading — no wrong-then-right flash", () => {
    // A cold load inside an agent's page: until the agent list settles, the
    // sidebar cannot know whether this agent owns a row. Highlighting Manage
    // agents here would flash and then jump.
    state.pathname = "/w/p1/agents/ag-1/chat";
    state.agents = [HOSTED];
    state.agentsPending = true;
    renderGroup();
    expect(activeNames()).toEqual([]);
  });
});

describe("the Slack connected mark (PR #845)", () => {
  const SLACK_ACTIVE = {
    ...HOSTED,
    channels: [{ provider: "slack", status: "active" }],
  };
  const SLACK_PENDING = {
    ...HOSTED,
    channels: [{ provider: "slack", status: "pending_setup" }],
  };

  it("marks a row whose Slack install completed — label via sr-only, not alt/title", () => {
    state.agents = [SLACK_ACTIVE];
    renderGroup();
    expect(screen.getByText("Connected to Slack")).toBeInTheDocument();
  });

  it("does NOT mark a pending_setup presence — row existence is not connection", () => {
    state.agents = [SLACK_PENDING];
    renderGroup();
    expect(screen.queryByText("Connected to Slack")).not.toBeInTheDocument();
  });

  it("does NOT mark agents without a Slack presence", () => {
    state.agents = [HOSTED];
    renderGroup();
    expect(screen.queryByText("Connected to Slack")).not.toBeInTheDocument();
  });

  it("keeps the name span truncating beside the trailing mark", () => {
    // The button variant truncates `span:last-child`; with the mark trailing,
    // the name span is no longer last and must carry its own `truncate`.
    state.agents = [SLACK_ACTIVE];
    renderGroup();
    expect(screen.getByText("Support Triage")).toHaveClass("truncate");
  });
});
