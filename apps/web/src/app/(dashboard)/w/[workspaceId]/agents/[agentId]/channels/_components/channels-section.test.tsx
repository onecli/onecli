// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChannelsView, CreatePresenceResult } from "@/lib/api";

/**
 * The Slack card's faces, one per state the view can be in: the two guided
 * arms, the two paste floors, attached, needs-attention, and the adapter
 * banner that only ever speaks about presences that exist.
 */

const state = vi.hoisted(() => ({
  view: undefined as unknown,
  attachData: undefined as unknown,
  manifest: { transport: "events", material: { name: "manifest" } } as unknown,
}));

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  complete: vi.fn(),
  detach: vi.fn(),
}));

vi.mock("@/hooks/use-channels", () => ({
  useAgentChannels: () => ({
    data: state.view,
    isPending: state.view === undefined,
    isError: false,
    refetch: vi.fn(),
  }),
  useAttachChannel: () => ({
    mutate: mocks.attach,
    isPending: false,
    data: state.attachData,
  }),
  useCompleteChannel: () => ({ mutate: mocks.complete, isPending: false }),
  useDetachChannel: () => ({ mutate: mocks.detach, isPending: false }),
  useChannelManifest: () => ({ data: state.manifest, isPending: false }),
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "Support Triage" }),
}));

vi.mock("@/hooks/use-app-connected", () => ({
  useAppMessages: () => {},
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/w/p1/agents/ag-1/channels",
}));

const { ChannelsSection } = await import("./channels-section");

// The section reads `useQueryClient` for the install-return invalidation.
const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChannelsSection />
    </QueryClientProvider>,
  );

const view = (
  overrides: Partial<AgentChannelsView> = {},
): AgentChannelsView => ({
  presences: [],
  posture: { transport: "events", available: ["events"] },
  organizationId: "org-1",
  orgIntegrations: [
    { provider: "slack", connected: true, hasCredentials: true },
  ],
  adapter: { online: true, lastSeenAt: new Date().toISOString() },
  ...overrides,
});

const activePresence = (
  overrides: Partial<AgentChannelsView["presences"][number]> = {},
): AgentChannelsView["presences"][number] => ({
  provider: "slack",
  status: "active",
  transport: "events",
  externalId: "A123",
  identityRef: "U777",
  identityName: "donna",
  tenant: { externalId: "T1", name: "Acme" },
  managedBy: { name: "Jonathan", email: "jonathan@onecli.sh" },
  groupThreads: [],
  ...overrides,
});

beforeEach(() => {
  state.view = view();
  state.attachData = undefined;
  mocks.attach.mockClear();
  mocks.complete.mockClear();
  // The events arm opens its install popup synchronously in the click; jsdom
  // leaves `window.open` unimplemented, so stub it (the popup dance itself is
  // covered in slack-attach-card.test.tsx).
  vi.stubGlobal(
    "open",
    vi.fn(() => null),
  );
});

describe("the guided events arm", () => {
  it("offers one-click Add to Slack and fires the create", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    expect(mocks.attach).toHaveBeenCalledOnce();
  });
});

describe("the mode picker", () => {
  it("appears when the deployment offers both transports", () => {
    state.view = view({
      posture: { transport: "events", available: ["events", "socket"] },
    });
    renderSection();

    expect(
      screen.getByRole("radiogroup", { name: "Connection mode" }),
    ).toBeInTheDocument();
  });

  it("stays hidden when only one transport is available", () => {
    renderSection();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});

describe("the guided socket arm", () => {
  it("walks the two-step token list once the app exists, and completes with both tokens", async () => {
    const user = userEvent.setup();
    state.view = view({
      posture: { transport: "socket", available: ["socket"] },
    });
    state.attachData = {
      presenceId: "pr1",
      transport: "socket",
      installUrl: null,
      settingsUrl: "https://api.slack.com/apps/A123",
    } satisfies CreatePresenceResult;
    renderSection();

    expect(screen.getByText("Generate an app-level token")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open app settings/ }),
    ).toHaveAttribute("href", "https://api.slack.com/apps/A123");

    const finish = screen.getByRole("button", { name: "Finish setup" });
    expect(finish).toBeDisabled();

    await user.type(screen.getByLabelText("App-level token"), "xapp-1-secret");
    await user.type(screen.getByLabelText("Bot token"), "xoxb-bot");
    await user.click(finish);

    expect(mocks.complete).toHaveBeenCalledWith(
      { botToken: "xoxb-bot", appToken: "xapp-1-secret" },
      expect.anything(),
    );
  });
});

describe("no org credential", () => {
  it("EVENTS posture points at the ORG setup instead of the manual floor", () => {
    state.view = view({ orgIntegrations: [] });
    renderSection();

    expect(
      screen.getByRole("link", { name: "Set up Slack for the organization" }),
    ).toHaveAttribute("href", "/org/org-1/channels");
    // The scary manual arm is gone from the events posture entirely.
    expect(
      screen.queryByText("Create a Slack app from this manifest"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Bot token")).not.toBeInTheDocument();
  });

  it("the SOCKET floor keeps the manual fields (Slack has no API for its tokens)", () => {
    state.view = view({
      orgIntegrations: [],
      posture: { transport: "socket", available: ["socket"] },
    });
    renderSection();

    expect(screen.getByLabelText("Bot token")).toBeInTheDocument();
    expect(screen.getByLabelText("App-level token")).toBeInTheDocument();
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();
    expect(screen.queryByLabelText("Signing secret")).not.toBeInTheDocument();
  });

  it("submits the pasted SOCKET floor credentials", async () => {
    const user = userEvent.setup();
    state.view = view({
      orgIntegrations: [],
      posture: { transport: "socket" },
    });
    renderSection();

    await user.type(screen.getByLabelText("Bot token"), "xoxb-bot");
    await user.type(screen.getByLabelText("App-level token"), "xapp-1");
    await user.type(screen.getByLabelText("App ID"), "A999");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(mocks.complete).toHaveBeenCalledWith(
      { botToken: "xoxb-bot", appId: "A999", appToken: "xapp-1" },
      expect.anything(),
    );
  });
});

describe("the attached card", () => {
  it("shows the bot identity, transport, deep link and Detach", () => {
    state.view = view({ presences: [activePresence()] });
    renderSection();

    expect(screen.getByText("@donna")).toBeInTheDocument();
    expect(screen.getByText("Managed by Jonathan")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in Slack/ })).toHaveAttribute(
      "href",
      "https://slack.com/app_redirect?app=A123&team=T1",
    );
    expect(screen.getByRole("button", { name: "Detach" })).toBeInTheDocument();
  });

  it("names the app in the detach dialog's delete opt-in", async () => {
    state.view = view({ presences: [activePresence()] });
    renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Detach" }));

    // "the Slack app" is abstract; the handle is what a human recognizes in
    // their workspace, and the same thing the agent-delete confirm names.
    expect(
      screen.getByLabelText("Also delete the Slack app (@donna)"),
    ).toBeInTheDocument();
  });

  it("falls back to the bare label when the handle is unknown", async () => {
    // The OAuth arm and presences that predate the column have no handle.
    state.view = view({ presences: [activePresence({ identityName: null })] });
    renderSection();

    await userEvent.click(screen.getByRole("button", { name: "Detach" }));

    expect(
      screen.getByLabelText("Also delete the Slack app"),
    ).toBeInTheDocument();
  });

  it("names the fix in amber when the presence needs attention", () => {
    state.view = view({
      presences: [activePresence({ status: "needs_attention" })],
    });
    renderSection();

    expect(screen.getByText(/its service key was refused/)).toBeInTheDocument();
    expect(screen.getByText("Everything else keeps working.")).toBeVisible();
    // The rest of the card stays — messaging still works.
    expect(
      screen.getByRole("link", { name: /Open in Slack/ }),
    ).toBeInTheDocument();
  });
});

describe("the adapter banner", () => {
  it("appears only when a presence exists AND the adapter is offline", () => {
    state.view = view({
      presences: [activePresence()],
      adapter: { online: false, lastSeenAt: null },
    });
    renderSection();
    expect(screen.getByText(/Channels are offline/)).toBeInTheDocument();
  });

  it("stays silent for an unattached agent even when the adapter is down", () => {
    state.view = view({ adapter: { online: false, lastSeenAt: null } });
    renderSection();
    expect(screen.queryByText(/Channels are offline/)).not.toBeInTheDocument();
  });
});
