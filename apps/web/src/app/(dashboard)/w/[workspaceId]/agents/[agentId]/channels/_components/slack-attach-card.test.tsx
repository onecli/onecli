// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelTransport, CreatePresenceResult } from "@/lib/api";

/**
 * The events-arm popup dance: the install popup must open *synchronously* inside
 * the click — before Slack's `apps.manifest.create` round-trip resolves, so it
 * survives a popup blocker — then be pointed at the URL on success. When the
 * browser blocks it even so, a plain install link takes over (a fresh gesture).
 * The socket arm opens a popup only when it can install by consent (the
 * server also serves webhooks, so it has a public HTTPS origin); without
 * one, its "Create app" opens nothing and the two-token paste stays.
 *
 * The mode picker: shown only when the server offers a real choice
 * (`posture.available` has both) and nothing is pinned by a pending row; its
 * choice rides the attach body — and is NEVER sent to a server that offered
 * no choice (an old server reads no attach body and would silently stamp its
 * own default).
 */

const state = vi.hoisted(() => ({
  attachData: undefined as unknown,
  isPending: false,
}));

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  attachReset: vi.fn(),
  detach: vi.fn(),
  complete: vi.fn(),
  manifestHook: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-channels", () => ({
  useAttachChannel: () => ({
    mutate: mocks.attach,
    reset: mocks.attachReset,
    isPending: state.isPending,
    data: state.attachData,
  }),
  useDetachChannel: () => ({ mutate: mocks.detach, isPending: false }),
  // The floor's hooks — arg-recording so the picker→floor wire is provable.
  useCompleteChannel: () => ({ mutate: mocks.complete, isPending: false }),
  useChannelManifest: (...args: unknown[]) => {
    mocks.manifestHook(...args);
    return { data: undefined, isPending: false };
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocks.toastError },
}));

const { SlackAttachCard } = await import("./slack-attach-card");

const result = (
  overrides: Partial<CreatePresenceResult> = {},
): CreatePresenceResult => ({
  presenceId: "pr1",
  transport: "events",
  installUrl: "https://slack.com/oauth/v2/authorize?client_id=1",
  settingsUrl: "https://api.slack.com/apps/A123",
  ...overrides,
});

const posture = (
  transport: ChannelTransport,
  available?: ChannelTransport[],
) => ({ transport, ...(available && { available }) });

// The mutate mock hands back the `onSuccess` it was called with, so a test can
// drive the create's resolution by hand and prove the popup opened first.
let onSuccess: ((r: CreatePresenceResult) => void) | undefined;

beforeEach(() => {
  state.attachData = undefined;
  state.isPending = false;
  onSuccess = undefined;
  mocks.attach.mockReset();
  mocks.attach.mockImplementation(
    (
      _input: { transport?: ChannelTransport } | undefined,
      opts: { onSuccess: (r: CreatePresenceResult) => void },
    ) => {
      onSuccess = opts.onSuccess;
    },
  );
  mocks.attachReset.mockClear();
  mocks.detach.mockReset();
  mocks.complete.mockClear();
  mocks.manifestHook.mockClear();
  mocks.toastError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the events arm popup", () => {
  it("opens a blank popup synchronously on click — before the create resolves — then points it at the install URL", async () => {
    const popup = { location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => popup as unknown as Window);
    vi.stubGlobal("open", open);

    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("events", ["events"])}
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to Slack" }));

    // Opened blank, inside the gesture, while the create is still in flight —
    // the whole point of the fix. `""` is the placeholder URL.
    expect(open).toHaveBeenCalledWith("", "_blank", expect.any(String));
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(popup.location.href).toBe(""); // not navigated yet

    // The create returns — only now is the popup pointed at Slack.
    onSuccess?.(result({ installUrl: "https://slack.com/install" }));
    expect(popup.location.href).toBe("https://slack.com/install");
  });

  it("falls back to a clickable install link when the popup is blocked", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );

    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("events", ["events"])}
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    // No link yet — it appears only once we know the URL and that open failed.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    act(() => onSuccess?.(result({ installUrl: "https://slack.com/install" })));

    const link = screen.getByRole("link", { name: /Slack install page/i });
    expect(link).toHaveAttribute("href", "https://slack.com/install");
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("opens no popup for the socket 'Create app' arm", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);

    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["socket"])}
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create app" }));
    expect(open).not.toHaveBeenCalled();
    expect(mocks.attach).toHaveBeenCalledOnce();
  });
});

describe("the socket arm's one-click install", () => {
  it("with a public HTTPS origin, socket opens the consent popup like events", async () => {
    const popup = { location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => popup as unknown as Window);
    vi.stubGlobal("open", open);

    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["events", "socket"])}
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming={false}
      />,
    );

    expect(screen.getByText(/paste one token to finish/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    expect(open).toHaveBeenCalledWith("", "_blank", expect.any(String));
    onSuccess?.(
      result({
        transport: "socket",
        installUrl: "https://slack.com/oauth/v2/authorize?client_id=s",
      }),
    );
    expect(popup.location.href).toBe(
      "https://slack.com/oauth/v2/authorize?client_id=s",
    );
  });

  it("after the create: Allow first, then ONE app-token field (no bot-token field)", () => {
    state.attachData = result({
      transport: "socket",
      installUrl: "https://slack.com/oauth/v2/authorize?client_id=s",
    });
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["events", "socket"])}
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming={false}
      />,
    );
    expect(
      screen.getByRole("link", { name: /Allow in Slack/ }),
    ).toHaveAttribute(
      "href",
      "https://slack.com/oauth/v2/authorize?client_id=s",
    );
    expect(screen.getByLabelText("App-level token")).toBeInTheDocument();
    // Where to find it on Slack's page, shown right beside the field.
    expect(
      screen.getByRole("img", { name: /App-Level Tokens section/ }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Bot token")).not.toBeInTheDocument();
    // Not installed yet: finishing is held until the Allow lands.
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeDisabled();
  });

  it("once installed, the paste alone finishes: the request carries NO bot token", async () => {
    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["events", "socket"])}
        pendingTransport="socket"
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming
        resumeAppId="A777"
        awaitingTransportCredential
      />,
    );
    expect(screen.getByText("Installed in Slack")).toBeInTheDocument();
    // The hint names the one step left, not the admin-approval wait.
    expect(
      screen.getByText(/Paste the app-level token below to finish/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Resume setup once they do/)).toBeNull();
    expect(
      screen.getByRole("link", { name: /Open app settings/ }),
    ).toHaveAttribute("href", "https://api.slack.com/apps/A777/general");

    await user.type(screen.getByLabelText("App-level token"), "xapp-1-abc");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(mocks.complete.mock.calls[0]?.[0]).toEqual({
      appToken: "xapp-1-abc",
    });
  });

  it("a DETACHED socket app (not awaiting) gets the full resume, never the one-field paste", () => {
    // The regression this guards: a detach leaves a pending socket row with a
    // bot identity, but its install is revoked. Only the server's flag may
    // put the card in the waiting state.
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["events", "socket"])}
        pendingTransport="socket"
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming
        resumeAppId="A777"
        awaitingTransportCredential={false}
      />,
    );
    expect(screen.queryByText("Installed in Slack")).toBeNull();
    expect(screen.queryByLabelText("App-level token")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Resume setup" }),
    ).toBeInTheDocument();
  });

  it("the waiting install needs no org credential: it wins over the paste floor", () => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["events", "socket"])}
        pendingTransport="socket"
        hasOrgCredentials={false}
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming
        resumeAppId="A777"
        awaitingTransportCredential
      />,
    );
    expect(screen.getByText("Installed in Slack")).toBeInTheDocument();
    expect(screen.queryByLabelText("Bot token")).toBeNull();
    expect(mocks.manifestHook).not.toHaveBeenCalled();
  });

  it("without a public HTTPS origin, socket keeps the two-token paste", () => {
    state.attachData = result({ transport: "socket", installUrl: null });
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["socket"])}
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming={false}
      />,
    );
    expect(screen.getByLabelText("App-level token")).toBeInTheDocument();
    expect(screen.getByLabelText("Bot token")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Allow in Slack/ })).toBeNull();
  });
});

describe("the mode picker", () => {
  it("renders only when the server offers both transports", () => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events", "socket"])}
        hasOrgCredentials
        resuming={false}
      />,
    );
    expect(
      screen.getByRole("radiogroup", { name: "Connection mode" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Webhooks/ })).toBeChecked();
  });

  it.each([
    ["a single available transport", posture("events", ["events"])],
    ["an old server that sends no availability", posture("events")],
  ])("hides the picker for %s", (_name, p) => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={p}
        hasOrgCredentials
        resuming={false}
      />,
    );
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("hides the picker while resuming — the pending row pinned the mode", () => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events", "socket"])}
        pendingTransport="socket"
        hasOrgCredentials
        resuming
      />,
    );
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    // And the arm follows the row's stamp, not the deployment default.
    expect(
      screen.getByRole("button", { name: "Resume setup" }),
    ).toBeInTheDocument();
  });

  it("sends the picked transport on attach — and resets a stale create on flip", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events", "socket"])}
        hasOrgCredentials
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Socket Mode/ }));
    // A create result belongs to the mode it was made for.
    expect(mocks.attachReset).toHaveBeenCalled();

    // This server can also serve webhooks, so it has the public HTTPS origin
    // Slack's redirect needs: Socket Mode installs by consent too.
    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    expect(mocks.attach.mock.calls[0]?.[0]).toEqual({ transport: "socket" });
  });

  it("sends NO transport when the server offered no choice (old-server skew)", async () => {
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.stubGlobal(
      "open",
      vi.fn(() => popup as unknown as Window),
    );
    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events")}
        hasOrgCredentials
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    expect(mocks.attach.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("threads the picked transport into the floor's manifest fetch and complete body", async () => {
    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events", "socket"])}
        hasOrgCredentials={false}
        resuming={false}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Socket Mode/ }));
    // The manifest is refetched for the picked mode — the server bakes the
    // transport into the document, so a stale one is a wrong one.
    expect(mocks.manifestHook).toHaveBeenLastCalledWith(
      "ag-1",
      "slack",
      true,
      "socket",
    );

    await user.type(screen.getByLabelText("Bot token"), "xoxb-bot");
    await user.type(screen.getByLabelText("App-level token"), "xapp-1");
    await user.type(screen.getByLabelText("App ID"), "A999");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    // MUTATION-TESTED wire: drop the floor's transport spread and this fails —
    // the server would stamp the deployment default, not the user's pick.
    expect(mocks.complete.mock.calls[0]?.[0]).toEqual({
      botToken: "xoxb-bot",
      appToken: "xapp-1",
      appId: "A999",
      transport: "socket",
    });
  });

  it("fetches the floor's manifest for the pending row's stamp on resume", () => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events", "socket"])}
        pendingTransport="socket"
        hasOrgCredentials={false}
        resuming
      />,
    );
    // The picker is hidden, but the wire still carries the ROW's transport —
    // otherwise the floor shows the drifted deployment default's manifest
    // beside the stamped mode's paste fields.
    expect(mocks.manifestHook).toHaveBeenLastCalledWith(
      "ag-1",
      "slack",
      true,
      "socket",
    );
  });

  it("events posture with no org credential: an ADMIN gets the org-setup link", () => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events"])}
        hasOrgCredentials={false}
        resuming={false}
      />,
    );
    expect(
      screen.getByText("Connect Slack for your organization first"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Set up Slack for the organization" }),
    ).toHaveAttribute("href", "/org/org-1/channels");
  });

  it("…but a MEMBER gets ask-an-admin copy, never a link that silently bounces", () => {
    // The org Channels page sits behind the admin layout: a member clicking
    // the CTA would be dumped on the workspaces list with no explanation.
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin={false}
        posture={posture("events", ["events"])}
        hasOrgCredentials={false}
        resuming={false}
      />,
    );
    expect(
      screen.getByText("Connect Slack for your organization first"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: "Set up Slack for the organization",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Ask an organization admin to connect Slack/),
    ).toBeInTheDocument();
  });

  it("gates the socket steps on the CREATE's transport, not the picker", () => {
    // A stale events create must not satisfy the socket arm after a flip.
    state.attachData = result({ transport: "events" });
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("socket", ["events", "socket"])}
        hasOrgCredentials
        resuming={false}
      />,
    );
    expect(screen.queryByText(/app-level token/i)).not.toBeInTheDocument();
    // This server also offers webhooks, so the socket arm installs by
    // consent: its start button reads "Add to Slack".
    expect(
      screen.getByRole("button", { name: "Add to Slack" }),
    ).toBeInTheDocument();
  });
});

describe("the resume escape hatch", () => {
  it("offers Start over ONLY while resuming, and detaches WITH the remote app", async () => {
    // Without this button a half-finished setup pins the agent to its stamped
    // transport forever (posture changes and abandoned installs both need a
    // clean restart) — caught live when a socket-pending presence blocked the
    // events-arm re-attach.
    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["socket"])}
        pendingTransport="socket"
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect(mocks.detach).toHaveBeenCalledOnce();
    expect(mocks.detach.mock.calls[0]?.[0]).toEqual({ deleteRemote: true });
  });

  it("clears the stale create result when Start over succeeds", async () => {
    mocks.detach.mockImplementation(
      (_input: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    const user = userEvent.setup();
    render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("socket", ["socket"])}
        pendingTransport="socket"
        hasOrgCredentials
        resuming
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start over" }));
    // The dead app's URLs must not survive into the next attempt.
    expect(mocks.attachReset).toHaveBeenCalled();
  });

  it("clears the blocked-install fallback link when Start over succeeds", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    mocks.detach.mockImplementation(
      (_input: unknown, opts: { onSuccess: () => void }) => opts.onSuccess(),
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events"])}
        hasOrgCredentials
        resuming={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add to Slack" }));
    act(() => onSuccess?.(result({ installUrl: "https://slack.com/install" })));
    expect(
      screen.getByRole("link", { name: /Slack install page/i }),
    ).toBeInTheDocument();

    // The create left a pending row — the section re-renders us as resuming.
    rerender(
      <SlackAttachCard
        agentId="ag-1"
        organizationId="org-1"
        viewerIsOrgAdmin
        posture={posture("events", ["events"])}
        pendingTransport="events"
        hasOrgCredentials
        resuming
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start over" }));
    // The DELETED app's install URL must not survive as a clickable link.
    expect(
      screen.queryByRole("link", { name: /Slack install page/i }),
    ).not.toBeInTheDocument();
  });

  it("shows no Start over on a fresh (non-resuming) card", () => {
    render(
      <SlackAttachCard
        agentId="ag-1"
        posture={posture("socket", ["socket"])}
        hasOrgCredentials
        organizationId="org-1"
        viewerIsOrgAdmin
        resuming={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Start over" }),
    ).not.toBeInTheDocument();
  });
});
