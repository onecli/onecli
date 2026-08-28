// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grants } from "@/lib/api";
import type { Connection } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { AttachConnectionDialog } from "./attach-connection-dialog";

// The drawer brings its own data graph; the unit here is which connection the
// dialog targets it at (the apps-section stub pattern).
vi.mock("../../_components/manage-permissions-dialog", () => ({
  ManagePermissionsDialog: ({
    connection,
    onClose,
  }: {
    connection: Connection | null;
    onClose: () => void;
  }) =>
    connection ? (
      <div data-testid="manage-drawer">
        <span data-testid="manage-target">{connection.id}</span>
        <button onClick={onClose}>close drawer</button>
      </div>
    ) : null,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    grants: {
      ...actual.grants,
      setConnectionGrant: vi.fn().mockResolvedValue({}),
      detachConnection: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const gmailConnection = (id: string, label: string | null = null): Connection =>
  ({
    id,
    provider: "gmail",
    label,
    status: "connected",
    scopes: [],
    scope: "workspace",
    metadata: null,
    connectedAt: "2026-08-01T00:00:00Z",
  }) as Connection;

interface SeedOptions {
  connections?: Connection[];
  grantedIds?: string[];
  credentials?: unknown[];
  definitions?: unknown[];
}

/** Seeded client so the dialog's queries never hit the network: connections
 * pool, the agent's grants, its effective credentials, and the permission
 * catalog (which decides whether rows carry Manage). */
const renderDialog = (
  {
    connections = [],
    grantedIds = [],
    credentials = [],
    definitions = [],
  }: SeedOptions = {},
  props: Partial<Parameters<typeof AttachConnectionDialog>[0]> = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    queryKeys.connections.list("workspace"),
    connections,
  );
  queryClient.setQueryData(queryKeys.grants.agent("agent-1"), {
    agentId: "agent-1",
    mode: "grants",
    connections: grantedIds.map((connectionId) => ({ connectionId })),
    secrets: [],
  });
  queryClient.setQueryData(
    [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
    {
      agentId: "agent-1",
      mode: "selective",
      secrets: [],
      connections: credentials,
    },
  );
  queryClient.setQueryData(
    queryKeys.appPermissionDefinitions.list(),
    definitions,
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <AttachConnectionDialog
      agentId="agent-1"
      provider="gmail"
      open
      onOpenChange={vi.fn()}
      {...props}
    />,
    { wrapper },
  );
};

describe("AttachConnectionDialog", () => {
  beforeEach(() => {
    // The unattached-row ceiling probe (ConnectionGrantRow) fires a live query
    // when a catalog exists — keep it pending rather than let it hit jsdom.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(grants.setConnectionGrant).mockClear();
    vi.mocked(grants.detachConnection).mockClear();
  });

  it("shows the loading gate — toggles never render over unknown grant state", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // Nothing seeded: every query hangs on the stubbed fetch.
    render(
      <QueryClientProvider client={queryClient}>
        <AttachConnectionDialog
          agentId="agent-1"
          provider="gmail"
          open
          onOpenChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Loading connections…")).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("shows an error state on a failed load — never the empty-state copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // Grants + credentials + catalog resolved; the connections list fails.
    queryClient.setQueryData(queryKeys.grants.agent("agent-1"), {
      agentId: "agent-1",
      mode: "grants",
      connections: [],
      secrets: [],
    });
    queryClient.setQueryData(
      [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
      { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
    );
    queryClient.setQueryData(queryKeys.appPermissionDefinitions.list(), []);
    render(
      <QueryClientProvider client={queryClient}>
        <AttachConnectionDialog
          agentId="agent-1"
          provider="gmail"
          open
          onOpenChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load Gmail accounts for this agent.",
    );
    expect(screen.queryByText(/No connected Gmail accounts/)).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("lists only this provider's CONNECTED accounts", () => {
    renderDialog({
      connections: [
        gmailConnection("conn-1"),
        gmailConnection("conn-2", "Work inbox"),
        { ...gmailConnection("conn-3"), status: "expired" } as Connection,
        { ...gmailConnection("conn-4"), provider: "slack" } as Connection,
      ],
    });
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(screen.getByText("Work inbox")).toBeInTheDocument();
  });

  it("empty pool: honest copy and the singular Connect label", () => {
    const onConnectNew = vi.fn();
    renderDialog({}, { onConnectNew });
    expect(
      screen.getByText("No connected Gmail accounts in this workspace yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect an account" }),
    ).toBeInTheDocument();
  });

  it("attaches with FULL access on toggle-on — the stated consent contract", async () => {
    renderDialog({ connections: [gmailConnection("conn-1")] });
    await userEvent.click(screen.getByRole("switch", { name: "Attach Gmail" }));
    await waitFor(() =>
      expect(grants.setConnectionGrant).toHaveBeenCalledWith(
        "agent-1",
        "conn-1",
        { access: "full" },
      ),
    );
  });

  it("detaches on toggle-off", async () => {
    renderDialog({
      connections: [gmailConnection("conn-1")],
      grantedIds: ["conn-1"],
    });
    await userEvent.click(screen.getByRole("switch", { name: "Detach Gmail" }));
    await waitFor(() =>
      expect(grants.detachConnection).toHaveBeenCalledWith("agent-1", "conn-1"),
    );
  });

  it("locks an org-rule-granted account ON — checked, disabled, attributed", () => {
    renderDialog({
      connections: [gmailConnection("conn-1")],
      credentials: [
        {
          kind: "connection",
          id: "conn-1",
          label: null,
          provider: "gmail",
          status: "usable",
          orgBlocked: false,
          provenance: [{ scope: "organization" }],
        },
      ],
    });
    const toggle = screen.getByRole("switch", { name: "Detach Gmail" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText("Granted by your organization"),
    ).toBeInTheDocument();
  });

  it("keeps an org-BLOCKED attached account detachable but not manageable", () => {
    renderDialog({
      connections: [gmailConnection("conn-1")],
      grantedIds: ["conn-1"],
      credentials: [
        {
          kind: "connection",
          id: "conn-1",
          label: null,
          provider: "gmail",
          status: "blocked",
          orgBlocked: true,
          provenance: [],
        },
      ],
      definitions: [{ provider: "gmail" }],
    });
    const toggle = screen.getByRole("switch", { name: "Detach Gmail" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(
      screen.getByText("Blocked by your organization"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Manage/ })).toBeNull();
  });

  it("opens the permissions drawer targeted at the clicked account", async () => {
    renderDialog({
      connections: [gmailConnection("conn-1"), gmailConnection("conn-2")],
      grantedIds: ["conn-1", "conn-2"],
      definitions: [{ provider: "gmail" }],
    });
    const manageButtons = screen.getAllByRole("button", { name: "Manage" });
    expect(manageButtons).toHaveLength(2);
    await userEvent.click(manageButtons[1]!);
    expect(screen.getByTestId("manage-target")).toHaveTextContent("conn-2");
  });

  it("hides Manage when the provider has no permission catalog", () => {
    renderDialog({
      connections: [gmailConnection("conn-1")],
      grantedIds: ["conn-1"],
      definitions: [],
    });
    expect(screen.queryByRole("button", { name: /Manage/ })).toBeNull();
  });

  it("pivots the footer to plural once an account exists, and fires onConnectNew", async () => {
    const onConnectNew = vi.fn();
    renderDialog(
      { connections: [gmailConnection("conn-1")] },
      { onConnectNew },
    );
    const connect = screen.getByRole("button", {
      name: "Connect another account",
    });
    await userEvent.click(connect);
    expect(onConnectNew).toHaveBeenCalledTimes(1);
  });

  it("renders no connect door when onConnectNew is omitted", () => {
    renderDialog({ connections: [gmailConnection("conn-1")] });
    expect(
      screen.queryByRole("button", { name: /Connect (an|another) account/ }),
    ).toBeNull();
  });
});
