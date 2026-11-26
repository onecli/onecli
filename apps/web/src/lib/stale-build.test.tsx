// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster, toast } from "sonner";
// The class Next itself throws when the server doesn't know an action id. No
// public export exists, so the test reaches into dist: that keeps the real
// `unstable_isUnrecognizedActionError` check under test instead of a mock.
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { notifyIfStaleBuild } from "./stale-build";

const staleBuildError = () =>
  new UnrecognizedActionError('Server Action "00ab" was not found');

const notify = (error: unknown) => act(() => notifyIfStaleBuild(error));

// Sonner captures the pointer on press (its swipe-to-dismiss); jsdom lacks it.
beforeAll(() => {
  Element.prototype.setPointerCapture = () => {};
});

describe("notifyIfStaleBuild", () => {
  afterEach(() => {
    act(() => toast.dismiss());
    vi.unstubAllGlobals();
  });

  it("shows ONE notice however many calls fail, and reloads only on the button", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<Toaster />);

    // A window refocus refetches every mounted query at once.
    notify(staleBuildError());
    notify(staleBuildError());
    notify(staleBuildError());

    expect(
      await screen.findAllByText("A new version of OneCLI is available."),
    ).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores every other error (API refusals, network failures)", async () => {
    render(<Toaster />);

    notify(new Error("Request failed: 500"));
    notify(new TypeError("Failed to fetch"));

    // Sonner mounts a toast on the next frame: give it the chance to appear.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(
      screen.queryByText("A new version of OneCLI is available."),
    ).toBeNull();
  });
});
