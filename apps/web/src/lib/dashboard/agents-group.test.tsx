// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@onecli/ui/components/sidebar";

/**
 * The Agents group's faces (§3.18 nav as amended), rendered for real: the
 * agent list (BYO and hosted alike, kind-aware links, oldest first), the New
 * agent row under the last agent, and the one-highlight law.
 */

const state = vi.hoisted(() => ({
  agents: [] as Array<{
    id: string;
    name: string;
    kind: string;
    createdAt?: string;
    channels?: Array<{ provider: string; status?: string }>;
  }>,
  agentsPending: false,
  pathname: "/w/p1/activity",
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
  state.pathname = "/w/p1/activity";
});

describe("the group's frame", () => {
  it("has no Manage agents row — only agents and the New agent row", () => {
    state.agents = [HOSTED];
    renderGroup();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.queryByText(/Manage Agents/i)).toBeNull();
    expect(
      screen.getAllByRole("link").map((el) => el.getAttribute("href")),
    ).toEqual(["/w/p1/agents/ag-1/chat"]);
  });

  it("puts the New agent row under the LAST agent", () => {
    state.agents = [HOSTED, BYO];
    renderGroup();
    const items = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(items.at(-1)).toBe("New agent");
  });

  it("still offers New agent in an empty workspace", () => {
    renderGroup();
    expect(screen.getByText("New agent")).toBeInTheDocument();
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

  it("lists the OLDEST agent on top — the one a bare workspace URL opens", () => {
    // The API answers newest-first; the group re-orders.
    state.agents = [
      {
        ...BYO,
        id: "ag-new",
        name: "Newest",
        createdAt: "2026-10-03T00:00:00Z",
      },
      {
        ...HOSTED,
        id: "ag-old",
        name: "Oldest",
        createdAt: "2026-10-01T00:00:00Z",
      },
      {
        ...BYO,
        id: "ag-mid",
        name: "Middle",
        createdAt: "2026-10-02T00:00:00Z",
      },
    ];
    renderGroup();
    const agentRows = screen.getAllByRole("link").map((el) => el.textContent);
    expect(agentRows).toEqual(["Oldest", "Middle", "Newest"]);
  });
});

describe("what the group highlights", () => {
  const activeNames = () =>
    screen
      .getAllByRole("link")
      .filter((el) => el.dataset.active === "true")
      .map((el) => el.textContent);

  it("highlights the agent anywhere inside that agent", () => {
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

  it("highlights nothing inside an agent that has no row", () => {
    // An agent missing from the list (deleted, or the list resolved empty):
    // no other row may claim to be where the user is.
    state.agents = [HOSTED];
    state.pathname = "/w/p1/agents/ag-2/connections";
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
});
