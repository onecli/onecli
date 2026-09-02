// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connections as connectionsApi, grants } from "@/lib/api";
import type { Connection } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { AppsSection } from "./apps-section";

// The deep-link state machine is the unit; the tab body and the sheet bring
// their own data graphs.
vi.mock("./apps-tab", () => ({
  AppsTab: () => <div data-testid="apps-tab" />,
}));
vi.mock("./manage-permissions-dialog", () => ({
  ManagePermissionsDialog: ({
    connection,
    onClose,
  }: {
    connection: Connection | null;
    onClose: () => void;
  }) =>
    connection ? (
      <div data-testid="manage-sheet">
        {connection.id}
        <button data-testid="close-sheet" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}));

// Mutable search params: the section reads them through useSearchParams.
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => search,
  usePathname: () => "/w/ws-1/agents/agent-1",
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    grants: {
      ...actual.grants,
      forAgent: vi.fn(),
    },
    connections: {
      ...actual.connections,
      list: vi.fn(),
    },
  };
});

const conn = (id: string): Connection => ({
  id,
  provider: "gmail",
  label: null,
  status: "connected",
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-08-01T00:00:00Z",
});

const emptyGrants = {
  agentId: "agent-1",
  mode: "grants" as const,
  connections: [],
  secrets: [],
};

const seededClient = (connections: Connection[]) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    queryKeys.connections.list("workspace"),
    connections,
  );
  queryClient.setQueryData(queryKeys.grants.agent("agent-1"), emptyGrants);
  queryClient.setQueryData(
    [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
    { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
  );
  return queryClient;
};

const renderSection = (connections: Connection[]) => {
  const queryClient = seededClient(connections);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    ...render(<AppsSection agentId="agent-1" />, { wrapper }),
    queryClient,
  };
};

describe("AppsSection ?connection=&manage=1 deep link", () => {
  afterEach(() => {
    search = new URLSearchParams();
    vi.mocked(grants.forAgent).mockReset();
    vi.mocked(connectionsApi.list).mockReset();
    window.history.replaceState(null, "", "/w/ws-1/agents/agent-1");
  });

  it("opens the sheet for the linked connection and strips the params", async () => {
    window.history.replaceState(
      null,
      "",
      "/w/ws-1/agents/agent-1?connection=conn-1&manage=1&tab=apps",
    );
    search = new URLSearchParams("connection=conn-1&manage=1&tab=apps");
    renderSection([conn("conn-1")]);

    expect(await screen.findByTestId("manage-sheet")).toHaveTextContent(
      "conn-1",
    );
    // Consumption strips ONLY its own params — the rest of the URL survives.
    await waitFor(() => expect(window.location.search).toBe("?tab=apps"));
  });

  it("ignores a link whose connection is not in the caller's own pool", async () => {
    search = new URLSearchParams("connection=alien-1&manage=1");
    renderSection([conn("conn-1")]);
    await act(async () => {});
    expect(screen.queryByTestId("manage-sheet")).toBeNull();
  });

  it("re-fires for a NEW value but never for the same one (per-value guard)", async () => {
    search = new URLSearchParams("connection=conn-1&manage=1");
    const { rerender, queryClient } = renderSection([
      conn("conn-1"),
      conn("conn-2"),
    ]);
    expect(await screen.findByTestId("manage-sheet")).toHaveTextContent(
      "conn-1",
    );

    // User closes the sheet. A dep-triggered effect re-run under the
    // still-parameterized searchParams (they lag the replaceState strip)
    // must NOT re-open it — the value was consumed. The re-run is the real
    // production one: the grant sweep refetches connections, delivering a
    // genuinely new array (a fresh row defeats structural sharing).
    const user = userEvent.setup();
    await user.click(screen.getByTestId("close-sheet"));
    vi.mocked(connectionsApi.list).mockResolvedValue([
      conn("conn-1"),
      conn("conn-2"),
      conn("conn-3"),
    ]);
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.connections.all(),
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByTestId("manage-sheet")).toBeNull();

    // A second add lands a NEW id in the same mount: the sheet must retarget.
    search = new URLSearchParams("connection=conn-2&manage=1");
    rerender(<AppsSection agentId="agent-1" />);
    expect(await screen.findByTestId("manage-sheet")).toHaveTextContent(
      "conn-2",
    );
  });

  it("waits for an in-flight grants refetch before seeding the sheet", async () => {
    // The add door's race: the connection list already shows the new id while
    // the grants refetch is still airborne — seeding then would show a
    // just-granted connection as unattached.
    let releaseGrants!: (value: typeof emptyGrants) => void;
    vi.mocked(grants.forAgent).mockReturnValue(
      new Promise((resolve) => {
        releaseGrants = resolve;
      }),
    );
    // Mount WITHOUT the link — the race is a link arriving while the write's
    // refetch is airborne, not a link present at mount.
    const { rerender, queryClient } = renderSection([conn("conn-1")]);

    // The grant write's invalidation: the grants query refetches over stale
    // cache. THEN the deep link lands (onGranted fires it right after).
    await act(async () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.grants.agent("agent-1"),
      });
    });
    search = new URLSearchParams("connection=conn-1&manage=1");
    rerender(<AppsSection agentId="agent-1" />);
    await act(async () => {});
    expect(screen.queryByTestId("manage-sheet")).toBeNull();

    // The refetch lands → the gate clears → the sheet opens from fresh state.
    act(() => releaseGrants(emptyGrants));
    expect(await screen.findByTestId("manage-sheet")).toHaveTextContent(
      "conn-1",
    );
  });
});
