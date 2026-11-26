// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREEN_EXIT_MS, useScreenExit } from "./use-screen-exit";

const reducedMotion = (reduce: boolean) =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reduce }) as MediaQueryList),
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useScreenExit", () => {
  it("fades first, then moves on once the fade ends", () => {
    reducedMotion(false);
    const next = vi.fn();
    const { result } = renderHook(() => useScreenExit());

    act(() => result.current.leave(next));
    expect(result.current.leaving).toBe(true);
    expect(next).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(SCREEN_EXIT_MS));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("moves on at once for people who prefer reduced motion", () => {
    reducedMotion(true);
    const next = vi.fn();
    const { result } = renderHook(() => useScreenExit());

    act(() => result.current.leave(next));
    act(() => vi.advanceTimersByTime(0));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("ignores a second click while leaving: one navigation, not two", () => {
    reducedMotion(false);
    const next = vi.fn();
    const { result } = renderHook(() => useScreenExit());

    act(() => {
      result.current.leave(next);
      result.current.leave(next);
    });
    act(() => vi.advanceTimersByTime(SCREEN_EXIT_MS));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never moves on after the screen has unmounted", () => {
    reducedMotion(false);
    const next = vi.fn();
    const { result, unmount } = renderHook(() => useScreenExit());

    act(() => result.current.leave(next));
    unmount();
    act(() => vi.advanceTimersByTime(SCREEN_EXIT_MS));
    expect(next).not.toHaveBeenCalled();
  });
});
