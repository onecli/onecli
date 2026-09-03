// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPersonReach } from "@/lib/api";

/**
 * The person-reach row. Acceptance behaviors: each state renders its honest
 * badge, the menu offers exactly TWO settlements (a single human has no
 * "OneCLI users only"), choosing one drives the mutation with this row's
 * own ref, and dismiss is confirm-gated.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  dismiss: vi.fn(),
  isPending: false,
}));

vi.mock("@/hooks/use-channels", () => ({
  useSetPersonReachState: () => ({
    mutate: mocks.mutate,
    isPending: mocks.isPending,
  }),
  useDismissPersonReach: () => ({ mutate: mocks.dismiss, isPending: false }),
}));

import { PersonReachRow } from "./person-reach-row";

const renderRow = (person: ChannelPersonReach) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PersonReachRow agentId="ag-1" provider="slack" person={person} />
    </QueryClientProvider>,
  );

const person = (state: ChannelPersonReach["state"]): ChannelPersonReach => ({
  externalRef: "U123",
  label: "@dana",
  state,
  decidedAt: null,
});

const openMenu = () =>
  userEvent.click(
    screen.getByRole("button", { name: /Whether @dana can message/ }),
  );

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.dismiss.mockReset();
  mocks.isPending = false;
});

describe("PersonReachRow", () => {
  it("pending: the amber waiting badge while the owner's card is out", () => {
    renderRow(person("pending"));
    expect(screen.getByText("@dana")).toBeDefined();
    expect(screen.getByText("Asked, pending")).toBeDefined();
  });

  it("approved: reads as allowed", () => {
    renderRow(person("approved"));
    expect(screen.getByText("Allowed")).toBeDefined();
  });

  it("blocked: reads as not allowed", () => {
    renderRow(person("blocked"));
    expect(screen.getByText("Not allowed")).toBeDefined();
  });

  it("offers exactly TWO settlements - a person has no 'OneCLI users only'", async () => {
    renderRow(person("pending"));
    await openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(
      screen.getByRole("menuitem", { name: /Allow this person/ }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Don’t allow/ })).toBeDefined();
    expect(screen.queryByText(/OneCLI users only/)).toBeNull();
  });

  it("allowing drives the mutation with THIS row's ref", async () => {
    renderRow(person("pending"));
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Allow this person/ }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      { externalRef: "U123", state: "approved" },
      expect.anything(),
    );
  });

  it("blocking says it also covers open channels - the precedence law, stated where it is chosen", async () => {
    renderRow(person("approved"));
    await openMenu();
    expect(screen.getByText(/here and in any open channel/)).toBeDefined();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Don’t allow/ }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      { externalRef: "U123", state: "blocked" },
      expect.anything(),
    );
  });

  it("re-picking the current state is a no-op, not a write", async () => {
    renderRow(person("approved"));
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Allow this person/ }),
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("falls back to the raw user id when no label is known", () => {
    renderRow({ ...person("pending"), label: null });
    expect(screen.getByText("U123")).toBeDefined();
  });

  it("dismiss is confirm-gated: only Remove fires the delete", async () => {
    renderRow(person("approved"));
    await userEvent.click(
      screen.getByRole("button", { name: "Remove @dana from this list" }),
    );
    expect(mocks.dismiss).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.dismiss).toHaveBeenCalledWith(
      { externalRef: "U123" },
      expect.anything(),
    );
  });

  it("disables the control while the mutation is in flight", () => {
    mocks.isPending = true;
    renderRow(person("approved"));
    expect(
      screen
        .getByRole("button", { name: /Whether @dana can message/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
