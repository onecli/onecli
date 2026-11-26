// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelUserLink, OrgChannelsView } from "@/lib/api";

/**
 * People matching is automatic (verified Slack email), so the card is a
 * folded escape hatch: hidden until Slack is connected, collapsed by
 * default, and never presenting manual linking as a setup step (an open
 * table read like a required step, so people linked themselves by hand).
 */

const state = vi.hoisted(() => ({ view: undefined as unknown }));

vi.mock("@/hooks/use-org-channels", () => ({
  useOrgChannels: () => ({
    data: state.view,
    isPending: state.view === undefined,
  }),
  useAddChannelUserLink: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveChannelUserLink: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-org-members", () => ({
  useOrgMembersList: () => ({ data: [], isError: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { ChannelUserLinksCard } = await import("./channel-user-links-card");

const link: ChannelUserLink = {
  id: "l-1",
  externalUserId: "U012ABCDEF",
  linkedVia: "email",
  createdAt: "2026-10-08T00:00:00Z",
  user: { id: "u-1", email: "dana@example.com", name: "Dana" },
  integration: { provider: "slack" },
};

const view = (overrides: Partial<OrgChannelsView> = {}): OrgChannelsView => ({
  integrations: [
    {
      provider: "slack",
      externalId: "T123",
      name: "Acme",
      hasCredentials: true,
      needsCredentials: false,
      credentialsRotatedAt: null,
      presenceCount: 0,
    },
  ],
  userLinks: [],
  adapter: { online: true, lastSeenAt: null },
  ...overrides,
});

beforeEach(() => {
  state.view = view();
});
afterEach(cleanup);

describe("ChannelUserLinksCard", () => {
  it("renders nothing before Slack is connected", () => {
    state.view = view({ integrations: [] });
    const { container } = render(<ChannelUserLinksCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says matching is automatic and keeps the manual form folded away", async () => {
    const user = userEvent.setup();
    state.view = view({ userLinks: [link] });
    render(<ChannelUserLinksCard />);

    expect(
      screen.getByText(/matched to their OneCLI account automatically/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 person matched so far/)).toBeInTheDocument();
    // Collapsed: no table, no manual-link button up front.
    expect(screen.queryByText("dana@example.com")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Link manually/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /different email in Slack/ }),
    ).toBeInTheDocument();
  });
});
