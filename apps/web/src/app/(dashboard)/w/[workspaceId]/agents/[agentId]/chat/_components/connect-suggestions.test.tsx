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
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  return {
    ...render(<ConnectorSuggestions text={text} />, { wrapper }),
    invalidateSpy,
  };
};

/** A popup's landing message, as the callback page posts it (same origin). */
const landing = (data: Record<string, unknown>) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { origin: window.location.origin, data }),
    );
  });

/** A landing's tell: the grant views refreshed so a new account (already
 * granted to this agent by the API's connecting-agent grant) shows attached.
 * A thunk, because query keys carry the URL's workspace scope, resolved at
 * call time: a module-level constant would capture "default" and make the
 * negative assertions vacuous. */
const refreshedGrants = () => ({ queryKey: queryKeys.grants.all() });

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
    // The connect carries THIS agent: the new account lands on for it alone.
    expect(url).toContain("agent_id=agent-1");
    expect(url).toContain("workspaceId=ws-1");
    expect(windowName).toBe("connect-gmail-new");
  });

  it("discloses at the point of consent that connecting turns the account on for this agent alone", () => {
    renderCard(GMAIL_CONNECT_URL);
    expect(
      screen.getByText(
        /Connecting turns the account on for this agent, not for your other agents\. Reads are allowed\. Writes and anything else need your approval \(an app with no tool list gets full access\)/,
      ),
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

  it("a needs-reconnect link offers Reconnect for that account, not Manage", () => {
    renderCard(
      "https://app.onecli.sh/w/a/connections/apps/gmail?reconnect=conn-2",
      {
        connections: [
          connectedGmail,
          {
            ...connectedGmail,
            id: "conn-2",
            label: "jo@acme.com",
            reauthRequiredAt: "2026-10-01T00:00:00Z",
          },
        ],
        grantedConnectionIds: ["conn-1", "conn-2"],
      },
    );
    expect(
      screen.getByText("Needs reconnect · jo@acme.com"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect Gmail" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage Gmail for this agent" }),
    ).toBeNull();
  });

  const githubAccount = (
    id: string,
    githubOrgAccess?: Record<string, { reason: string }>,
  ): Connection => ({
    ...connectedGmail,
    id,
    provider: "github",
    metadata: githubOrgAccess ? { githubOrgAccess } : null,
  });

  it("an org-access link names the organization and links to its fix steps", () => {
    renderCard(
      "https://app.onecli.sh/w/a/connections/apps/github?org_access=acme",
      {
        connections: [
          githubAccount("conn-gh", { acme: { reason: "approval_required" } }),
        ],
        grantedConnectionIds: ["conn-gh"],
      },
    );
    expect(screen.getByText(/Waiting for admin approval/)).toHaveTextContent(
      "acme · Waiting for admin approval",
    );
    // Not the generic Connected row: no Reconnect / Manage doors.
    expect(
      screen.queryByRole("button", { name: "Reconnect GitHub" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Fix GitHub access for acme" }),
    ).toHaveAttribute(
      "href",
      "/w/ws-1/connections/apps/github?org_access=acme",
    );
  });

  it("an SSO refusal says sign-in, not approval", () => {
    renderCard(
      "https://app.onecli.sh/w/a/connections/apps/github?org_access=acme",
      {
        connections: [
          githubAccount("conn-gh", { acme: { reason: "sso_required" } }),
        ],
      },
    );
    expect(screen.getByText(/SSO sign-in needed/)).toBeInTheDocument();
    expect(screen.queryByText(/approval/)).toBeNull();
  });

  it("finds the refusal on whichever GitHub account recorded it", () => {
    // The org refused the second account; the first is unaffected.
    renderCard(
      "https://app.onecli.sh/w/a/connections/apps/github?org_access=Acme",
      {
        connections: [
          githubAccount("conn-personal"),
          githubAccount("conn-work", { acme: { reason: "approval_required" } }),
        ],
      },
    );
    expect(
      screen.getByRole("link", { name: "Fix GitHub access for acme" }),
    ).toBeInTheDocument();
  });

  it("an org-access card from an older answer reads Connected once the org is cleared", () => {
    // The gateway dropped acme's record (a reconnect, or the refused request
    // went through): the old answer's card must not keep offering Fix Access.
    renderCard(
      "https://app.onecli.sh/w/a/connections/apps/github?org_access=acme",
      {
        connections: [githubAccount("conn-gh")],
        grantedConnectionIds: ["conn-gh"],
      },
    );
    expect(screen.queryByText(/admin approval/)).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Fix GitHub access for acme" }),
    ).toBeNull();
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
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

  it("refreshes the grant views ONLY for a connect this card initiated, and never writes a grant", async () => {
    const { invalidateSpy } = renderCard(GMAIL_CONNECT_URL);

    // A popup someone else opened (same origin) reports a new connection:
    // the card must not react.
    landing({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await act(async () => {});
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Initiated from this card → the same message refreshes the grant views
    // (the API already granted the new account to this agent) and counts.
    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    landing({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(refreshedGrants()),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.counts.all(),
    });
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("refreshes on a reconnect too: no connectionId, the pool still changed", async () => {
    const { invalidateSpy } = renderCard(GMAIL_CONNECT_URL);
    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    landing({ type: "app-connected", provider: "gmail" });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(refreshedGrants()),
    );
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
      screen.queryByText(/Connecting turns the account on for this agent/),
    ).toBeNull();
  });

  it("releases the claim when the popup is blocked: a later landing is not this card's", async () => {
    openSpy.mockReturnValue(null);
    const { invalidateSpy } = renderCard(GMAIL_CONNECT_URL);

    await userEvent.click(
      screen.getByRole("button", { name: "Connect Gmail" }),
    );
    landing({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await act(async () => {});
    expect(invalidateSpy).not.toHaveBeenCalledWith(refreshedGrants());
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
    // The setup page gets this agent, so the connect after it is its own.
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringContaining("source=agent&agent_id=agent-1"),
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

    it("stays an attach row when the account also needs a reconnect: the grant is what this request lacks", () => {
      renderCard(GMAIL_ATTACH_URL, {
        connections: [
          { ...connectedGmail, reauthRequiredAt: "2026-10-01T00:00:00Z" },
        ],
      });
      expect(
        screen.getByRole("button", { name: "Attach Gmail for this agent" }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Needs reconnect/)).toBeNull();
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

    it("stakes the claim for the dialog's connect-new: the landing refreshes the grants", async () => {
      const { invalidateSpy } = renderCard(GMAIL_ATTACH_URL, {
        connections: [connectedGmail],
      });
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

      landing({
        type: "app-connected",
        provider: "gmail",
        connectionId: "conn-9",
      });
      await waitFor(() =>
        expect(invalidateSpy).toHaveBeenCalledWith(refreshedGrants()),
      );
      expect(grants.setConnectionGrant).not.toHaveBeenCalled();
    });
  });

  it("keeps the picker's listener alive after it closes: an in-flight popup still lands", async () => {
    const { invalidateSpy } = renderCard(GMAIL_CONNECT_URL);
    await userEvent.click(
      screen.getByRole("button", { name: "Browse all apps" }),
    );
    // Initiate from the PICKER (its row), then close it without finishing.
    await userEvent.click(screen.getByRole("button", { name: /^Linear/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Connect an app")).toBeNull();

    // The popup lands after the close: the latched (still-mounted) picker
    // must catch it and refresh. The card never claimed linear, so the
    // refresh can only be the picker's.
    landing({
      type: "app-connected",
      provider: "linear",
      connectionId: "conn-7",
    });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(refreshedGrants()),
    );
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
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
