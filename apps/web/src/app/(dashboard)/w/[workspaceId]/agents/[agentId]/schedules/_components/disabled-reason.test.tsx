// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@onecli/ui/components/tooltip";
import { DisabledReason } from "./disabled-reason";

/** A button that turns on and off under the wrapper, as Run now does. */
const Harness = () => {
  const [ready, setReady] = useState(false);
  return (
    <TooltipProvider delayDuration={0}>
      <DisabledReason reason={ready ? null : "Fill in the name first."}>
        <button type="button" disabled={!ready}>
          Run now
        </button>
      </DisabledReason>
      <button type="button" onClick={() => setReady((r) => !r)}>
        Toggle
      </button>
    </TooltipProvider>
  );
};

afterEach(() => cleanup());

describe("DisabledReason", () => {
  it("says why on hover while disabled, keeps the same button, and never switches tooltip mode", async () => {
    // Radix warns (console.warn) when a tooltip switches control mode.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole("button", { name: "Run now" });
    expect(button).toBeDisabled();

    await user.hover(button.parentElement as HTMLElement);
    expect(
      await screen.findByRole("tooltip", { name: "Fill in the name first." }),
    ).toBeInTheDocument();
    await user.unhover(button.parentElement as HTMLElement);

    await user.click(screen.getByRole("button", { name: "Toggle" }));
    // The same element, enabled: never remounted.
    expect(screen.getByRole("button", { name: "Run now" })).toBe(button);
    expect(button).toBeEnabled();
    await user.hover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    expect(
      warn.mock.calls.some((args) => String(args[0]).includes("controlled")),
    ).toBe(false);
    warn.mockRestore();
  });
});
