// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCK_PREFS,
  DOCK_CARD_MIN_WIDTH,
  useCardFits,
  useDesktopDockPrefs,
} from "./use-desktop-dock-prefs";

const matchMedia = (matches: boolean) => {
  const listeners = new Set<() => void>();
  const mq = {
    matches,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => mq),
  });
  return {
    flip(next: boolean) {
      mq.matches = next;
      act(() => listeners.forEach((l) => l()));
    },
  };
};

beforeEach(() => {
  window.localStorage.clear();
  matchMedia(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDesktopDockPrefs", () => {
  it("defaults to the minimized chip with the chat column off, per agent", () => {
    const { result } = renderHook(() => useDesktopDockPrefs("a1"));
    expect(result.current.prefs).toEqual(DEFAULT_DOCK_PREFS);
    expect(result.current.prefs.mode).toBe("chip");
  });

  it("remembers the mode, the chat toggle and the corner, keyed by agent", () => {
    const a = renderHook(() => useDesktopDockPrefs("a1"));
    const b = renderHook(() => useDesktopDockPrefs("a2"));
    act(() => a.result.current.update({ mode: "card" }));
    expect(a.result.current.prefs.mode).toBe("card");
    expect(b.result.current.prefs.mode).toBe("chip");
    act(() => a.result.current.update({ chat: true, corner: "top-left" }));
    const expected = { mode: "card", chat: true, corner: "top-left" };
    expect(a.result.current.prefs).toEqual(expected);
    expect(b.result.current.prefs.corner).toBe("bottom-right");
    // A fresh mount reads the stored value.
    const again = renderHook(() => useDesktopDockPrefs("a1"));
    expect(again.result.current.prefs).toEqual(expected);
  });

  it("treats junk in storage as the default", () => {
    window.localStorage.setItem("onecli:desktop-dock:a1", "{not json");
    const { result } = renderHook(() => useDesktopDockPrefs("a1"));
    expect(result.current.prefs).toEqual(DEFAULT_DOCK_PREFS);
    window.localStorage.setItem(
      "onecli:desktop-dock:a1",
      JSON.stringify({ mode: "sideways", chat: "yes", corner: "middle" }),
    );
    const next = renderHook(() => useDesktopDockPrefs("a1"));
    expect(next.result.current.prefs).toEqual(DEFAULT_DOCK_PREFS);
  });

  it("starts minimized at any width and preserves an explicit card choice", () => {
    for (const wide of [true, false]) {
      matchMedia(wide);
      const id = wide ? "wide" : "medium";
      const { result } = renderHook(() => useDesktopDockPrefs(id));
      expect(result.current.prefs.mode).toBe("chip");
      act(() => result.current.update({ mode: "card" }));
      expect(result.current.prefs.mode).toBe("card");
    }
  });

  it("keeps preferences in memory when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
    const { result } = renderHook(() => useDesktopDockPrefs("storage-blocked"));
    act(() => result.current.update({ mode: "card" }));
    act(() => result.current.update({ chat: true }));
    const expected = { ...DEFAULT_DOCK_PREFS, mode: "card", chat: true };
    expect(result.current.prefs).toEqual(expected);
    const again = renderHook(() => useDesktopDockPrefs("storage-blocked"));
    expect(again.result.current.prefs).toEqual(expected);
  });

  it("follows a change made in another tab", () => {
    const { result } = renderHook(() => useDesktopDockPrefs("a1"));
    window.localStorage.setItem(
      "onecli:desktop-dock:a1",
      JSON.stringify({ mode: "card", chat: false }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "onecli:desktop-dock:a1" }),
      );
    });
    expect(result.current.prefs.mode).toBe("card");
  });
});

describe("useCardFits", () => {
  it("is the live media query against the card's minimum width", () => {
    const mq = matchMedia(true);
    const { result } = renderHook(() => useCardFits());
    expect(window.matchMedia).toHaveBeenCalledWith(
      `(min-width: ${DOCK_CARD_MIN_WIDTH}px)`,
    );
    expect(result.current).toBe(true);
    mq.flip(false);
    expect(result.current).toBe(false);
  });
});
