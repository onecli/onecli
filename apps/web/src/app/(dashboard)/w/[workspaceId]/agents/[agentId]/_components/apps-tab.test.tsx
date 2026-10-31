// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/api";
import { AppsTab } from "./apps-tab";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/connections",
}));

// The unit is the split: what this agent uses stays in view, the rest folds
// into "Inactive connections". Rows are stubbed to their label; their own
// switch logic has its own suite.
const hoisted = vi.hoisted(() => ({
  connections: [] as Connection[],
  granted: [] as string[],
  orgGranted: [] as string[],
  entitled: false,
}));

vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({
    data: hoisted.connections,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/use-grants", () => ({
  useAgentGrants: () => ({
    data: {
      connections: hoisted.granted.map((connectionId) => ({
        connectionId,
        access: "full",
        allow: [],
        ask: [],
      })),
      secrets: [],
    },
    isPending: false,
    isError: false,
  }),
}));
// Unentitled unless a test says otherwise: the licensed "Connect your Slack"
// row stays out of the split.
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => (hoisted.entitled ? { entitled: true } : null),
}));
vi.mock("@/ee/slack-read/slack-read-connection-row", () => ({
  SlackReadConnectionRow: () => <div data-testid="slack-row" />,
}));
vi.mock("@/hooks/use-app-permissions", () => ({
  useAppPermissionDefinitions: () => ({ data: [] }),
}));
vi.mock("@/lib/api/policy-visibility", () => ({
  useEffectiveCredentials: () => ({
    data: {
      connections: hoisted.orgGranted.map((id) => ({
        id,
        kind: "connection",
        orgBlocked: false,
        status: { status: "viaRule" },
        provenance: [{ scope: "organization" }],
      })),
      secrets: [],
    },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("./connection-grant-row", () => ({
  ConnectionGrantRow: ({
    connection,
    compact,
    onManage,
  }: {
    connection: Connection;
    compact?: boolean;
    onManage?: () => void;
  }) => (
    <div
      data-testid="row"
      data-compact={String(!!compact)}
      data-manage={String(!!onManage)}
    >
      {connection.label}
    </div>
  ),
}));

const conn = (id: string): Connection => ({
  id,
  provider: "github-app",
  label: id,
  status: "connected",
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-10-01T00:00:00Z",
});

describe("AppsTab active / inactive split", () => {
  it("shows active connections and folds the inactive ones away", async () => {
    hoisted.connections = [conn("on"), conn("org"), conn("off1"), conn("off2")];
    hoisted.granted = ["on"];
    hoisted.orgGranted = ["org"];
    render(<AppsTab agentId="agent-1" onManage={vi.fn()} />);

    expect(screen.getByText("on")).toBeInTheDocument();
    expect(screen.getByText("org")).toBeInTheDocument();
    expect(screen.queryByText("off1")).toBeNull();

    const fold = screen.getByRole("button", { name: /Inactive connections/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(fold).toHaveTextContent("2");

    await userEvent.setup().click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("off1")).toBeInTheDocument();
    expect(screen.getByText("off2")).toBeInTheDocument();
  });

  it("hides the fold when everything is active", () => {
    hoisted.connections = [conn("on")];
    hoisted.granted = ["on"];
    hoisted.orgGranted = [];
    render(<AppsTab agentId="agent-1" onManage={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /Inactive connections/ }),
    ).toBeNull();
  });

  it("says so when nothing is on yet, with the rest folded below", () => {
    hoisted.connections = [conn("off")];
    hoisted.granted = [];
    hoisted.orgGranted = [];
    render(<AppsTab agentId="agent-1" onManage={vi.fn()} />);
    expect(screen.getByText(/No apps are on for this agent yet/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Inactive connections/ }),
    ).toBeInTheDocument();
  });

  it("keeps every row in view in the new agent's chooser, where each row IS the choice", () => {
    hoisted.connections = [conn("on"), conn("off2"), conn("off1")];
    hoisted.granted = ["on"];
    hoisted.orgGranted = [];
    render(<AppsTab agentId="agent-1" chooser />);
    const rows = screen.getAllByTestId("row");
    // A to Z (same app here, so by account), not the API's newest-first.
    expect(rows.map((r) => r.textContent)).toEqual(["off1", "off2", "on"]);
    // Switch-only tiles: no ⋮ menu (compact) and no Manage (no handler).
    expect(rows.every((r) => r.dataset.compact === "true")).toBe(true);
    expect(rows.every((r) => r.dataset.manage === "false")).toBe(true);
    expect(
      screen.queryByRole("button", { name: /Inactive connections/ }),
    ).toBeNull();
    expect(screen.queryByText(/No apps are on for this agent yet/)).toBeNull();
  });

  it("keeps the full rows (and the API order) on the agent's own page", () => {
    hoisted.connections = [conn("b"), conn("a")];
    hoisted.granted = ["b", "a"];
    hoisted.orgGranted = [];
    render(<AppsTab agentId="agent-1" onManage={vi.fn()} />);
    const rows = screen.getAllByTestId("row");
    expect(rows.map((r) => r.textContent)).toEqual(["b", "a"]);
    expect(rows.every((r) => r.dataset.compact === "false")).toBe(true);
    expect(rows.every((r) => r.dataset.manage === "true")).toBe(true);
  });

  it("lists the caller's Slack on the agent page, never in the new agent's chooser", async () => {
    hoisted.connections = [conn("on")];
    hoisted.granted = ["on"];
    hoisted.orgGranted = [];
    hoisted.entitled = true;
    try {
      const { unmount } = render(
        <AppsTab agentId="agent-1" onManage={vi.fn()} />,
      );
      // Lazy (next/dynamic), so it lands a tick after the rows.
      expect(await screen.findByTestId("slack-row")).toBeInTheDocument();
      unmount();

      // The lazy module resolved above, so a row it rendered would already
      // be here: its absence is the chooser's rule, not a pending load.
      // Both shapes: a full pool, and an empty one (whose empty state the
      // section otherwise heads with the Slack row).
      const chooser = render(<AppsTab agentId="agent-1" chooser />);
      expect(screen.getByTestId("row")).toBeInTheDocument();
      expect(screen.queryByTestId("slack-row")).toBeNull();
      chooser.unmount();

      hoisted.connections = [];
      render(<AppsTab agentId="agent-1" chooser />);
      expect(screen.getByText("No connected apps")).toBeInTheDocument();
      expect(screen.queryByTestId("slack-row")).toBeNull();
    } finally {
      hoisted.entitled = false;
    }
  });
});
