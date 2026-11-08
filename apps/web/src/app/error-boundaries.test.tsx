// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalError from "./global-error";
import DashboardError from "./(dashboard)/error";

const FLAG = "chunk-error-reloaded";

const chunkError = (): Error => {
  const error = new Error("Loading chunk 123 failed.");
  error.name = "ChunkLoadError";
  return error;
};

// Both boundaries run the same post-deploy recovery: one automatic reload
// for a stale chunk, guarded by a session flag so it can never loop.
describe.each([
  ["GlobalError", GlobalError],
  ["DashboardError", DashboardError],
])("%s", (_name, Boundary) => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    // GlobalError renders its own <html>; React warns when that lands in a
    // test container. The warning is about the harness, not the boundary.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reloads once for a ChunkLoadError and sets the flag", () => {
    render(<Boundary error={chunkError()} reset={vi.fn()} />);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG)).toBe("1");
  });

  it("recognizes a ChunkLoadError named only in the message", () => {
    render(
      <Boundary
        error={new Error("ChunkLoadError: Loading chunk 9 failed.")}
        reset={vi.fn()}
      />,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG)).toBe("1");
  });

  it("does not reload a second time, and clears the flag for the next deploy", () => {
    sessionStorage.setItem(FLAG, "1");
    render(<Boundary error={chunkError()} reset={vi.fn()} />);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FLAG)).toBeNull();
  });

  it("leaves every other error alone, flag included", () => {
    sessionStorage.setItem(FLAG, "1");
    render(<Boundary error={new Error("boom")} reset={vi.fn()} />);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FLAG)).toBe("1");
  });

  it("tolerates an error without a message", () => {
    const error = new Error();
    (error as { message?: string }).message = undefined;
    render(<Boundary error={error} reset={vi.fn()} />);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("re-runs only when the error changes", () => {
    const error = chunkError();
    const { rerender } = render(<Boundary error={error} reset={vi.fn()} />);
    rerender(<Boundary error={error} reset={vi.fn()} />);
    expect(sessionStorage.getItem(FLAG)).toBe("1");

    // A new error is a new render of the boundary: the flag is already set,
    // so this pass clears it instead of reloading again.
    rerender(<Boundary error={chunkError()} reset={vi.fn()} />);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG)).toBeNull();
  });

  it("Try again clears the flag and resets the boundary", async () => {
    sessionStorage.setItem(FLAG, "1");
    const reset = vi.fn();
    render(<Boundary error={new Error("boom")} reset={reset} />);

    expect(
      screen.getByText(
        "A new version may have been deployed. Try refreshing the page.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG)).toBeNull();
  });
});
