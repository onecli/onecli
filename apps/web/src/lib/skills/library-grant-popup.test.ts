// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIBRARY_GRANT_MESSAGE,
  openLibraryGrantPopup,
} from "./library-grant-popup";

/** "Install GitHub for skills only" trusts exactly one message: the grant
 * its own popup posts, from this origin. */

const openPopup = () => {
  const popup = { location: { href: "" } };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  return popup as unknown as Window & { location: { href: string } };
};

const post = (init: MessageEventInit) =>
  window.dispatchEvent(new MessageEvent("message", init));

afterEach(() => vi.restoreAllMocks());

describe("openLibraryGrantPopup", () => {
  it("points the popup at the org authorize door with purpose=skills", async () => {
    const popup = openPopup();
    const stop = openLibraryGrantPopup("org-1", () => {});
    await vi.waitFor(() =>
      expect(popup.location.href).toContain(
        "/v1/apps/github-app/authorize?purpose=skills&_org=org-1",
      ),
    );
    stop?.();
  });

  it("ignores a message from another origin, even from the popup", () => {
    const popup = openPopup();
    const onGrant = vi.fn();
    const stop = openLibraryGrantPopup("org-1", onGrant);
    post({
      origin: "https://evil.example",
      source: popup,
      data: { type: LIBRARY_GRANT_MESSAGE, grant: "forged" },
    });
    expect(onGrant).not.toHaveBeenCalled();
    stop?.();
  });

  it("ignores a same-origin message from any other window", () => {
    openPopup();
    const onGrant = vi.fn();
    const stop = openLibraryGrantPopup("org-1", onGrant);
    post({
      origin: window.location.origin,
      source: window,
      data: { type: LIBRARY_GRANT_MESSAGE, grant: "forged" },
    });
    expect(onGrant).not.toHaveBeenCalled();
    stop?.();
  });

  it("ignores the popup's other messages and malformed grants", () => {
    const popup = openPopup();
    const onGrant = vi.fn();
    const stop = openLibraryGrantPopup("org-1", onGrant);
    const from = { origin: window.location.origin, source: popup };
    post({ ...from, data: { type: "app-connected", grant: "x" } });
    post({ ...from, data: { type: LIBRARY_GRANT_MESSAGE, grant: 42 } });
    post({ ...from, data: null });
    expect(onGrant).not.toHaveBeenCalled();
    stop?.();
  });

  it("takes the popup's grant once, then stops listening", () => {
    const popup = openPopup();
    const onGrant = vi.fn();
    openLibraryGrantPopup("org-1", onGrant);
    const message = {
      origin: window.location.origin,
      source: popup,
      data: { type: LIBRARY_GRANT_MESSAGE, grant: "signed.grant" },
    };
    post(message);
    post(message);
    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(onGrant).toHaveBeenCalledWith("signed.grant");
  });

  it("the cleanup stops listening", () => {
    const popup = openPopup();
    const onGrant = vi.fn();
    const stop = openLibraryGrantPopup("org-1", onGrant);
    stop?.();
    post({
      origin: window.location.origin,
      source: popup,
      data: { type: LIBRARY_GRANT_MESSAGE, grant: "signed.grant" },
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("never opens a window for no org, and a blocked popup returns null", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openLibraryGrantPopup("", () => {})).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(openLibraryGrantPopup("org-1", () => {})).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
