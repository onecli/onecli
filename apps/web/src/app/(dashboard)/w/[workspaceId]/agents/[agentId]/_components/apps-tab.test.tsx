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
// Unentitled: the licensed "Connect your Slack" row stays out of the split.
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => null,
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
  ConnectionGrantRow: ({ connection }: { connection: Connection }) => (
    <div data-testid="row">{connection.label}</div>
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

  it("keeps every row in view unfolded, for the new agent's chooser where each row IS the choice", () => {
    hoisted.connections = [conn("on"), conn("off1"), conn("off2")];
    hoisted.granted = ["on"];
    hoisted.orgGranted = [];
    render(
      <AppsTab agentId="agent-1" onManage={vi.fn()} foldInactive={false} />,
    );
    expect(screen.getAllByTestId("row").map((r) => r.textContent)).toEqual([
      "on",
      "off1",
      "off2",
    ]);
    expect(
      screen.queryByRole("button", { name: /Inactive connections/ }),
    ).toBeNull();
    expect(screen.queryByText(/No apps are on for this agent yet/)).toBeNull();
  });
});
