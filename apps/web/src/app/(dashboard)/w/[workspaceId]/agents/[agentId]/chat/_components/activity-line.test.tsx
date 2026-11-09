// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLine, CAPTION_HOLD_MS } from "./activity-line";

/**
 * The status line under a working turn. Its job is to be READABLE: a new
 * whole thought every few hundred milliseconds would flicker past, so each
 * caption holds long enough to read, and only the latest waiting one lands.
 */
describe("ActivityLine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the first caption at once", () => {
    render(<ActivityLine text="Thinking…" />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("holds a caption long enough to read, then shows only the latest", () => {
    const { rerender } = render(<ActivityLine text="Reading the logs" />);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    rerender(<ActivityLine text="Checking the config" />);
    // First change after mount: shown at once.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Checking the config")).toBeInTheDocument();

    // Two more thoughts arrive within the hold: neither shows yet…
    rerender(<ActivityLine text="Comparing the two runs" />);
    rerender(<ActivityLine text="Writing the summary" />);
    act(() => {
      vi.advanceTimersByTime(CAPTION_HOLD_MS - 100);
    });
    expect(screen.getByText("Checking the config")).toBeInTheDocument();
    // …and when the hold ends, the LATEST lands, the skipped one never does.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("Writing the summary")).toBeInTheDocument();
    expect(screen.queryByText("Comparing the two runs")).toBeNull();
  });

  it("is plain text: no italic, no pulsing dot, model text never parsed", () => {
    const { container } = render(
      <ActivityLine text="**Planning** <b>it</b>" />,
    );
    expect(screen.getByText("**Planning** <b>it</b>")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector(".italic")).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});
