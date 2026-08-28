// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { grants } from "@/lib/api";
import type { Connection } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { ConnectorSuggestions } from "./connect-suggestions";

// Mutable so the no-agent fence is testable (the mock factory is hoisted).
let routeParams: { agentId?: string } = { agentId: "agent-1" };
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  usePathname: () => "/w/ws-1/agents/agent-1/chat",
  useRouter: () => ({ push: pushMock }),
}));

// Unit boundary: the dialog brings its own data graph; the card only has to
// hand it the connection + derived grant/readOnly, covered by typecheck.
vi.mock("../../_components/manage-permissions-dialog", () => ({
  ManagePermissionsDialog: () => null,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    grants: {
      ...actual.grants,
      setConnectionGrant: vi.fn().mockResolvedValue({}),
    },
  };
});

const GMAIL_CONNECT_URL =
  "https://app.onecli.sh/w/a/connections?connect=gmail&source=agent&agent_name=Arik";

const connectedGmail: Connection = {
  id: "conn-1",
  provider: "gmail",
  label: null,
  status: "connected",
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-08-01T00:00:00Z",
};

/** Seeded client so the card's queries never hit the network: connections
 * pool, the agent's grants, and its effective credentials. */
const renderCard = (
  text: string,
  {
    connections = [] as Connection[],
    grantedConnectionIds = [] as string[],
  } = {},
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
    connections: grantedConnectionIds.map((connectionId) => ({
      connectionId,
    })),
    secrets: [],
  });
  // The attach dialog's permission catalog (decides per-row Manage).
  queryClient.setQueryData(queryKeys.appPermissionDefinitions.list(), []);
  queryClient.setQueryData(
    [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
    { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
  );
  // The embedded picker's own graph (mounted after "Browse all apps").
  queryClient.setQueryData(queryKeys.appAvailability.available(), {
    restricted: false,
    providers: [],
  });
  queryClient.setQueryData(queryKeys.agents.detail("agent-1"), {
    id: "agent-1",
    name: "Arik",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<ConnectorSuggestions text={text} />, { wrapper });
};

describe("ConnectorSuggestions card", () => {
  let openSpy: MockInstance<typeof window.open>;

  beforeEach(() => {
    // A truthy handle — a null return is the BLOCKED-popup signal, which
    // releases the initiated claim (tested explicitly below).
    openSpy = vi.spyOn(window, "open").mockReturnValue({} as unknown as Window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(grants.setConnectionGrant).mockClear();
    pushMock.mockClear();
    routeParams = { agentId: "agent-1" };
  });

  it("renders nothing for text without connect links — no QueryClient demanded", () => {
    // No provider wrapper on purpose: the null gate must keep every hook of
    // the inner card unmounted for ordinary bubbles.
    const { container } = render(<ConnectorSuggestions text="plain answer" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the suggestion and opens the popup with agent + workspace context", async () => {
    renderCard(GMAIL_CONNECT_URL);
    expect(screen.getByText("Apps that could help")).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, windowName] = openSpy.mock.calls[0] ?? [];
    expect(url).toContain("/app-connect/gmail?");
    expect(url).toContain("agent_name=Arik");
    expect(url).toContain("workspaceId=ws-1");
    expect(windowName).toBe("connect-gmail-new");
  });

  it("discloses the auto-grant at the point of consent for unconnected rows", () => {
    renderCard(GMAIL_CONNECT_URL);
    expect(
      screen.getByText(/Connecting gives this agent full access/),
    ).toBeInTheDocument();
  });

  it("hides Reconnect for an org-shared connection — re-auth belongs to the org page", () => {
    renderCard(GMAIL_CONNECT_URL, {
      connections: [{ ...connectedGmail, scope: "organization" }],
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reconnect Gmail" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Manage Gmail access" }),
    ).toBeInTheDocument();
  });

  it("disables Manage until grants resolve — the dialog seeds once on open", () => {
    // Grants key deliberately unseeded and fetch hung: the query stays
    // pending, so Manage must be disabled (a stale open would seed a bogus
    // "full access" view).
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.connections.list("workspace"), [
      connectedGmail,
    ]);
    queryClient.setQueryData(
      [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
      { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorSuggestions text={GMAIL_CONNECT_URL} />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Manage Gmail access" }),
    ).toBeDisabled();
  });

  it("flips to Connected with Reconnect + Manage once a connection exists", () => {
    renderCard(GMAIL_CONNECT_URL, { connections: [connectedGmail] });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect Gmail" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage Gmail access" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
  });

  it("auto-grants the agent full access ONLY for a connect this card initiated", async () => {
    renderCard(GMAIL_CONNECT_URL);

    // A popup someone else opened (same origin) reports a new connection:
    // the card must not grant.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "gmail",
            connectionId: "conn-9",
          },
        }),
      );
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();

    // Initiated from this card → the same message now grants full access.
    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "gmail",
            connectionId: "conn-9",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(grants.setConnectionGrant).toHaveBeenCalledWith(
        "agent-1",
        "conn-9",
        { access: "full" },
      ),
    );
    expect(grants.setConnectionGrant).toHaveBeenCalledTimes(1);
  });

  it("never grants on a reconnect — no connectionId in the message", async () => {
    renderCard(GMAIL_CONNECT_URL);
    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "app-connected", provider: "gmail" },
        }),
      );
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("opens the catalog picker from the footer's Browse all apps", async () => {
    renderCard(GMAIL_CONNECT_URL);
    // Lazy-mounted: no hidden dialog before the first open.
    expect(screen.queryByText("Connect an app")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Browse all apps" }),
    );
    expect(screen.getByText("Connect an app")).toBeInTheDocument();
  });

  it("hides the footer door when no agent id is in scope — no dead button", () => {
    routeParams = {};
    renderCard(GMAIL_CONNECT_URL);
    expect(
      screen.queryByRole("button", { name: "Browse all apps" }),
    ).toBeNull();
  });

  it("hides the consent line when every suggested app is already connected", () => {
    renderCard(GMAIL_CONNECT_URL, { connections: [connectedGmail] });
    expect(
      screen.queryByText(/Connecting gives this agent full access/),
    ).toBeNull();
  });

  it("releases the claim when the popup is blocked — a later landing must not grant", async () => {
    openSpy.mockReturnValue(null);
    renderCard(GMAIL_CONNECT_URL);

    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "gmail",
            connectionId: "conn-9",
          },
        }),
      );
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("routes a configure landing ONLY for a connect this card initiated", async () => {
    renderCard(GMAIL_CONNECT_URL);

    // Someone else's popup (the embedded picker, another card) reports it:
    // this card must not navigate — N cards would mean N pushes.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "app-configure", provider: "gmail" },
        }),
      );
    });
    await act(async () => {});
    expect(pushMock).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "app-configure", provider: "gmail" },
        }),
      );
    });
    await act(async () => {});
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringContaining("/connections/apps/gmail"),
    );
  });

  describe("attach-kind rows (access_restricted)", () => {
    const GMAIL_ATTACH_URL = "https://app.onecli.sh/w/a/connections/apps/gmail";

    it("claims nothing about attachment until grants resolve — the door waits", () => {
      // Grants unseeded and fetch hung: the row must not assert the negative
      // ("not attached") it cannot know yet, and the door stays disabled.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      queryClient.setQueryData(queryKeys.connections.list("workspace"), [
        connectedGmail,
      ]);
      queryClient.setQueryData(
        [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
        { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
      );
      render(
        <QueryClientProvider client={queryClient}>
          <ConnectorSuggestions text={GMAIL_ATTACH_URL} />
        </QueryClientProvider>,
      );
      expect(
        screen.queryByText("Connected, not attached to this agent"),
      ).toBeNull();
      expect(screen.getByText("Connected")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Attach Gmail for this agent" }),
      ).toBeDisabled();
    });

    it("names the missing grant and offers Attach — no Reconnect, no legacy Manage", () => {
      renderCard(GMAIL_ATTACH_URL, { connections: [connectedGmail] });
      expect(
        screen.getByText("Connected, not attached to this agent"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Attach Gmail for this agent" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Reconnect Gmail" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Manage Gmail access" }),
      ).toBeNull();
    });

    it("flips to the attached count + Manage once this agent holds a grant", () => {
      renderCard(GMAIL_ATTACH_URL, {
        connections: [connectedGmail],
        grantedConnectionIds: ["conn-1"],
      });
      expect(screen.getByText("1 attached account")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Manage Gmail for this agent" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Attach Gmail for this agent" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Reconnect Gmail" }),
      ).toBeNull();
    });

    it("pluralizes the attached count", () => {
      renderCard(GMAIL_ATTACH_URL, {
        connections: [
          connectedGmail,
          { ...connectedGmail, id: "conn-2" } as Connection,
        ],
        grantedConnectionIds: ["conn-1", "conn-2"],
      });
      expect(screen.getByText("2 attached accounts")).toBeInTheDocument();
    });

    it("opens the attach dialog from the Attach button", async () => {
      renderCard(GMAIL_ATTACH_URL, { connections: [connectedGmail] });
      await userEvent.click(
        screen.getByRole("button", { name: "Attach Gmail for this agent" }),
      );
      expect(
        screen.getByRole("heading", { name: "Attach Gmail" }),
      ).toBeInTheDocument();
      // One row per connected account, toggle off (no grant yet).
      expect(
        screen.getByRole("switch", { name: "Attach Gmail" }),
      ).toBeInTheDocument();
    });

    it("stakes the claim for the dialog's connect-new — the landing auto-grants", async () => {
      renderCard(GMAIL_ATTACH_URL, { connections: [connectedGmail] });
      await userEvent.click(
        screen.getByRole("button", { name: "Attach Gmail for this agent" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Connect another account" }),
      );
      expect(openSpy).toHaveBeenCalledTimes(1);
      const [url, windowName] = openSpy.mock.calls[0] ?? [];
      expect(url).toContain("/app-connect/gmail?");
      expect(url).toContain("workspaceId=ws-1");
      expect(windowName).toBe("connect-gmail-new");

      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: window.location.origin,
            data: {
              type: "app-connected",
              provider: "gmail",
              connectionId: "conn-9",
            },
          }),
        );
      });
      await waitFor(() =>
        expect(grants.setConnectionGrant).toHaveBeenCalledWith(
          "agent-1",
          "conn-9",
          { access: "full" },
        ),
      );
    });
  });

  it("keeps the picker's listener alive after it closes — an in-flight popup still grants", async () => {
    renderCard(GMAIL_CONNECT_URL);
    await userEvent.click(
      screen.getByRole("button", { name: "Browse all apps" }),
    );
    // Initiate from the PICKER (its row), then close it without finishing.
    await userEvent.click(screen.getByRole("button", { name: /^Slack/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Connect an app")).toBeNull();

    // The popup lands after the close: the latched (still-mounted) picker
    // must catch it and grant.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "slack",
            connectionId: "conn-7",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(grants.setConnectionGrant).toHaveBeenCalledWith(
        "agent-1",
        "conn-7",
        { access: "full" },
      ),
    );
  });
});

const GMAIL_ATTACH_URL = "https://app.onecli.sh/w/a/connections/apps/gmail";

/** Seeded like renderCard, but with the grant/effective pools injectable —
 * the attach branch's whole behavior turns on them. */
const renderAttachCard = ({
  connections = [connectedGmail] as Connection[],
  grantedConnectionIds = [] as string[],
  orgGrantedConnectionIds = [] as string[],
} = {}) => {
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
    connections: grantedConnectionIds.map((connectionId) => ({
      connectionId,
      provider: "gmail",
      label: null,
      scope: "workspace",
      access: "full",
      allow: [],
      ask: [],
      resources: null,
    })),
    secrets: [],
  });
  queryClient.setQueryData(
    [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
    {
      agentId: "agent-1",
      mode: "selective",
      secrets: [],
      connections: orgGrantedConnectionIds.map((id) => ({
        id,
        kind: "connection",
        provenance: [{ kind: "rule", scope: "organization", redacted: true }],
        orgBlocked: false,
      })),
    },
  );
  queryClient.setQueryData(queryKeys.appAvailability.available(), {
    restricted: false,
    providers: [],
  });
  queryClient.setQueryData(queryKeys.agents.detail("agent-1"), {
    id: "agent-1",
    name: "Arik",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<ConnectorSuggestions text={GMAIL_ATTACH_URL} />, { wrapper });
};

describe("ConnectorSuggestions attach rows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    routeParams = { agentId: "agent-1" };
  });

  it("names the missing grant and opens the attach dialog from the Attach button", async () => {
    renderAttachCard();
    expect(
      screen.getByText("Connected, not attached to this agent"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Attach Gmail for this agent" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Attach Gmail");
    expect(
      screen.getByRole("switch", { name: "Attach Gmail" }),
    ).not.toBeChecked();
  });

  it("reads Manage with the attached count once a grant exists", () => {
    renderAttachCard({ grantedConnectionIds: ["conn-1"] });
    expect(screen.getByText("1 attached account")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage Gmail for this agent" }),
    ).toBeInTheDocument();
  });

  it("counts only status-connected accounts — a granted but broken connection is not 'attached'", () => {
    // MUTATION-PROOF: drop the status filter from attachedCount and the card
    // claims "1 attached account" for a connection the dialog's own pool
    // (status-connected) would not even list.
    renderAttachCard({
      connections: [
        connectedGmail,
        { ...connectedGmail, id: "conn-2", status: "error" },
      ],
      grantedConnectionIds: ["conn-2"],
    });
    expect(
      screen.getByText("Connected, not attached to this agent"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/attached account/)).toBeNull();
  });

  it("counts an org-rule-granted connection as attached, and locks its dialog row ON", async () => {
    // MUTATION-PROOF twice over: drop orgGrantedConnectionIds from the count
    // and the card says "not attached" for access the org already granted;
    // drop the dialog's org lock and the row renders an OFF toggle whose
    // "detach" could never remove org access.
    renderAttachCard({ orgGrantedConnectionIds: ["conn-1"] });
    expect(screen.getByText("1 attached account")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Manage Gmail for this agent" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Granted by your organization",
    );
    const lockedSwitch = screen.getByRole("switch", {
      name: "Detach Gmail",
    });
    expect(lockedSwitch).toBeChecked();
    expect(lockedSwitch).toBeDisabled();
  });
});
