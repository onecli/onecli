// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSpaceReach } from "@/lib/api";

/**
 * The space-reach row - the dashboard face the owner actually clicks. The
 * acceptance behaviors: each state renders its honest badge (naming says
 * WHICH membership: OneCLI users vs anyone in the Slack channel), the menu
 * offers all three exclusive settlements, choosing one drives the real
 * mutation with the row's own externalRef and chosen state, and DISMISS is
 * confirm-gated (destructive-shaped) before it fires.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  dismiss: vi.fn(),
  isPending: false,
}));

vi.mock("@/hooks/use-channels", () => ({
  useSetReachState: () => ({
    mutate: mocks.mutate,
    isPending: mocks.isPending,
  }),
  useDismissReachRow: () => ({
    mutate: mocks.dismiss,
    isPending: false,
  }),
}));

import { SpaceReachRow } from "./space-reach-row";

const renderRow = (space: ChannelSpaceReach) => {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <SpaceReachRow agentId="ag-1" provider="slack" space={space} />
    </QueryClientProvider>,
  );
};

const space = (state: ChannelSpaceReach["state"]): ChannelSpaceReach => ({
  externalRef: "C123",
  label: "#proj-x",
  state,
  decidedAt: null,
});

/** Open the settlement menu. The badge IS the trigger, and its accessible
 * name is the full "who is answered here / change" sentence - matching on
 * that (not on the visible badge word) is what a screen reader user hears
 * and keeps this stable across the state being shown. */
const openMenu = async () =>
  userEvent.click(
    screen.getByRole("button", { name: /Who #proj-x is answered for/ }),
  );

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.dismiss.mockReset();
  mocks.isPending = false;
});

describe("SpaceReachRow", () => {
  it("members_only: the badge names WHICH membership is meant", () => {
    renderRow(space("members_only"));
    expect(screen.getByText("#proj-x")).toBeDefined();
    expect(screen.getByText("OneCLI users")).toBeDefined();
  });

  it("pending: the amber Asked, pending badge while the owner card is out", () => {
    renderRow(space("pending"));
    expect(screen.getByText("Asked, pending")).toBeDefined();
  });

  it("approved: Anyone here badge", () => {
    renderRow(space("approved"));
    expect(screen.getByText("Anyone here")).toBeDefined();
  });

  it("blocked: the row says the agent answers no one here", () => {
    renderRow(space("blocked"));
    expect(screen.getByText("Not allowed")).toBeDefined();
  });

  it("offers all three exclusive settlements, whatever the current state", async () => {
    renderRow(space("pending"));
    await openMenu();
    expect(
      screen.getByRole("menuitem", { name: /Allow anyone here/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /OneCLI users only/ }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Don’t allow/ })).toBeDefined();
  });

  it("choosing 'anyone here' opens THIS channel", async () => {
    renderRow(space("members_only"));
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Allow anyone here/ }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      { externalRef: "C123", state: "approved" },
      expect.anything(),
    );
  });

  it("choosing 'OneCLI users only' closes an open channel", async () => {
    renderRow(space("approved"));
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /OneCLI users only/ }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      { externalRef: "C123", state: "members_only" },
      expect.anything(),
    );
  });

  it("choosing 'Don't allow' blocks the channel entirely", async () => {
    renderRow(space("pending"));
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Don’t allow/ }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      { externalRef: "C123", state: "blocked" },
      expect.anything(),
    );
  });

  it("re-picking the state already in force is a no-op, not a write", async () => {
    renderRow(space("approved"));
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Allow anyone here/ }),
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("falls back to the raw channel id when no label is known", () => {
    renderRow({ ...space("members_only"), label: null });
    expect(screen.getByText("C123")).toBeDefined();
  });

  it("disables the control while the mutation is in flight", () => {
    mocks.isPending = true;
    renderRow(space("approved"));
    const trigger = screen.getByRole("button", {
      name: /Who #proj-x is answered for/,
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);
  });

  it("dismiss is confirm-gated: the X opens the dialog, only Remove fires the delete", async () => {
    renderRow(space("approved"));
    await userEvent.click(
      screen.getByRole("button", { name: "Remove #proj-x from this list" }),
    );
    // The dialog is up, nothing fired yet.
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(
      screen.getByText(/forgets the channel/i, { exact: false }),
    ).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.dismiss).toHaveBeenCalledWith(
      { externalRef: "C123" },
      expect.anything(),
    );
  });

  it("cancel closes the dialog without firing", async () => {
    renderRow(space("members_only"));
    await userEvent.click(
      screen.getByRole("button", { name: "Remove #proj-x from this list" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it("dismiss is offered on EVERY state - approved included (the user's rule)", () => {
    for (const state of [
      "members_only",
      "pending",
      "approved",
      "blocked",
    ] as const) {
      const { unmount } = renderRow(space(state));
      expect(
        screen.getByRole("button", { name: "Remove #proj-x from this list" }),
      ).toBeDefined();
      unmount();
    }
  });
});
