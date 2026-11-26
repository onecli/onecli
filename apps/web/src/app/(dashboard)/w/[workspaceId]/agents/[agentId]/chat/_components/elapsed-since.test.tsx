// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElapsedSince, formatElapsed } from "./elapsed-since";

describe("formatElapsed", () => {
  it("shows seconds, then minutes and padded seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
  });

  it("never goes negative when the server clock runs ahead", () => {
    expect(formatElapsed(-4_000)).toBe("0s");
  });
});

describe("ElapsedSince", () => {
  afterEach(() => vi.useRealTimers());

  it("ticks once a second and stops when unmounted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:59Z"));
    const { unmount } = render(<ElapsedSince since="2026-09-29T12:00:00Z" />);
    expect(screen.getByText("59s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("1m 00s")).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
