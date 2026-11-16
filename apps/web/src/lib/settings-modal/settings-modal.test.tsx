// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

// ── The Settings modal frame: every way out, and how it leaves ──────────────
//
// The stage fills the screen to centre the card, so a click on the dimmed
// area lands on the stage, not on Radix's overlay; the frame closes on it
// itself. A close plays the card's fade first and only then drops
// `?settings=` (which unmounts the frame), so the fade is never cut off.

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/ag-1/chat",
  useRouter: () => nav,
  useSearchParams: () => new URLSearchParams("settings=apps&draft=hi"),
}));
vi.mock("./workspace-picker", () => ({ WorkspacePicker: () => null }));
vi.mock("./mobile-page-picker", () => ({ MobilePagePicker: () => null }));

const { SettingsModal } = await import("./settings-modal");
const { clearSettingsCarryOver } = await import("./use-switch-workspace");

const VIEWER = {
  hasWorkspace: true,
  canManageWorkspace: true,
  isAdmin: true,
  billing: false,
  hosted: false,
};

const renderModal = () =>
  render(
    <SettingsModal
      page="apps"
      viewer={VIEWER}
      organizationId="org-1"
      workspaceId="ws-1"
      workspaces={[{ id: "ws-1", name: "One" }]}
    >
      <p>Apps body</p>
    </SettingsModal>,
  );

const stage = () =>
  document.querySelector<HTMLElement>('[data-slot="settings-modal"]');
const card = () =>
  document.querySelector<HTMLElement>('[data-slot="settings-modal-card"]');

/** The URL the frame went to once its close fade played. */
const closedTo = () => {
  act(() => {
    vi.advanceTimersByTime(200);
  });
  return nav.push.mock.calls.at(-1)?.[0];
};

beforeEach(() => {
  vi.useFakeTimers();
  nav.push.mockClear();
  clearSettingsCarryOver();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SettingsModal closing", () => {
  it("closes on a press on the dimmed area around the card", () => {
    renderModal();
    fireEvent.pointerDown(stage()!, { button: 0 });
    expect(closedTo()).toBe("/w/ws-1/agents/ag-1/chat?draft=hi");
  });

  it("stays open on a press inside the card", () => {
    renderModal();
    fireEvent.pointerDown(screen.getByText("Apps body"), { button: 0 });
    expect(closedTo()).toBeUndefined();
    expect(card()).not.toBeNull();
  });

  it("closes on Escape and on the X, the same way", () => {
    renderModal();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(closedTo()).toBe("/w/ws-1/agents/ag-1/chat?draft=hi");

    cleanup();
    nav.push.mockClear();
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(closedTo()).toBe("/w/ws-1/agents/ag-1/chat?draft=hi");
  });

  // The fade plays before the URL changes: the slot unmounts the frame when
  // `?settings=` goes, which used to cut the fade off a frame or two in.
  // (Radix holds the closed frame on screen for its exit animation in a
  // browser; jsdom has no animations, so only the URL's timing is checked.)
  it("drops ?settings= only after the close fade has played", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(nav.push).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(nav.push).toHaveBeenCalledTimes(1);
  });

  // Radix holds a finished exit animation's end frame only until a 0ms
  // timer after `animationend`; the URL drops `?settings=` after the fade's
  // own timer. Without `forwards` the stage and the scrim repainted at full
  // opacity for a frame in between: measured live, 4 of 60 closes flashed,
  // 0 of 120 with it. jsdom runs no animations, so the class is what holds.
  it("holds the faded-out stage and scrim until the slot unmounts", () => {
    renderModal();
    expect(stage()?.className).toContain("fill-mode-forwards");
    expect(
      document.querySelector('[data-slot="dialog-overlay"]')?.className,
    ).toContain("fill-mode-forwards");
  });

  it("keeps the top bar's row clear of the close button", () => {
    renderModal();
    // The X sits 16px in and is 32px wide: on a narrow modal the centred
    // row must still end 24px from the edge, or the picker runs under it.
    // jsdom has no layout, so the class that holds the margin is pinned.
    const row = document.querySelector('[data-slot="settings-modal-topbar"]');
    expect(row?.className).toContain("mr-[max(1.5rem,");
    expect(row?.className).not.toContain("mx-auto");
  });

  it("navigates once, however many ways out are taken", () => {
    renderModal();
    const x = screen.getByRole("button", { name: "Close settings" });
    const back = screen.getByRole("button", { name: /Back to app/ });
    // Two ways out in one tick, before the frame re-renders as closing.
    act(() => {
      x.click();
      back.click();
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(nav.push).toHaveBeenCalledTimes(1);
  });
});
