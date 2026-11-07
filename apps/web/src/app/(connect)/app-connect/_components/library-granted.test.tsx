// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_GRANT_MESSAGE } from "@/lib/skills/library-grant-popup";
import { LibraryGranted } from "./library-granted";

/** Where "Install GitHub for skills only" lands: the grant in the fragment
 * goes to the opener on this origin only, and never stays in the URL. */

const setOpener = (opener: unknown) =>
  Object.defineProperty(window, "opener", {
    value: opener,
    configurable: true,
    writable: true,
  });

let close: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  close = vi.spyOn(window, "close").mockImplementation(() => {});
  window.history.replaceState(
    null,
    "",
    "/app-connect/github-app?status=library",
  );
});
afterEach(() => {
  setOpener(null);
  vi.restoreAllMocks();
});

describe("LibraryGranted", () => {
  it("posts the grant to the opener on this origin, wipes the fragment, and closes", () => {
    const postMessage = vi.fn();
    setOpener({ postMessage });
    window.location.hash = "#g=signed.grant";

    render(<LibraryGranted />);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: LIBRARY_GRANT_MESSAGE, grant: "signed.grant" },
      window.location.origin,
    );
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("signed.grant");
    // The query (the landing status) stays: only the secret goes.
    expect(window.location.search).toBe("?status=library");
    expect(close).toHaveBeenCalled();
    expect(
      screen.getByText("GitHub is ready for your skills"),
    ).toBeInTheDocument();
  });

  it("with no opener, wipes the fragment and offers Close instead", async () => {
    setOpener(null);
    window.location.hash = "#g=signed.grant";

    render(<LibraryGranted />);

    expect(window.location.href).not.toContain("signed.grant");
    expect(
      screen.getByText("Couldn't hand GitHub access back"),
    ).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("with no grant in the fragment, posts nothing", () => {
    const postMessage = vi.fn();
    setOpener({ postMessage });

    render(<LibraryGranted />);

    expect(postMessage).not.toHaveBeenCalled();
    expect(
      screen.getByText("Couldn't hand GitHub access back"),
    ).toBeInTheDocument();
  });
});
