// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgChannelsView } from "@/lib/api";

/**
 * The org Slack integration card's states: paste (never connected), connected
 * (workspace + rotation + presence count + disconnect), and the amber
 * re-paste when rotation lost the credential.
 */

const state = vi.hoisted(() => ({
  view: undefined as unknown,
  disconnectPending: false,
}));

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/hooks/use-org-channels", () => ({
  useOrgChannels: () => ({
    data: state.view,
    isPending: state.view === undefined,
  }),
  useConnectChannelIntegration: () => ({
    mutate: mocks.connect,
    isPending: false,
  }),
  useDisconnectChannelIntegration: () => ({
    mutate: mocks.disconnect,
    isPending: state.disconnectPending,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { SlackIntegrationCard } = await import("./slack-integration-card");

const view = (overrides: Partial<OrgChannelsView> = {}): OrgChannelsView => ({
  integrations: [],
  userLinks: [],
  adapter: { online: true, lastSeenAt: new Date().toISOString() },
  sharedApp: { available: false, canMintAgentApps: false, installation: null },
  ...overrides,
});

const integration = (
  overrides: Partial<OrgChannelsView["integrations"][number]> = {},
): OrgChannelsView["integrations"][number] => ({
  provider: "slack",
  externalId: "T123",
  name: "Acme",
  hasCredentials: true,
  needsCredentials: false,
  credentialsRotatedAt: "2026-08-05T12:00:00Z",
  presenceCount: 3,
  ...overrides,
});

beforeEach(() => {
  state.view = view();
  state.disconnectPending = false;
  mocks.connect.mockClear();
  mocks.disconnect.mockReset();
});

describe("in the choice state", () => {
  it("as the ALTERNATIVE: carries the recommended way back only when the row provides it", async () => {
    const user = userEvent.setup();
    const onSwap = vi.fn();
    render(<SlackIntegrationCard choice={{ role: "alternative", onSwap }} />);

    expect(
      screen.getByText(/For workspaces that can't install the OneCLI app/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: /Use the OneCLI Slack app instead \(recommended\)/,
      }),
    );
    expect(onSwap).toHaveBeenCalledTimes(1);

    cleanup();
    render(<SlackIntegrationCard />);
    expect(
      screen.queryByRole("button", { name: /Use the OneCLI Slack app/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /or add the OneCLI app/ }),
    ).not.toBeInTheDocument();
  });

  it("LEADING (pre-approval): plain description, small onboarding swap under the form", async () => {
    const user = userEvent.setup();
    const onSwap = vi.fn();
    render(<SlackIntegrationCard choice={{ role: "leading", onSwap }} />);

    // The leading face never frames itself as the fallback.
    expect(
      screen.queryByText(/For workspaces that can't install/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Use the OneCLI Slack app/ }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /or add the OneCLI app/ }),
    );
    expect(onSwap).toHaveBeenCalledTimes(1);
  });
});

describe("unconnected", () => {
  it("offers the refresh-token paste with the settings deep link, and submits it", async () => {
    const user = userEvent.setup();
    render(<SlackIntegrationCard />);

    expect(
      screen.getByRole("link", { name: /api\.slack\.com\/apps/ }),
    ).toHaveAttribute("href", "https://api.slack.com/apps");

    const field = screen.getByLabelText("App Configuration refresh token");
    await user.type(field, "xoxe-1-refresh");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(mocks.connect).toHaveBeenCalledWith(
      { provider: "slack", credential: "xoxe-1-refresh" },
      expect.anything(),
    );
  });
});

describe("connected", () => {
  it("shows the workspace, presence count and Disconnect — no paste field", () => {
    state.view = view({ integrations: [integration()] });
    render(<SlackIntegrationCard />);

    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByText(/T123/)).toBeInTheDocument();
    expect(screen.getByText(/3 agent apps/)).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Disconnect" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("App Configuration refresh token"),
    ).not.toBeInTheDocument();
  });
});

describe("the disconnect confirm", () => {
  it("fires the disconnect from the dialog and closes it on success", async () => {
    const user = userEvent.setup();
    mocks.disconnect.mockImplementation(
      (_provider: string, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    state.view = view({ integrations: [integration()] });
    render(<SlackIntegrationCard />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Disconnect" }),
    );

    expect(mocks.disconnect).toHaveBeenCalledWith("slack", expect.anything());
    // The action preventDefaults Radix's own close, so the dialog is gone only
    // because onSuccess closed it — the request-scoped close the fix adds.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("disables the confirm and Cancel and shows progress while in flight", async () => {
    const user = userEvent.setup();
    state.disconnectPending = true;
    state.view = view({ integrations: [integration()] });
    render(<SlackIntegrationCard />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog");

    const confirm = within(dialog).getByRole("button", {
      name: "Disconnecting…",
    });
    expect(confirm).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
  });
});

describe("needs credentials", () => {
  it("says the token died, offers the re-paste — and still offers removal", () => {
    state.view = view({
      integrations: [
        integration({ hasCredentials: false, needsCredentials: true }),
      ],
    });
    render(<SlackIntegrationCard />);

    expect(
      screen.getByText(/expired and could not be refreshed/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("App Configuration refresh token"),
    ).toBeInTheDocument();
    // The dead-token state must not strand the row: Remove clears the expired
    // credential (and deletes the row once nothing references it).
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});

describe("removal in every state", () => {
  it("removes an unreferenced credential-less workspace row from the dialog", async () => {
    const user = userEvent.setup();
    mocks.disconnect.mockImplementation(
      (_provider: string, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    state.view = view({
      integrations: [
        integration({
          hasCredentials: false,
          needsCredentials: false,
          presenceCount: 0,
        }),
      ],
    });
    render(<SlackIntegrationCard />);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/removes the workspace connection/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(mocks.disconnect).toHaveBeenCalledWith("slack", expect.anything());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows an explainer instead of a dead button when removal would change nothing", () => {
    // No credential to clear, no dead-token notice, and the row survives while
    // referenced — a Remove here would be a silent no-op.
    state.view = view({
      integrations: [
        integration({
          hasCredentials: false,
          needsCredentials: false,
          presenceCount: 2,
        }),
      ],
    });
    render(<SlackIntegrationCard />);

    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/stays listed while it's still in use: 2 agent apps/),
    ).toBeInTheDocument();
  });

  it("tells a referenced disconnect what keeps the row listed, member links included", async () => {
    const user = userEvent.setup();
    state.view = view({
      integrations: [integration({ presenceCount: 1 })],
      userLinks: [
        {
          id: "l1",
          externalUserId: "U1",
          linkedVia: "manual",
          createdAt: new Date().toISOString(),
          user: { id: "u1", email: "a@b.c", name: null },
          integration: { provider: "slack" },
        },
      ],
    });
    render(<SlackIntegrationCard />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/1 agent app and 1 member link/),
    ).toBeInTheDocument();
  });
});

describe("minting via the shared app", () => {
  const mintingView = (): OrgChannelsView =>
    view({
      integrations: [
        integration({
          hasCredentials: false,
          needsCredentials: false,
          presenceCount: 0,
        }),
      ],
      sharedApp: {
        available: true,
        canMintAgentApps: true,
        installation: {
          tenant: { externalId: "T123", name: "Acme" },
          botUserId: "UBOT",
          createdAt: new Date().toISOString(),
        },
      },
    });

  it("reads Connected and folds the paste away — the shared install mints, no token needed", () => {
    state.view = mintingView();
    render(<SlackIntegrationCard />);

    expect(
      screen.getByText(/created through the shared OneCLI app/),
    ).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("App Configuration refresh token"),
    ).not.toBeInTheDocument();
  });

  it("the small disclosure unfolds the paste form as the fallback; Cancel folds it back", async () => {
    const user = userEvent.setup();
    state.view = mintingView();
    render(<SlackIntegrationCard />);

    await user.click(
      screen.getByRole("button", {
        name: /paste an App Configuration token/,
      }),
    );
    expect(
      screen.getByLabelText("App Configuration refresh token"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByLabelText("App Configuration refresh token"),
    ).not.toBeInTheDocument();
  });

  it("keeps the adapter-offline notice visible (the old early-return hid it)", () => {
    state.view = {
      ...mintingView(),
      adapter: { online: false, lastSeenAt: null },
    };
    render(<SlackIntegrationCard />);
    expect(screen.getByText(/Channels are offline/)).toBeInTheDocument();
  });
});

describe("deploy skew", () => {
  it("renders (paste form intact) against a server that predates sharedApp", () => {
    // web can deploy ahead of the api-server (the deploy checkboxes): the
    // older view carries NO sharedApp key, and the card must not throw.
    const skewed = view();
    delete (skewed as { sharedApp?: unknown }).sharedApp;
    state.view = skewed;
    render(<SlackIntegrationCard />);
    expect(
      screen.getByLabelText("App Configuration refresh token"),
    ).toBeInTheDocument();
  });
});

describe("the adapter line", () => {
  it("mentions the offline adapter once an integration exists", () => {
    state.view = view({
      integrations: [integration()],
      adapter: { online: false, lastSeenAt: null },
    });
    render(<SlackIntegrationCard />);
    expect(screen.getByText(/Channels are offline/)).toBeInTheDocument();
  });

  it("says nothing about liveness before anything is connected", () => {
    state.view = view({ adapter: { online: false, lastSeenAt: null } });
    render(<SlackIntegrationCard />);
    expect(screen.queryByText(/Channels are offline/)).not.toBeInTheDocument();
  });
});
