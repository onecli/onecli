// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { AgentGrantConnection, Connection } from "@/lib/api";
import { ConnectionGrantRow } from "./connection-grant-row";

/**
 * The row itself (not stubbed): on the agent page it carries Manage and the
 * ⋮ menu beside its switch. The ⋮ menu goes with `compact` (the new agent's
 * chooser tile), and Manage with an `onManage` handler, which the chooser
 * never passes, so there the switch is the row's only control.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/connections",
}));
vi.mock("@/hooks/use-grants", () => ({
  useSetConnectionGrant: () => ({ mutate: vi.fn() }),
  useDetachConnection: () => ({ mutate: vi.fn() }),
  useGrantSettling: () => false,
  // The ⋮ menu's Reconnect watcher imports it.
  useInvalidateGrants: () => vi.fn(),
}));
vi.mock("@/lib/api/policy-visibility", () => ({
  useEffectiveAppPermissions: () => ({ data: undefined }),
}));

const connection: Connection = {
  id: "conn-1",
  provider: "gmail",
  label: "alex@example.com",
  status: "connected",
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-10-01T00:00:00Z",
};
const grant: AgentGrantConnection = {
  connectionId: "conn-1",
  provider: "gmail",
  label: "alex@example.com",
  scope: "workspace",
  access: "full",
  allow: [],
  ask: [],
  otherReads: "allow",
  otherWrites: "ask",
  resources: null,
};

const renderRow = (
  props: Partial<Parameters<typeof ConnectionGrantRow>[0]> = {},
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionGrantRow
        agentId="agent-1"
        connection={connection}
        grant={grant}
        orgGranted={false}
        credentialStatus={undefined}
        credentialOrgBlocked={false}
        hasCatalog
        {...props}
      />
    </QueryClientProvider>,
  );

describe("ConnectionGrantRow", () => {
  it("carries Manage and the ⋮ menu beside the switch on the agent page", () => {
    renderRow({ onManage: vi.fn() });
    expect(
      screen.getByRole("switch", { name: "Detach alex@example.com" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manage/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions for alex@example.com" }),
    ).toBeInTheDocument();
  });

  it("drops the ⋮ menu as a compact tile, and Manage without a handler", () => {
    const { unmount } = renderRow({ compact: true, onManage: vi.fn() });
    expect(screen.getByRole("button", { name: /Manage/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
    unmount();

    renderRow();
    expect(screen.queryByRole("button", { name: /Manage/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "More actions for alex@example.com" }),
    ).toBeInTheDocument();
  });

  it("is switch-only in the chooser: compact, no Manage, no ⋮ menu", () => {
    renderRow({ compact: true });
    expect(
      screen.getByRole("switch", { name: "Detach alex@example.com" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Manage/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });
});
