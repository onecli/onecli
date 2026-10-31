// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { grants } from "@/lib/api";
import type { Connection } from "@/lib/api";
import type { AppPermissionDefinitionSummary } from "@onecli/api/apps/app-permissions/types";
import { queryKeys } from "@/lib/api/keys";
import { ConnectorSuggestions } from "./connect-suggestions";
import { GreetingConnectCard } from "./greeting-connect-card";

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

/** A catalog with a tool list to split on, like every real one. */
const GMAIL_CATALOG: AppPermissionDefinitionSummary = {
  provider: "gmail",
  groups: [
    {
      category: "read",
      tools: [{ id: "read", name: "Read email", description: "" }],
    },
    {
      category: "write",
      tools: [{ id: "send", name: "Send email", description: "" }],
    },
  ],
};

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
    definitions = [] as AppPermissionDefinitionSummary[],
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
  queryClient.setQueryData(
    queryKeys.appPermissionDefinitions.list(),
    definitions,
  );
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

  it("discloses at the point of consent: this agent alone, and what needs approval", () => {
    renderCard(GMAIL_CONNECT_URL, { definitions: [GMAIL_CATALOG] });
    expect(
      screen.getByText(
        "Only this agent gets access. Writes, and reads that could expose secrets, need your approval.",
      ),
    ).toBeInTheDocument();
  });

  it("names only writes for a catalog checked safe for reads", () => {
    renderCard(GMAIL_CONNECT_URL, {
      definitions: [{ ...GMAIL_CATALOG, unlistedReads: "allow" }],
    });
    expect(
      screen.getByText(
        "Only this agent gets access. Writes need your approval.",
      ),
    ).toBeInTheDocument();
  });

  it("never promises approval for an app with no tool list (it gets full access)", () => {
    renderCard(GMAIL_CONNECT_URL);
    expect(
      screen.getByText("Only this agent gets access. It gets full access."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/need your approval/)).toBeNull();
  });

  it("an account the workspace holds but this agent does not reads Attach, never Connected", () => {
    // The reported bug: a new agent with only GitHub on showed "Gmail ·
    // Connected" (with Reconnect + Manage) because another agent's Gmail
    // sat in the workspace. MUTATION-PROOF: decide the row from the
    // workspace pool alone and this reads "Connected" again.
    renderCard(GMAIL_CONNECT_URL, {
      connections: [connectedGmail],
      grantedConnectionIds: ["some-other-connection"],
    });
    expect(
      screen.getByText("Connected, not attached to this agent"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Attach Gmail for this agent" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage Gmail access" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
  });

  it("Attach opens the attach dialog for that app", async () => {
    renderCard(GMAIL_CONNECT_URL, { connections: [connectedGmail] });
    await userEvent.click(
      screen.getByRole("button", { name: "Attach Gmail for this agent" }),
    );
    expect(
      screen.getByRole("heading", { name: "Attach Gmail" }),
    ).toBeInTheDocument();
  });

  it("an account this agent holds reads Connected, names it, and offers Manage only", () => {
    renderCard(GMAIL_CONNECT_URL, {
      connections: [{ ...connectedGmail, label: "jo@acme.com" }],
      grantedConnectionIds: ["conn-1"],
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/jo@acme\.com/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage Gmail access" }),
    ).toBeEnabled();
    // One action per row: a healthy login offers no Reconnect.
    expect(
      screen.queryByRole("button", { name: "Reconnect Gmail" }),
    ).toBeNull();
  });

  it("several held accounts: one Manage that opens the per-account list", async () => {
    renderCard(GMAIL_CONNECT_URL, {
      connections: [connectedGmail, { ...connectedGmail, id: "conn-2" }],
      grantedConnectionIds: ["conn-1", "conn-2"],
    });
    expect(screen.getByText(/2 accounts/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Manage Gmail for this agent" }),
    );
    expect(
      screen.getByRole("heading", { name: "Attach Gmail" }),
    ).toBeInTheDocument();
  });

  it("an org-rule grant counts as this agent's: Connected, not Attach", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.connections.list("workspace"), [
      { ...connectedGmail, scope: "organization" },
    ]);
    queryClient.setQueryData(queryKeys.grants.agent("agent-1"), {
      agentId: "agent-1",
      mode: "grants",
      connections: [],
      secrets: [],
    });
    queryClient.setQueryData(
      [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
      {
        agentId: "agent-1",
        mode: "selective",
        secrets: [],
        connections: [
          {
            id: "conn-1",
            kind: "connection",
            provenance: [
              { kind: "rule", scope: "organization", redacted: true },
            ],
            orgBlocked: false,
          },
        ],
      },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorSuggestions text={GMAIL_CONNECT_URL} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage Gmail access" }),
    ).toBeInTheDocument();
  });

  it("claims nothing about this agent until its grants resolve: no Connected, no door", () => {
    // Grants key deliberately unseeded and fetch hung: the query stays
    // pending. Saying "Connected" OR "not attached" would be a guess, and a
    // Manage opened now would seed a bogus "full access" view.
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
    expect(screen.getByText("Checking access…")).toBeInTheDocument();
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Gmail/ })).toBeNull();
  });

  it("a failed access read says so and offers Try again, never a guess", async () => {
    // Grants fail to load: the row must not fall back to the workspace pool
    // (the original bug) nor strand the user without a next step.
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("boom", { status: 500 })),
    );
    vi.stubGlobal("fetch", fetchMock);
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
      await screen.findByText("Couldn't check access"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connected/)).toBeNull();
    const calls = fetchMock.mock.calls.length;
    await userEvent.click(
      screen.getByRole("button", { name: "Try again for Gmail" }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(calls),
    );
  });

  it("never offers Connect over an unloaded connections list", () => {
    // An unread pool is not an empty one: Connect could duplicate an
    // account this agent already holds.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorSuggestions text={GMAIL_CONNECT_URL} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Checking access…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
  });

  it("an org-shared account needing reconnect points to the org admin, not a dead Reconnect", () => {
    renderCard(GMAIL_CONNECT_URL, {
      connections: [
        {
          ...connectedGmail,
          scope: "organization",
          reauthRequiredAt: "2026-10-01T00:00:00Z",
        },
      ],
      grantedConnectionIds: ["conn-1"],
    });
    expect(screen.getByText(/Needs reconnect/)).toBeInTheDocument();
    expect(
      screen.getByText("Ask an org admin to reconnect"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reconnect Gmail" }),
    ).toBeNull();
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
    expect(screen.getByText(/Needs reconnect/)).toHaveTextContent(
      "Needs reconnect · jo@acme.com",
    );
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

  it("Connect stays the door while the workspace has no account of the app", () => {
    renderCard(GMAIL_CONNECT_URL);
    expect(
      screen.getByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Connected/)).toBeNull();
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

  it("hides the consent line when no suggested app would be a new connect", () => {
    renderCard(GMAIL_CONNECT_URL, { connections: [connectedGmail] });
    expect(screen.queryByText(/Only this agent gets access/)).toBeNull();
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
      // Grants unseeded and fetch hung: the row must not assert either side
      // ("not attached" / "attached") it cannot know yet, and no door shows
      // whose label could still flip.
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
      expect(screen.getByText("Checking access…")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Attach Gmail for this agent" }),
      ).toBeNull();
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

describe("the onboarding Gmail card (bare)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    routeParams = { agentId: "agent-1" };
  });

  /** The greeting card seeded like the attach harness: a workspace Gmail
   * account, with or without this agent holding it. */
  const renderGreeting = (grantedConnectionIds: string[] = []) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.connections.list("workspace"), [
      { ...connectedGmail, label: "jo@acme.com" },
    ]);
    queryClient.setQueryData(queryKeys.grants.agent("agent-1"), {
      agentId: "agent-1",
      mode: "grants",
      connections: grantedConnectionIds.map((connectionId) => ({
        connectionId,
      })),
      secrets: [],
    });
    queryClient.setQueryData(
      [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
      { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
    );
    return render(
      <QueryClientProvider client={queryClient}>
        <GreetingConnectCard variant="greeting" />
      </QueryClientProvider>,
    );
  };

  it("is the agent-aware row alone: Attach for a workspace account it lacks, no consent line, no footer", () => {
    // The onboarding welcome's single Gmail row reads the same per-agent
    // state as every card: a workspace Gmail this agent does not
    // hold is never "Connected" here either.
    renderGreeting();
    expect(
      screen.getByText("Connected, not attached to this agent"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Attach Gmail for this agent" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reconnect Gmail" }),
    ).toBeNull();
    expect(screen.queryByText(/Only this agent gets access/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Browse all apps" }),
    ).toBeNull();
  });

  it("reads Connected with the account and one Manage once this agent holds it", () => {
    renderGreeting(["conn-1"]);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/jo@acme\.com/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage Gmail access" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reconnect Gmail" }),
    ).toBeNull();
  });
});
