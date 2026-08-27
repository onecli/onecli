// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgChannelsView } from "@/lib/api";

/**
 * The shared-app ("Team onboarding") card's laws:
 * - render NOTHING when the deployment neither advertises the shared app nor
 *   holds an install (the default posture everywhere the arm is dark);
 * - an EXISTING install stays visible — with Remove reachable — even while
 *   `available` is false (the rollout posture's UI half: installs made from
 *   Slack's side pre-launch must not become invisible or unremovable);
 * - the advertise state offers Add to Slack.
 */

const state = vi.hoisted(() => ({
  view: undefined as unknown,
}));

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/hooks/use-org-channels", () => ({
  useOrgChannels: () => ({
    data: state.view,
    isPending: state.view === undefined,
  }),
  useStartSharedInstall: () => ({
    mutate: mocks.start,
    isPending: false,
  }),
  useDisconnectSharedInstall: () => ({
    mutate: mocks.disconnect,
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { SlackSharedAppCard } = await import("./slack-shared-app-card");

const view = (
  sharedApp: NonNullable<OrgChannelsView["sharedApp"]>,
): OrgChannelsView => ({
  integrations: [],
  userLinks: [],
  adapter: { online: true, lastSeenAt: new Date().toISOString() },
  sharedApp,
});

const installation = {
  tenant: { externalId: "T123", name: "Acme" },
  botUserId: "UBOT",
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  state.view = undefined;
  mocks.start.mockClear();
  mocks.disconnect.mockReset();
});

describe("SlackSharedAppCard", () => {
  it("renders NOTHING when the shared app is neither advertised nor installed", () => {
    state.view = view({
      available: false,
      canMintAgentApps: false,
      installation: null,
    });
    const { container } = render(<SlackSharedAppCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps an EXISTING install visible and removable even when unavailable", () => {
    // available:false + installation = an install outliving the deployment's
    // shared-app configuration.
    state.view = view({
      available: false,
      canMintAgentApps: false,
      installation,
    });
    render(<SlackSharedAppCard />);

    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    // No advertisement while unavailable.
    expect(
      screen.queryByRole("button", { name: "Add to Slack" }),
    ).not.toBeInTheDocument();
  });

  it("advertises Add to Slack when available and uninstalled", () => {
    state.view = view({
      available: true,
      canMintAgentApps: false,
      installation: null,
    });
    render(<SlackSharedAppCard />);
    expect(
      screen.getByRole("button", { name: "Add to Slack" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    // The choice-state swap exists only when the row provides it.
    expect(
      screen.queryByRole("button", {
        name: /App Configuration token instead/,
      }),
    ).not.toBeInTheDocument();
  });

  it("LEADING the choice: the small token swap under the button, and fires it", async () => {
    const user = userEvent.setup();
    const onSwap = vi.fn();
    state.view = view({
      available: true,
      canMintAgentApps: false,
      installation: null,
    });
    render(<SlackSharedAppCard choice={{ role: "leading", onSwap }} />);

    await user.click(
      screen.getByRole("button", {
        name: /or connect with an App Configuration token instead/,
      }),
    );
    expect(onSwap).toHaveBeenCalledTimes(1);
    // The alternative-role framings stay off the leading face.
    expect(
      screen.queryByText(/Agent apps are still set up with/),
    ).not.toBeInTheDocument();
  });

  it("as the ALTERNATIVE (pre-approval): honest about agent apps, recommended way back fires", async () => {
    const user = userEvent.setup();
    const onSwap = vi.fn();
    state.view = view({
      available: true,
      canMintAgentApps: false,
      installation: null,
    });
    render(<SlackSharedAppCard choice={{ role: "alternative", onSwap }} />);

    expect(
      screen.getByText(/Agent apps are still set up with an App Configuration/),
    ).toBeInTheDocument();
    const back = screen.getByRole("button", {
      name: /Use an App Configuration token instead/,
    });
    expect(back).toHaveTextContent("(recommended)");
    await user.click(back);
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  it("Remove confirms through the dialog and fires the disconnect", async () => {
    const user = userEvent.setup();
    mocks.disconnect.mockImplementation(
      (_provider: string, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    state.view = view({
      available: true,
      canMintAgentApps: false,
      installation,
    });
    render(<SlackSharedAppCard />);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(mocks.disconnect).toHaveBeenCalledWith("slack", expect.anything());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
