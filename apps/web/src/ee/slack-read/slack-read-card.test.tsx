// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MyConversation, ReadGrant, SlackReadConnection } from "./api";

const state = vi.hoisted(() => ({
  connection: undefined as SlackReadConnection | undefined,
  grants: [] as ReadGrant[],
  mine: [] as MyConversation[],
}));

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  disconnect: vi.fn(),
  setGrant: vi.fn(),
  share: vi.fn(),
  deleteGrant: vi.fn(),
}));

vi.mock("./hooks", () => ({
  useSlackReadConnection: () => ({
    data: state.connection,
    isPending: state.connection === undefined,
  }),
  useSlackReadGrants: () => ({
    data: { grants: state.grants },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useMyConversations: () => ({
    data: { conversations: state.mine },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useStartSlackConnect: () => ({ mutate: mocks.start, isPending: false }),
  useDisconnectSlack: () => ({ mutate: mocks.disconnect, isPending: false }),
  useSetReadGrant: () => ({ mutate: mocks.setGrant, isPending: false }),
  useShareConversations: () => ({ mutate: mocks.share, isPending: false }),
  useDeleteReadGrant: () => ({ mutate: mocks.deleteGrant, isPending: false }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SlackReadCard } = await import("./slack-read-card");

const grant = (over: Partial<ReadGrant> = {}): ReadGrant => ({
  id: "g-1",
  subjectKind: "dm",
  externalRef: "D0SAM",
  subjectLabel: "@Sam",
  audience: "granter_only",
  grantedBy: { id: "u-a", name: "Alex", email: "alex@example.com" },
  mine: true,
  ...over,
});

const renderCard = () =>
  render(<SlackReadCard agentId="ag-1" agentName="Deploy Agent" />);

describe("SlackReadCard", () => {
  beforeEach(() => {
    state.connection = {
      connected: false,
      available: true,
      profile: null,
    };
    state.grants = [];
    state.mine = [];
    for (const m of Object.values(mocks)) m.mockReset();
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  it("not connected: explains the default and offers Connect your Slack", async () => {
    renderCard();
    expect(screen.getByText("What Deploy Agent can read")).toBeTruthy();
    expect(screen.getByText(/only sees messages sent to it/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Add conversation/ }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Connect your Slack" }),
    );
    expect(mocks.start).toHaveBeenCalled();
  });

  it("an app that can't run the consent flow says so and disables the button", () => {
    state.connection = {
      connected: false,
      available: false,
      profile: null,
    };
    renderCard();
    expect(screen.getByText(/can't connect personal accounts/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Connect your Slack" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("connected: shows name, @handle, email and avatar fallback, plus add and disconnect", async () => {
    state.connection = {
      connected: true,
      available: true,
      profile: {
        handle: "alex",
        realName: "Alex Kim",
        email: "alex@example.com",
        avatarUrl: null,
      },
    };
    renderCard();
    expect(screen.getByText("Your Slack")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Alex Kim")).toBeTruthy();
    expect(screen.getByText("@alex · alex@example.com")).toBeTruthy();
    // No avatar URL: initials stand in.
    expect(screen.getByText("AK")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Add conversation/ }),
    ).toBeTruthy();
    // Disconnect is tucked in the `…`, with what it also does.
    await userEvent.click(
      screen.getByRole("button", { name: "More for your Slack" }),
    );
    expect(
      await screen.findByText("Also stops sharing everything you shared."),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Disconnect my Slack/ }),
    );
    expect(mocks.disconnect).toHaveBeenCalled();
  });

  it("lists grants with who shared them; only your own can change audience, any can be removed", () => {
    state.connection = {
      connected: true,
      available: true,
      profile: null,
    };
    state.grants = [
      grant(),
      grant({
        id: "g-2",
        subjectKind: "channel",
        externalRef: "C0REPORTS",
        subjectLabel: "#weekly-reports",
        audience: "anyone",
        grantedBy: { id: "u-j", name: "Jordan", email: "jordan@example.com" },
        mine: false,
      }),
    ];
    renderCard();
    expect(screen.getByText("Shared by you")).toBeTruthy();
    expect(screen.getByText("Shared by Jordan")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Who can ask about @Sam: Only me. Change",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /Who can ask about #weekly-reports/,
      }),
    ).toBeNull();
    // Grouped like Contacts: channels apart from direct messages.
    expect(screen.getByRole("heading", { name: "Channels" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Direct messages" }),
    ).toBeTruthy();
    // Every row (yours or not) can be removed, from its `…`.
    expect(screen.getByRole("button", { name: "More for @Sam" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "More for #weekly-reports" }),
    ).toBeTruthy();
  });

  it("the picker lists only unshared conversations and shares the chosen one, Only me by default", async () => {
    state.connection = {
      connected: true,
      available: true,
      profile: null,
    };
    state.grants = [grant()];
    state.mine = [
      { ref: "D0SAM", kind: "dm", name: "@Sam" },
      { ref: "C0REPORTS", kind: "channel", name: "#weekly-reports" },
    ];
    renderCard();
    await userEvent.click(
      screen.getByRole("button", { name: /Add conversation/ }),
    );
    const dialog = await screen.findByRole("dialog");
    const list = within(dialog).getByRole("listbox");
    expect(within(list).queryByText("@Sam")).toBeNull();
    await userEvent.click(
      within(list).getByRole("option", { name: /#weekly-reports/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Share" }),
    );
    expect(mocks.share).toHaveBeenCalledWith(
      { externalRefs: ["C0REPORTS"], audience: "granter_only" },
      expect.anything(),
    );
  });

  it("bulk: filter + select all shown; DMs with Anyone need an explicit acknowledgement", async () => {
    state.connection = { connected: true, available: true, profile: null };
    state.mine = [
      { ref: "C0REPORTS", kind: "channel", name: "#weekly-reports" },
      { ref: "C0GENERAL", kind: "channel", name: "#general" },
      { ref: "G0SECRET", kind: "private_channel", name: "#secret" },
      { ref: "D0SAM", kind: "dm", name: "@Sam" },
    ];
    renderCard();
    await userEvent.click(
      screen.getByRole("button", { name: /Add conversation/ }),
    );
    const dialog = await screen.findByRole("dialog");
    // Public filter, then select all shown: only the two public channels.
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Public/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Select all 2 shown" }),
    );
    // Back to All, add the DM too.
    await userEvent.click(within(dialog).getByRole("button", { name: /^All/ }));
    await userEvent.click(within(dialog).getByRole("option", { name: /@Sam/ }));
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Anyone/ }),
    );
    const share = within(dialog).getByRole("button", { name: "Share 3" });
    expect(share).toHaveProperty("disabled", true);
    await userEvent.click(
      within(dialog).getByText(/1 private message is selected/),
    );
    expect(share).toHaveProperty("disabled", false);
    await userEvent.click(share);
    expect(mocks.share).toHaveBeenCalledWith(
      {
        externalRefs: ["C0REPORTS", "C0GENERAL", "D0SAM"],
        audience: "anyone",
      },
      expect.anything(),
    );
  });
});
