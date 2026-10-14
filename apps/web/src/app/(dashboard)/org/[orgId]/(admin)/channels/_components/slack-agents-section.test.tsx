// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgChannelAgents, OrgChannelsView } from "@/lib/api";

/**
 * The org Channels page's one-click list: shown only once one-click is real,
 * one row per agent grouped by workspace, and a click that opens Slack's
 * consent for exactly that agent. On a socket posture (a self-host with no
 * public URL) the install finishes by pasting tokens on the agent's page, so
 * those rows link there instead of minting blind.
 */

const state = vi.hoisted(() => ({
  view: undefined as unknown,
  agents: undefined as unknown,
  attachPending: false,
}));

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
}));

vi.mock("@/hooks/use-org-channels", () => ({
  useOrgChannels: () => ({
    data: state.view,
    isPending: state.view === undefined,
  }),
  useOrgChannelAgents: () => ({
    data: state.agents,
    isPending: state.agents === undefined,
    isError: false,
  }),
  useAttachAgentFromOrg: () => ({
    mutate: mocks.attach,
    isPending: state.attachPending,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

const { SlackAgentsSection } = await import("./slack-agents-section");

const view = (overrides: Partial<OrgChannelsView> = {}): OrgChannelsView => ({
  integrations: [
    {
      provider: "slack",
      externalId: "T123",
      name: "Acme",
      hasCredentials: true,
      needsCredentials: false,
      credentialsRotatedAt: "2026-08-05T12:00:00Z",
      presenceCount: 1,
    },
  ],
  userLinks: [],
  adapter: { online: true, lastSeenAt: new Date().toISOString() },
  sharedApp: { available: false, canMintAgentApps: false, installation: null },
  ...overrides,
});

const agents: OrgChannelAgents = {
  posture: { transport: "events" },
  workspaces: [
    {
      id: "ws-sales",
      name: "Sales",
      agents: [
        {
          id: "ag-fresh",
          name: "Fresh",
          imageUrl: null,
          state: "none",
          pendingTransport: null,
          slack: null,
        },
        {
          id: "ag-revo",
          name: "Revo",
          imageUrl: null,
          state: "pending",
          pendingTransport: "events",
          slack: null,
        },
      ],
    },
    {
      id: "ws-ops",
      name: "Ops",
      agents: [
        {
          id: "ag-ofer",
          name: "Ofer",
          imageUrl: null,
          state: "active",
          pendingTransport: null,
          slack: { appId: "A0OFER", teamId: "T123", handle: "ofer-bot" },
        },
      ],
    },
    { id: "ws-empty", name: "Empty", agents: [] },
  ],
};

const rowOf = (name: string) => {
  const row = screen.getByText(name).closest("li");
  if (!row) throw new Error(`no row for ${name}`);
  return within(row);
};

beforeEach(() => {
  state.view = view();
  state.agents = agents;
  state.attachPending = false;
  mocks.attach.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SlackAgentsSection", () => {
  it("stays hidden until the Slack credential can actually create apps", () => {
    state.view = view({
      integrations: [
        {
          provider: "slack",
          externalId: "T123",
          name: null,
          hasCredentials: false,
          needsCredentials: true,
          credentialsRotatedAt: null,
          presenceCount: 0,
        },
      ],
    });
    const { container } = render(<SlackAgentsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists agents with one action each, waiting ones first, and a progress count", () => {
    render(<SlackAgentsSection />);

    expect(screen.getByText(/shows up in/)).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 in Slack")).toBeInTheDocument();
    // Each heading says what it is, plainly: "<name> workspace".
    expect(screen.getByText("Sales workspace")).toBeInTheDocument();
    expect(screen.getByText("Ops workspace")).toBeInTheDocument();
    expect(screen.queryByText(/Empty/)).not.toBeInTheDocument();

    // The agent waiting on a click sorts above the one not added yet.
    const names = screen
      .getAllByRole("listitem")
      .map((li) => li.querySelector("p")?.textContent);
    expect(names.slice(0, 2)).toEqual(["Revo", "Fresh"]);

    expect(rowOf("Fresh").getByText("Not in Slack yet.")).toBeInTheDocument();
    expect(
      rowOf("Fresh").getByRole("button", { name: /Add to Slack/ }),
    ).toBeInTheDocument();
    // The stuck state a skipped Allow leaves behind, named and resumable.
    expect(
      rowOf("Revo").getByText(/wait for your Slack admin to approve/),
    ).toBeInTheDocument();
    expect(
      rowOf("Revo").getByRole("button", { name: /Finish in Slack/ }),
    ).toBeInTheDocument();
    expect(
      rowOf("Ofer").getByText(/In Slack\. Message it or mention/),
    ).toBeInTheDocument();
    // The REAL Slack handle, not the OneCLI name.
    expect(rowOf("Ofer").getByText("@ofer-bot")).toBeInTheDocument();
    expect(
      rowOf("Ofer").getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("href", "/w/ws-ops/agents/ag-ofer/channels");
    expect(
      rowOf("Ofer").getByRole("link", { name: /Open in Slack/ }),
    ).toHaveAttribute(
      "href",
      "https://slack.com/app_redirect?app=A0OFER&team=T123",
    );
    // Not live yet: nothing to open.
    expect(
      rowOf("Revo").queryByRole("link", { name: /Open in Slack/ }),
    ).not.toBeInTheDocument();
  });

  it("one click opens a popup synchronously, then points it at THAT agent's Slack consent", async () => {
    const user = userEvent.setup();
    const popup = { location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => popup);
    vi.stubGlobal("open", open);
    mocks.attach.mockImplementation(
      (
        _input: unknown,
        opts: { onSuccess: (r: { installUrl: string }) => void },
      ) => opts.onSuccess({ installUrl: "https://slack.com/oauth/v2/x" }),
    );

    render(<SlackAgentsSection />);
    await user.click(
      rowOf("Revo").getByRole("button", { name: /Finish in Slack/ }),
    );

    // Opened inside the click (before the create resolved), so a popup
    // blocker lets it through.
    expect(open).toHaveBeenCalledTimes(1);
    expect(mocks.attach).toHaveBeenCalledWith(
      { workspaceId: "ws-sales", agentId: "ag-revo" },
      expect.anything(),
    );
    expect(popup.location.href).toBe("https://slack.com/oauth/v2/x");
  });

  it("a blocked popup falls back to a plain link", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    mocks.attach.mockImplementation(
      (
        _input: unknown,
        opts: { onSuccess: (r: { installUrl: string }) => void },
      ) => opts.onSuccess({ installUrl: "https://slack.com/oauth/v2/y" }),
    );

    render(<SlackAgentsSection />);
    await user.click(
      rowOf("Fresh").getByRole("button", { name: /Add to Slack/ }),
    );

    expect(
      rowOf("Fresh").getByRole("link", { name: /blocked the Slack window/ }),
    ).toHaveAttribute("href", "https://slack.com/oauth/v2/y");
  });

  it("on a socket posture, rows link to the agent's page instead of minting blind", () => {
    state.agents = {
      posture: { transport: "socket" },
      workspaces: [
        {
          id: "ws-sales",
          name: "Sales",
          agents: [
            {
              id: "ag-fresh",
              name: "Fresh",
              imageUrl: null,
              state: "none",
              pendingTransport: null,
              slack: null,
            },
            {
              id: "ag-half",
              name: "Half",
              imageUrl: null,
              state: "pending",
              pendingTransport: "socket",
              slack: null,
            },
          ],
        },
      ],
    } satisfies OrgChannelAgents;
    const open = vi.fn();
    vi.stubGlobal("open", open);

    render(<SlackAgentsSection />);

    // No consent click exists: the tokens are pasted on the agent's page.
    expect(
      rowOf("Fresh").getByRole("link", { name: /Set up/ }),
    ).toHaveAttribute("href", "/w/ws-sales/agents/ag-fresh/channels");
    expect(
      rowOf("Half").getByText(/Paste its tokens on its Slack page/),
    ).toBeInTheDocument();
    expect(
      rowOf("Half").getByRole("link", { name: "Finish setup" }),
    ).toHaveAttribute("href", "/w/ws-sales/agents/ag-half/channels");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});
