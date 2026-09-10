// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── The "this link cannot be redeemed" screen ───────────────────────────────
//
// Two things are pinned. Every reason has its own words (the whole point of
// the screen is to replace a redirect that said nothing). And the one case
// that is not a dead end — a USED link seen signed out, most often its own
// accepter on a new device — offers a sign-in that comes BACK here, so the
// re-click redirect can take them into the organization. Every other case
// signs in (or goes to the dashboard) plainly: coming back would only show
// this screen again.

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));

import { JoinUnavailable } from "./join-unavailable";

const callbackUrl = "/join?token=tok-1";

beforeEach(() => {
  push.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("JoinUnavailable", () => {
  it.each([
    ["expired", /has expired/i],
    ["accepted", /already used/i],
    ["cancelled", /was cancelled/i],
    ["unknown", /isn't valid/i],
  ] as const)("%s: says so in its own words", (reason, title) => {
    render(
      <JoinUnavailable
        reason={reason}
        signedIn={false}
        callbackUrl={callbackUrl}
      />,
    );
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("used link, signed out: sign-in parks this link to come back to", async () => {
    render(
      <JoinUnavailable
        reason="accepted"
        signedIn={false}
        callbackUrl={callbackUrl}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(localStorage.getItem("inviteCallbackUrl")).toBe(callbackUrl);
    expect(push).toHaveBeenCalledWith("/auth/login");
  });

  it.each(["expired", "cancelled", "unknown"] as const)(
    "%s, signed out: a plain sign-in link, nothing parked",
    (reason) => {
      render(
        <JoinUnavailable
          reason={reason}
          signedIn={false}
          callbackUrl={callbackUrl}
        />,
      );

      expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
        "href",
        "/auth/login",
      );
      expect(screen.queryByRole("button")).toBeNull();
      expect(localStorage.getItem("inviteCallbackUrl")).toBeNull();
    },
  );

  it("used link, signed in: to the dashboard — the page already ruled out the accepter", () => {
    render(
      <JoinUnavailable reason="accepted" signedIn callbackUrl={callbackUrl} />,
    );

    expect(
      screen.getByRole("link", { name: "Go to dashboard" }),
    ).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
