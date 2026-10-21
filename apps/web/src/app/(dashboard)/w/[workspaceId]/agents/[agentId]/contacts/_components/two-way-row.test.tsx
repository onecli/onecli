// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentContact,
  ChannelPersonReach,
  ChannelSpaceReach,
} from "@/lib/api";
import type { MergedEntry } from "./merge-contacts";

/**
 * The two-way row: ONE person or channel, both directions labeled. The
 * acceptance behaviors: each half says which direction it is about (by
 * its accessible question, not a bare badge word), each half drives its
 * OWN existing mutation with this row's id, a missing half claims no
 * setting the server does not hold, pending points at the bell, and
 * Remove is confirm-gated, clears whichever halves exist, and says which.
 */

const mocks = vi.hoisted(() => ({
  setPerson: vi.fn(),
  setSpace:
    vi.fn<(input: unknown, options: { onSuccess: () => void }) => void>(),
  setListen:
    vi.fn<(input: unknown, options: { onSuccess: () => void }) => void>(),
  setContact: vi.fn(),
  dismissPerson: vi.fn(),
  dismissSpace: vi.fn(),
  deleteContact: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

vi.mock("@/hooks/use-channels", () => ({
  useSetPersonReachState: () => ({ mutate: mocks.setPerson, isPending: false }),
  useSetReachState: () => ({ mutate: mocks.setSpace, isPending: false }),
  useSetSpaceListen: () => ({ mutate: mocks.setListen, isPending: false }),
  useSetContactPolicy: () => ({
    mutate: mocks.setContact,
    isPending: false,
    variables: undefined,
  }),
  useDismissPersonReach: () => ({ mutateAsync: mocks.dismissPerson }),
  useDismissReachRow: () => ({ mutateAsync: mocks.dismissSpace }),
  useDeleteContact: () => ({ mutateAsync: mocks.deleteContact }),
}));

import { TwoWayRow } from "./two-way-row";

const reach = (
  state: ChannelPersonReach["state"],
): { provider: "slack"; value: ChannelPersonReach } => ({
  provider: "slack",
  value: { externalRef: "U1", label: "@alexk", state, decidedAt: null },
});

const contact = (policy: AgentContact["policy"]): AgentContact => ({
  id: "c-1",
  kind: "person",
  externalRef: "U1",
  displayName: "Alex Kim",
  policy,
  updatedAt: "2026-10-01T00:00:00Z",
});

const person = (
  entry: Partial<MergedEntry<ChannelPersonReach>>,
): MergedEntry<ChannelPersonReach> => ({
  key: "U1",
  reach: null,
  contact: null,
  ...entry,
});

const renderPerson = (entry: MergedEntry<ChannelPersonReach>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TwoWayRow kind="person" agentId="ag-1" agentName="Donna" entry={entry} />
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

describe("TwoWayRow (person)", () => {
  it("one row, both directions, each named by its question", () => {
    renderPerson(
      person({ reach: reach("approved"), contact: contact("allow") }),
    );
    expect(screen.getByText("Alex Kim")).toBeDefined();
    expect(screen.getByText("@alexk")).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: /^Can Alex Kim message Donna: allowed/,
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: /^Can Donna message Alex Kim on its own: without asking/,
      }),
    ).toBeDefined();
  });

  it("the inbound half drives the reach mutation with THIS row's ref", async () => {
    renderPerson(person({ reach: reach("approved") }));
    // No outbound contact: the row is named by the Slack handle.
    await userEvent.click(
      screen.getByRole("button", { name: /^Can @alexk message Donna/ }),
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Not allowed/ }),
    );
    expect(mocks.setPerson).toHaveBeenCalledWith({
      externalRef: "U1",
      state: "blocked",
    });
    expect(mocks.setContact).not.toHaveBeenCalled();
  });

  it("the outbound half drives the contact mutation with THIS contact's id", async () => {
    renderPerson(person({ contact: contact("ask") }));
    await userEvent.click(
      screen.getByRole("button", {
        name: /^Can Donna message Alex Kim on its own/,
      }),
    );
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(
      [
        "Without askingThe agent sends on its own.",
        "Ask me firstYou approve each message.",
        "BlockNo messages, no mentions.",
      ],
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Without asking/ }),
    );
    expect(mocks.setContact).toHaveBeenCalledWith({
      contactId: "c-1",
      policy: "allow",
    });
    expect(mocks.setPerson).not.toHaveBeenCalled();
  });

  it("re-picking the current word is a no-op on either half", async () => {
    renderPerson(
      person({ reach: reach("approved"), contact: contact("blocked") }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Can Alex Kim message Donna/ }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /^Allowed/ }));
    await userEvent.click(
      screen.getByRole("button", {
        name: /^Can Donna message Alex Kim on its own/,
      }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /^Block/ }));
    expect(mocks.setPerson).not.toHaveBeenCalled();
    expect(mocks.setContact).not.toHaveBeenCalled();
  });

  it("a missing inbound half claims nothing: a workspace member keeps no record either", () => {
    renderPerson(person({ contact: contact("allow") }));
    expect(screen.getByText("No setting")).toBeDefined();
    expect(
      screen.getByText("No setting for messages from Alex Kim to Donna."),
    ).toBeDefined();
    expect(screen.queryByText(/has not messaged/)).toBeNull();
  });

  it("a missing outbound half states the real default: the next send asks", () => {
    renderPerson(person({ reach: reach("approved") }));
    expect(screen.getByText("Asks you first")).toBeDefined();
    expect(
      screen.getByText("Donna asks you before messaging @alexk."),
    ).toBeDefined();
  });

  it("pending points at the bell and offers no decide menu", () => {
    renderPerson(person({ reach: reach("pending") }));
    expect(screen.getByText("Waiting in the bell")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /^Can .* message Donna/ }),
    ).toBeNull();
    // Nothing to remove: the open ask belongs to the bell.
    expect(screen.queryByRole("button", { name: /More for/ })).toBeNull();
  });

  it("Remove next to a pending ask only clears the outbound half, and says so", async () => {
    renderPerson(
      person({ reach: reach("pending"), contact: contact("allow") }),
    );
    await openRemove("Alex Kim");
    expect(
      screen.getByText(/^Clears whether Donna can message them on its own\./),
    ).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.deleteContact).toHaveBeenCalledWith("c-1");
    expect(mocks.dismissPerson).not.toHaveBeenCalled();
  });

  it("Remove is confirm-gated and clears both halves", async () => {
    renderPerson(
      person({ reach: reach("approved"), contact: contact("allow") }),
    );
    await openRemove("Alex Kim");
    expect(mocks.dismissPerson).not.toHaveBeenCalled();
    expect(screen.getByText(/^Clears both settings\./)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.dismissPerson).toHaveBeenCalledWith({ externalRef: "U1" });
    expect(mocks.deleteContact).toHaveBeenCalledWith("c-1");
  });

  it("Remove on an inbound-only row clears that half, and says which", async () => {
    renderPerson(person({ reach: reach("blocked") }));
    await openRemove("@alexk");
    expect(
      screen.getByText(/^Clears whether they can message Donna\./),
    ).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.dismissPerson).toHaveBeenCalledWith({ externalRef: "U1" });
    expect(mocks.deleteContact).not.toHaveBeenCalled();
  });
});

describe("TwoWayRow (channel)", () => {
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
    contact: null,
  });

  const renderChannel = (entry: MergedEntry<ChannelSpaceReach>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TwoWayRow
          kind="channel"
          agentId="ag-1"
          agentName="Donna"
          entry={entry}
        />
      </QueryClientProvider>,
    );

  it("offers the three channel settlements and drives the space mutation", async () => {
    renderChannel(space("approved"));
    await userEvent.click(
      screen.getByRole("button", { name: /^Who Donna answers in #team/ }),
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /OneCLI users/ }),
    );
    expect(mocks.setSpace).toHaveBeenCalledWith({
      externalRef: "C1",
      state: "members_only",
    });
  });

  it("never lowercases the brand in the accessible name", () => {
    renderChannel(space("members_only"));
    expect(
      screen.getByRole("button", {
        name: "Who Donna answers in #team: OneCLI users only. Change",
      }),
    ).toBeDefined();
  });

  it("a change is instant and silent: the badge is the confirmation", async () => {
    renderChannel(space("approved"));
    await userEvent.click(
      screen.getByRole("button", { name: /^Who Donna answers in #team/ }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /OneCLI users/ }),
    );
    // No per-click success toast (failures still speak, from the hook).
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("a channel it only posted to says the real default: the next message there asks", () => {
    renderChannel({
      key: "C2",
      reach: null,
      contact: {
        id: "c-2",
        kind: "channel",
        externalRef: "C2",
        displayName: "#ops",
        policy: "allow",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    });
    expect(screen.getByText("Asks you first")).toBeDefined();
    expect(
      screen.getByText("Donna asks you before answering anyone in #ops."),
    ).toBeDefined();
    expect(screen.queryByText(/Not in channel/)).toBeNull();
  });

  it("Listens to: promote a channel to point of contact with THIS row's ref", async () => {
    renderChannel(space("approved"));
    await userEvent.click(
      screen.getByRole("button", {
        name: "What Donna hears in #team: Only @mentions. Change",
      }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", {
        name: /Every message \(point of contact\)/,
      }),
    );
    expect(mocks.setListen).toHaveBeenCalledWith({
      externalRef: "C1",
      listen: "all",
    });
  });

  it("a promoted channel shows the Point of contact badge", () => {
    renderChannel(space("members_only", "all"));
    expect(screen.getByText("Point of contact")).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: /^What Donna hears in #team: Every message/,
      }),
    ).toBeDefined();
  });

  it("can't promote a channel that answers no one: no menu, just the reason", () => {
    for (const state of ["blocked", "pending"] as const) {
      const view = renderChannel(space(state));
      expect(
        screen.queryByRole("button", { name: /^What Donna hears in #team/ }),
      ).toBeNull();
      expect(screen.getByText("Mentions")).toBeDefined();
      view.unmount();
    }
    expect(mocks.setListen).not.toHaveBeenCalled();
  });

  it("Remove dismisses the channel reach row, and says which half", async () => {
    renderChannel(space("blocked"));
    await openRemove("#team");
    expect(screen.getByText(/^Clears who Donna answers here\./)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.dismissSpace).toHaveBeenCalledWith({ externalRef: "C1" });
    expect(mocks.dismissPerson).not.toHaveBeenCalled();
  });
});
