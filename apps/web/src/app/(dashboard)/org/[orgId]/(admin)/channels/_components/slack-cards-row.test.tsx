// @vitest-environment jsdom
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgChannelsView } from "@/lib/api";

/**
 * The Slack setup surface's ROUTING LAW: one guided path, never two rival
 * cards.
 * - Choice state (shared offered, nothing connected): ONE card at a time.
 *   Which face leads follows `installMintsAgentApps`: pre-approval the token
 *   paste leads (the OneCLI app is onboarding-only), post-approval the
 *   OneCLI app leads. Each face carries the way to the other.
 * - Connected states show status first and stack the other surface, with NO
 *   swap links (the choice moment is over).
 * - Dark posture / older servers: the token card alone.
 */

const state = vi.hoisted(() => ({
  view: undefined as unknown,
  search: "",
  replaced: [] as string[],
}));

vi.mock("@/hooks/use-org-channels", () => ({
  useOrgChannels: () => ({
    data: state.view,
    isPending: state.view === undefined,
  }),
  useStartSharedInstall: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectSharedInstall: () => ({ mutate: vi.fn(), isPending: false }),
  useConnectChannelIntegration: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectChannelIntegration: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (u: string) => state.replaced.push(u) }),
  usePathname: () => "/org/org-1/channels",
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "@/lib/api";

const { SlackCardsRow } = await import("./slack-cards-row");

/** The row reads the query client for the ?connected consumer. */
const renderRow = (client: QueryClient = new QueryClient()) =>
  render(
    <QueryClientProvider client={client}>
      <SlackCardsRow />
    </QueryClientProvider>,
  );

const view = (overrides: Partial<OrgChannelsView> = {}): OrgChannelsView => ({
  integrations: [],
  userLinks: [],
  adapter: { online: true, lastSeenAt: new Date().toISOString() },
  // Pre-approval posture (the realistic default until Slack enrolls the
  // deployment's app as a manager app): an install is onboarding-only.
  sharedApp: {
    available: true,
    canMintAgentApps: false,
    installMintsAgentApps: false,
    installation: null,
  },
  ...overrides,
});

const approvedView = (): OrgChannelsView =>
  view({
    sharedApp: {
      available: true,
      canMintAgentApps: false,
      installMintsAgentApps: true,
      installation: null,
    },
  });

const installation = {
  tenant: { externalId: "T123", name: "Acme" },
  botUserId: "UBOT",
  createdAt: new Date().toISOString(),
};

const tokenIntegration = {
  provider: "slack" as const,
  externalId: "T123",
  name: "Acme",
  hasCredentials: true,
  needsCredentials: false,
  credentialsRotatedAt: null,
  presenceCount: 2,
};

// The four swap affordances: each face's small "or …" when it LEADS, and
// its recommended way back when it's the ALTERNATIVE.
const SWAP_TO_TOKEN = /or connect with an App Configuration token instead/;
const SWAP_TO_SHARED = /Use the OneCLI Slack app instead/;
const SWAP_TO_SHARED_LEADING_TOKEN = /or add the OneCLI app/;
const SWAP_TO_TOKEN_WAY_BACK = /Use an App Configuration token instead/;

beforeEach(() => {
  state.view = view();
  state.search = "";
  state.replaced = [];
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("the setup CHOICE, PRE-approval (an install can't mint agent apps)", () => {
  it("leads with the token paste and offers the OneCLI app as a small swap", () => {
    renderRow();

    // One card, the default one — never both. Pre-approval the OneCLI app
    // is onboarding-only, so the token paste (the thing that actually
    // enables agent apps) leads.
    expect(screen.getByText("Agent apps")).toBeInTheDocument();
    expect(
      screen.getByLabelText("App Configuration refresh token"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Team onboarding")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SWAP_TO_SHARED_LEADING_TOKEN }),
    ).toBeInTheDocument();
    // The post-approval framings must NOT leak into the leading face.
    expect(screen.queryByText(/For workspaces that can't install/)).toBeNull();
    expect(screen.queryByRole("button", { name: SWAP_TO_SHARED })).toBeNull();
  });

  it("swaps to the OneCLI app card, which is honest about agent apps and carries the recommended way back", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(
      screen.getByRole("button", { name: SWAP_TO_SHARED_LEADING_TOKEN }),
    );

    // Swapped, not stacked — and the alternative face says installing it
    // does NOT set up agent apps yet.
    expect(screen.getByText("Team onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Agent apps")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Agent apps are still set up with an App Configuration/),
    ).toBeInTheDocument();
    const back = screen.getByRole("button", { name: SWAP_TO_TOKEN_WAY_BACK });
    expect(back).toHaveTextContent("(recommended)");

    await user.click(back);
    expect(screen.getByText("Agent apps")).toBeInTheDocument();
    expect(screen.queryByText("Team onboarding")).not.toBeInTheDocument();
  });

  it("a server that predates the field leads with the token paste too", () => {
    const skewed = view();
    delete (skewed.sharedApp as { installMintsAgentApps?: boolean })
      .installMintsAgentApps;
    state.view = skewed;
    renderRow();
    expect(screen.getByText("Agent apps")).toBeInTheDocument();
    expect(screen.queryByText("Team onboarding")).not.toBeInTheDocument();
  });
});

describe("the setup CHOICE, POST-approval (an install mints agent apps)", () => {
  beforeEach(() => {
    state.view = approvedView();
  });

  it("leads with the OneCLI app and offers the token path as a small swap", () => {
    renderRow();

    // One card, the default one — never both.
    expect(screen.getByText("Team onboarding")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add to Slack" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Agent apps")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SWAP_TO_TOKEN }),
    ).toBeInTheDocument();
    // The pre-approval honesty line has no business on an approved app.
    expect(screen.queryByText(/Agent apps are still set up with/)).toBeNull();
  });

  it("swaps in place to the token card, which carries the recommended way back", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole("button", { name: SWAP_TO_TOKEN }));

    // Swapped, not stacked.
    expect(screen.getByText("Agent apps")).toBeInTheDocument();
    expect(screen.queryByText("Team onboarding")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("App Configuration refresh token"),
    ).toBeInTheDocument();
    // The alternative names when you'd pick it, and the default is
    // recommended on the way back.
    expect(
      screen.getByText(/For workspaces that can't install the OneCLI app/),
    ).toBeInTheDocument();
    const back = screen.getByRole("button", { name: SWAP_TO_SHARED });
    expect(back).toHaveTextContent("(recommended)");

    await user.click(back);
    expect(screen.getByText("Team onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Agent apps")).not.toBeInTheDocument();
  });
});

describe("connected states (the choice moment is over — no swap links)", () => {
  it("INSTALLED stacks the shared status first, the token card's truths under it", () => {
    state.view = view({
      sharedApp: { available: true, canMintAgentApps: false, installation },
      integrations: [{ ...tokenIntegration, hasCredentials: false }],
    });
    renderRow();

    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Agent apps")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SWAP_TO_TOKEN })).toBeNull();
    expect(screen.queryByRole("button", { name: SWAP_TO_SHARED })).toBeNull();
    expect(
      screen.queryByRole("button", { name: SWAP_TO_SHARED_LEADING_TOKEN }),
    ).toBeNull();
    // Shared status leads the stack.
    const headings = screen
      .getAllByText(/Team onboarding|Agent apps/)
      .map((n) => n.textContent);
    expect(headings[0]).toBe("Team onboarding");
  });

  it("TOKEN-ONLY leads with the connected token card, the install offer under it", () => {
    state.view = view({ integrations: [tokenIntegration] });
    renderRow();

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add to Slack" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SWAP_TO_TOKEN })).toBeNull();
    expect(
      screen.queryByRole("button", { name: SWAP_TO_SHARED_LEADING_TOKEN }),
    ).toBeNull();
    const headings = screen
      .getAllByText(/Team onboarding|Agent apps/)
      .map((n) => n.textContent);
    expect(headings[0]).toBe("Agent apps");
  });
});

describe("the ?connected=slack landing (the OAuth redirect's one shot)", () => {
  it("same-tab: invalidates the channels cache, toasts once, strips the param", async () => {
    state.search = "connected=slack";
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderRow(client);

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.channels.all(),
    });
    // The param is stripped so a refresh doesn't re-toast.
    expect(state.replaced).toEqual(["/org/org-1/channels"]);
  });

  it("popup: posts app-connected to the opener and closes — the opener's own listener does the rest", async () => {
    state.search = "connected=slack";
    const postMessage = vi.fn();
    // jsdom's window.opener is writable.
    (window as { opener: unknown }).opener = { postMessage };
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      renderRow();
      await waitFor(() => expect(close).toHaveBeenCalled());
      // The handshake is the ONLY thing that updates the opener: closing a
      // popup changes neither the opener's visibility nor focus, so no
      // refetch would ever fire without it.
      expect(postMessage).toHaveBeenCalledWith(
        { type: "app-connected", provider: "slack" },
        window.location.origin,
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(state.replaced).toEqual([]);
    } finally {
      (window as { opener: unknown }).opener = null;
      close.mockRestore();
    }
  });

  it("as the OPENER: an app-connected message invalidates and toasts", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderRow(client);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "app-connected", provider: "slack" },
        origin: window.location.origin,
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.channels.all(),
    });

    // A different provider's popup is not our news.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "app-connected", provider: "github" },
        origin: window.location.origin,
      }),
    );
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

describe("dark posture and older servers", () => {
  it("shared arm dark: the token card alone, no onboarding card", () => {
    state.view = view({
      sharedApp: {
        available: false,
        canMintAgentApps: false,
        installation: null,
      },
    });
    renderRow();
    expect(screen.getByText("Agent apps")).toBeInTheDocument();
    expect(screen.queryByText("Team onboarding")).not.toBeInTheDocument();
  });

  it("a server that predates sharedApp: the token card alone, no crash", () => {
    const skewed = view();
    delete (skewed as { sharedApp?: unknown }).sharedApp;
    state.view = skewed;
    renderRow();
    expect(screen.getByText("Agent apps")).toBeInTheDocument();
    expect(screen.queryByText("Team onboarding")).not.toBeInTheDocument();
  });
});
