// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectUpdated } from "./connect-updated";

/** "Access updated" closes itself, and keeps a Close button for when the
 * browser refuses (a window it didn't open as a popup). */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ConnectUpdated", () => {
  it("counts down, tries to close, and keeps a working Close button", () => {
    vi.useFakeTimers();
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    render(<ConnectUpdated appName="GitHub" />);
    expect(screen.getByText("GitHub access updated")).toBeInTheDocument();
    expect(
      screen.getByText("This window will close in 3s"),
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3000));
    expect(close).toHaveBeenCalledTimes(1);
    // Still here (the close was refused): say so, and offer the button.
    expect(
      screen.getByText("You can close this window and return to OneCLI."),
    ).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Close" }).click());
    expect(close).toHaveBeenCalledTimes(2);
  });
});
