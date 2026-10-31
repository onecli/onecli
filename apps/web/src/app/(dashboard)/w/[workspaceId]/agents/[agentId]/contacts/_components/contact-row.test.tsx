// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPersonReach, ChannelSpaceReach } from "@/lib/api";
import type { MergedEntry } from "./merge-contacts";

/**
 * The row: ONE person or channel and its one setting. The acceptance
 * behaviors: the control says what it is about (by its accessible
 * question, not a bare badge word), it drives its mutation with this row's
 * id, pending points at the bell, a workspace owner is locked, and Remove
 * is confirm-gated and clears the setting.
 */

const mocks = vi.hoisted(() => ({
  setPerson: vi.fn(),
  setSpace: vi.fn(),
  setListen: vi.fn(),
  dismissPerson: vi.fn(),
  dismissSpace: vi.fn(),
  toastSuccess: vi.fn(),
  forgetSendAs: vi.fn(),
  sendAsPrefs: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

vi.mock("@/hooks/use-channels", () => ({
  useSetPersonReachState: () => ({ mutate: mocks.setPerson, isPending: false }),
  useSetReachState: () => ({ mutate: mocks.setSpace, isPending: false }),
  useSetSpaceListen: () => ({ mutate: mocks.setListen, isPending: false }),
  useDismissPersonReach: () => ({ mutateAsync: mocks.dismissPerson }),
  useDismissReachRow: () => ({ mutateAsync: mocks.dismissSpace }),
  useSendAsPreferences: () => ({ data: mocks.sendAsPrefs() }),
  useForgetSendAsPreference: () => ({
    mutate: mocks.forgetSendAs,
    isPending: false,
  }),
}));

import { ContactRow } from "./contact-row";

const person = (
  state: ChannelPersonReach["state"],
  overrides: Partial<ChannelPersonReach> = {},
): MergedEntry<ChannelPersonReach> => ({
  key: "U1",
  reach: {
    provider: "slack",
    value: {
      externalRef: "U1",
      label: "Alex Kim",
      state,
      decidedAt: null,
      avatarUrl: null,
      isOwner: false,
      ...overrides,
    },
  },
});

const renderPerson = (entry: MergedEntry<ChannelPersonReach>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContactRow
        kind="person"
        agentId="ag-1"
        agentName="Donna"
        entry={entry}
      />
    </QueryClientProvider>,
  );

const openRemove = async (rowName: string) => {
  await userEvent.click(
    screen.getByRole("button", { name: `More for ${rowName}` }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe("ContactRow: the remembered sender", () => {
  it("no choice: no label, no Forget item", async () => {
    renderPerson(person("approved"));
    expect(screen.queryByText(/sends as/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Alex Kim" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: /Forget send-as choice/ }),
    ).toBeNull();
  });

  it("a remembered sender shows as a label; Forget clears it", async () => {
    mocks.sendAsPrefs.mockReturnValue(new Map([["U1", "agent"]]));
    renderPerson(person("approved"));
    expect(screen.getByText("sends as Donna")).toBeDefined();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Alex Kim" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Forget send-as choice/ }),
    );
    expect(mocks.forgetSendAs).toHaveBeenCalledWith("U1", expect.anything());
  });

  it("as you reads sends as you", () => {
    mocks.sendAsPrefs.mockReturnValue(new Map([["U1", "you"]]));
    renderPerson(person("approved"));
    expect(screen.getByText("sends as you")).toBeDefined();
  });
});

describe("ContactRow (person)", () => {
  const group = () =>
    screen.getByRole("group", {
      name: "Can Alex Kim and Donna message each other",
    });
  /** The pressed icon of the person's one control. */
  const pressed = () =>
    within(group())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("aria-label"));
  const click = (name: string) =>
    userEvent.click(within(group()).getByRole("button", { name }));

  it("a workspace owner is a locked Always allow: Never disabled, no menu", async () => {
    renderPerson(person("approved", { isOwner: true }));
    expect(pressed()).toEqual(["Always allow"]);
    expect(screen.getByText("Workspace owner")).toBeDefined();
    const never = within(group()).getByRole("button", { name: "Never" });
    expect((never as HTMLButtonElement).disabled).toBe(true);
    await click("Always allow");
    expect(mocks.setPerson).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /^More for Alex Kim/ }),
    ).toBeNull();
  });

  it("ONE control per person, two app-permission icons: Always allow, Never", () => {
    renderPerson(person("approved"));
    expect(screen.getByText("Alex Kim")).toBeDefined();
    expect(screen.queryByText("Workspace owner")).toBeNull();
    expect(
      within(group())
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Always allow", "Never"]);
  });

  it.each([
    ["approved", "Always allow"],
    ["blocked", "Never"],
  ] as const)("a stored %s presses %s", (state, label) => {
    renderPerson(person(state));
    expect(pressed()).toEqual([label]);
  });

  it("each choice drives the person mutation with THIS row's ref, silently", async () => {
    renderPerson(person("approved"));
    await click("Never");
    expect(mocks.setPerson).toHaveBeenCalledWith({
      externalRef: "U1",
      state: "blocked",
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("re-picking the current setting is a no-op", async () => {
    renderPerson(person("blocked"));
    await click("Never");
    expect(mocks.setPerson).not.toHaveBeenCalled();
  });

  it("a person with no name is labelled by their id", () => {
    renderPerson(person("approved", { label: null }));
    expect(
      screen.getByRole("group", {
        name: "Can U1 and Donna message each other",
      }),
    ).toBeDefined();
  });

  it("a pending person opens the bell, with no control and nothing to remove", async () => {
    const opened = vi.fn();
    window.addEventListener("onecli:open-approvals-bell", opened);
    renderPerson(person("pending"));
    expect(screen.getByText("Waiting for approval")).toBeDefined();
    await userEvent.click(
      screen.getByRole("button", { name: /Open pending approvals/ }),
    );
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener("onecli:open-approvals-bell", opened);
    expect(
      screen.queryByRole("group", { name: /message each other/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More for Alex Kim" }),
    ).toBeNull();
  });

  it("Remove is confirm-gated and clears their one setting", async () => {
    mocks.dismissPerson.mockResolvedValue(undefined);
    renderPerson(person("approved"));
    await openRemove("Alex Kim");
    expect(screen.getByText(/^Clears their setting\./)).toBeDefined();
    expect(mocks.dismissPerson).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.dismissPerson).toHaveBeenCalledWith({ externalRef: "U1" });
  });
});

describe("ContactRow (channel)", () => {
  const space = (
    state: ChannelSpaceReach["state"],
    listen: ChannelSpaceReach["listen"] = "mentions",
  ): MergedEntry<ChannelSpaceReach> => ({
    key: "C1",
    reach: {
      provider: "slack",
      value: {
        externalRef: "C1",
        label: "#team",
        state,
        decidedAt: null,
        listen,
      },
    },
  });

  const renderChannel = (entry: MergedEntry<ChannelSpaceReach>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ContactRow
          kind="channel"
          agentId="ag-1"
          agentName="Donna"
          entry={entry}
        />
      </QueryClientProvider>,
    );

  const group = () =>
    screen.getByRole("group", { name: "Is Donna on in #team" });
  const pressed = () =>
    within(group())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("aria-label"));
  const clickIcon = (name: string) =>
    userEvent.click(within(group()).getByRole("button", { name }));
  const openMenu = () =>
    userEvent.click(
      screen.getByRole("button", { name: /^What Donna replies to in #team/ }),
    );

  it("the app-permission icons decide the channel; replies-to shows only while allowed", () => {
    const view = renderChannel(space("approved"));
    expect(
      within(group())
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Always allow", "Never"]);
    expect(pressed()).toEqual(["Always allow"]);
    expect(
      screen.getByRole("button", {
        name: "What Donna replies to in #team: Mentions. Change",
      }),
    ).toBeDefined();
    view.unmount();

    renderChannel(space("blocked"));
    expect(pressed()).toEqual(["Never"]);
    expect(
      screen.queryByRole("button", { name: /^What Donna replies to/ }),
    ).toBeNull();
  });

  it("an allowed channel listening to every message reads Every message", () => {
    renderChannel(space("approved", "all"));
    expect(
      screen.getByRole("button", {
        name: "What Donna replies to in #team: Every message. Change",
      }),
    ).toBeDefined();
  });

  it("Never drives the channel setting with THIS row's ref", async () => {
    renderChannel(space("approved"));
    await clickIcon("Never");
    expect(mocks.setSpace).toHaveBeenCalledWith({
      externalRef: "C1",
      state: "blocked",
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("re-picking the current setting is a no-op", async () => {
    renderChannel(space("blocked"));
    await clickIcon("Never");
    expect(mocks.setSpace).not.toHaveBeenCalled();
  });

  it("replies-to changes only what it hears", async () => {
    renderChannel(space("approved"));
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /^Every message/ }),
    );
    expect(mocks.setListen).toHaveBeenCalledWith({
      externalRef: "C1",
      listen: "all",
    });
    expect(mocks.setSpace).not.toHaveBeenCalled();
  });

  it("a pending channel opens the bell, with no menu", () => {
    renderChannel(space("pending"));
    expect(screen.getByText("Waiting for approval")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Open pending approvals/ }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /^What Donna replies to/ }),
    ).toBeNull();
  });

  it("Remove dismisses the channel reach row, and says what it clears", async () => {
    mocks.dismissSpace.mockResolvedValue(undefined);
    renderChannel(space("blocked"));
    await openRemove("#team");
    expect(
      screen.getByText(/^Clears what Donna replies to here\./),
    ).toBeDefined();
    expect(
      screen.getByText(
        /Donna stays in the channel\. Remove it in Slack to take it out\.$/,
      ),
    ).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.dismissSpace).toHaveBeenCalledWith({ externalRef: "C1" });
    expect(mocks.dismissPerson).not.toHaveBeenCalled();
  });
});
