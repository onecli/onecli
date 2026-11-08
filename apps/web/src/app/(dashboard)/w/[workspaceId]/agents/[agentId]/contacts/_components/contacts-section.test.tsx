// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActAsYouSlot } from "./act-as-you-slot";

/**
 * Contacts is ONE list. Entitled, the licensed "acts as you" layer wraps it
 * and hands it a slot; unentitled, the plain list renders with nothing
 * added. A legacy `?as=you` is ignored either way.
 */

const state = vi.hoisted(() => ({
  entitled: true as boolean | undefined,
}));

const slot: ActAsYouSlot = {
  columns: true,
  header: <div data-testid="as-you-header" />,
  forRow: () => null,
  standaloneRows: () => [],
};

vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({ children }: { children: (s: ActAsYouSlot) => React.ReactNode }) => (
      <div data-testid="act-as-you">{children(slot)}</div>
    ),
}));
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () =>
    state.entitled === undefined ? null : { entitled: state.entitled },
}));
vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "Donna" }),
}));
vi.mock("./contacts-list", () => ({
  ContactsList: ({ actAsYou }: { actAsYou?: ActAsYouSlot }) => (
    <div data-testid="list">{actAsYou?.header}</div>
  ),
}));

const { ContactsSection } = await import("./contacts-section");

describe("ContactsSection", () => {
  beforeEach(() => {
    state.entitled = true;
  });

  it("entitled: one list, wrapped by the acts-as-you layer", () => {
    render(<ContactsSection />);
    expect(screen.getByTestId("act-as-you")).toBeTruthy();
    expect(screen.getByTestId("list")).toBeTruthy();
    expect(screen.getByTestId("as-you-header")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /acts as/ })).toBeNull();
  });

  it.each([false, undefined])(
    "unentitled (%s): the plain list, nothing licensed",
    (entitled) => {
      state.entitled = entitled;
      render(<ContactsSection />);
      expect(screen.getByTestId("list")).toBeTruthy();
      expect(screen.queryByTestId("act-as-you")).toBeNull();
      expect(screen.queryByTestId("as-you-header")).toBeNull();
    },
  );
});
